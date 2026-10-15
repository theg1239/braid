/**
 * Schemas for what Braid accepts from outside: request bodies, agent
 * submissions and model output. Each is parsed once where it arrives, so the
 * code behind it works with typed values; the first problem found is the
 * error the caller sees.
 */
import * as v from 'valibot';
import { RESERVED_OWNERS, SLUG } from '../shared/routes';
import { parseSearch } from '../shared/search-query';
import { validPath } from './workspace/domain';
import { HttpError } from './errors';
import { base64Bytes } from './http/auth';
import { blockedStrings, instructionPaths, instructionText, INSTRUCTIONS_PATH } from '../shared/instructions-file';
import type { VerifyJob } from './agents/runner';
import { activityCommand, activityRelativePath, safeActivityIdentity } from '../shared/activity-privacy';

const MEDIA_ADDRESS = 'Name the media by its https address.';
export const mediaAddress = v.pipe(v.string(MEDIA_ADDRESS), v.maxLength(8192, MEDIA_ADDRESS), v.url(MEDIA_ADDRESS),
  v.transform(value => new URL(value)),
  v.check(value => value.protocol === 'https:' && !value.username && !value.password, MEDIA_ADDRESS));

/* ---------- page cursors ---------- */

/** A page cursor: JSON in UTF-8, as base64. Clients pass it back unread, and `cursor` parses it. */
export const encodeCursor = (value: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const cursor = <S extends v.GenericSchema>(message: string, maxLength: number, schema: S) => v.pipe(
  v.string(message), v.maxLength(maxLength, message),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64Bytes(dataset.value))) as unknown; }
    catch { addIssue({ message }); return NEVER; }
  }),
  schema);
/** Pages of changes continue after the last item's update time and id, so a page stays stable while new changes keep arriving. */
export const changeCursor = (item: { updatedAt: string; id: string }) => encodeCursor({ u: item.updatedAt, i: item.id });
export const pageCursor = v.pipe(cursor('Invalid page cursor.', 1000, v.object({ u: v.string('Invalid page cursor.'), i: v.string('Invalid page cursor.') }, 'Invalid page cursor.')),
  v.transform(({ u, i }) => ({ updatedAt: u, id: i })));

const activityId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,80}$/));
export const activityChangeId = v.pipe(v.string(), v.regex(/^ch_[a-f0-9]{13}$/));
const localActivityEvent = v.strictObject({
  id: activityId,
  sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  at: v.pipe(v.string(), v.isoTimestamp()),
  source: v.picklist(['process', 'claude-hook', 'codex-notify', 'git']),
  kind: v.picklist(['started', 'working', 'editing', 'command', 'waiting', 'finished', 'failed', 'commit']),
  path: v.optional(v.pipe(v.string(), v.maxLength(240), v.transform(activityRelativePath))),
  command: v.optional(v.pipe(v.string(), v.maxLength(160), v.transform(activityCommand))),
  exitCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-1), v.maxValue(255))),
  completed: v.optional(v.boolean()),
  commit: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/))),
});
export const localActivityBatch = v.strictObject({
  session: activityId,
  model: v.optional(v.pipe(v.string(), v.maxLength(120), v.check(safeActivityIdentity))),
  tool: v.optional(v.pipe(v.string(), v.maxLength(80), v.check(safeActivityIdentity))),
  changeId: v.optional(activityChangeId),
  active: v.optional(v.boolean()),
  events: v.pipe(v.array(localActivityEvent), v.maxLength(40)),
});

export function parse<const TSchema extends v.GenericSchema>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input);
  if (!result.success) throw new HttpError(400, result.issues[0].message);
  return result.output;
}
/** Parses data from another service: a mismatch is that service's failure, reported to the caller as `error`. */
export function parseFrom<const TSchema extends v.GenericSchema>(schema: TSchema, input: unknown, error: string): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input);
  if (!result.success) throw new HttpError(502, error);
  return result.output;
}

/** A workflow receipt only proves the exact job and commands the queue asked to run. */
export function verificationResult(job: VerifyJob) {
  const command = v.pipe(v.string(), v.maxLength(400));
  return v.pipe(v.object({
    id: v.literal(job.id), commit: v.literal(job.commit), status: v.picklist(['passed', 'failed', 'error']),
    checks: v.pipe(v.array(v.object({ command, exitCode: v.pipe(v.number(), v.integer()),
      durationMs: v.pipe(v.number(), v.minValue(0)), output: v.pipe(v.string(), v.maxLength(4000)),
      truncated: v.boolean(), phase: v.picklist(['install', 'check']) })), v.maxLength(11)),
    startedAt: v.string(), finishedAt: v.string(), error: v.optional(v.pipe(v.string(), v.maxLength(300))),
    baseline: v.optional(job.baseline ? v.object({ commit: v.literal(job.baseline), failing: v.pipe(v.array(command), v.maxLength(10)) }) : v.undefined()),
  }), v.check(value => {
    const checks = value.checks.filter(check => check.phase === 'check'), install = value.checks.filter(check => check.phase === 'install');
    if (install.length > 1 || install.some(check => check.command !== job.install) || checks.some((check, index) => check.command !== job.checks[index])) return false;
    if (install.length && (value.checks[0].phase !== 'install' || (checks.length > 0 && install[0].exitCode !== 0))) return false;
    if (value.status !== 'error' && job.install && install.length !== 1) return false;
    const complete = checks.length === job.checks.length, failed = value.checks.some(check => check.exitCode !== 0);
    if (value.status === 'passed' && (!complete || failed)) return false;
    if (value.status === 'failed' && (!failed || !(complete || (checks.length === 0 && install.some(check => check.exitCode !== 0))))) return false;
    return !value.baseline || (value.status === 'failed' && value.baseline.failing.every(command => checks.some(check => check.command === command && check.exitCode !== 0 && check.exitCode !== 124)));
  }));
}

/* ---------- building blocks ---------- */

/**
 * A request body. A missing field reports that field's own message, as an
 * empty one would, rather than valibot's generic one.
 */
export function body<const TEntries extends v.ObjectEntries>(entries: TEntries, message: string) {
  return v.object(entries, issue => {
    const key = issue.received === 'undefined' ? issue.path?.[0].key : undefined;
    const entry = typeof key === 'string' && Object.hasOwn(entries, key) ? entries[key] as { message?: unknown } : undefined;
    return typeof entry?.message === 'string' ? entry.message : message;
  });
}

/** Trimmed text of 1 to `max` characters. */
export function text(label: string, max: number) {
  const message = `${label} must contain 1–${max} characters.`;
  return v.pipe(v.string(message), v.trim(), v.nonEmpty(message), v.maxLength(max, message));
}
/** Text that may be left out: missing, null and empty all mean none. */
export function optionalText(label: string, max: number) {
  return v.pipe(v.nullish(v.string(`${label} must contain 1–${max} characters.`)), v.transform(value => value || undefined), v.optional(text(label, max)));
}
const hex = (length: number, message: string) => v.pipe(v.string(message), v.regex(new RegExp(`^[a-f0-9]{${length}}$`), message));
export const commit = (message: string) => hex(40, message);
const whole = (min: number, max: number, message: string) => v.pipe(v.number(message), v.integer(message), v.minValue(min, message), v.maxValue(max, message));
/** A positive integer identifier, as GitHub uses for accounts, installations and repositories. */
export const positiveId = (message?: string) => v.pipe(v.number(message), v.safeInteger(message), v.minValue(1, message));
/** A number from a query string, such as `?page=2`; missing means `fallback`. */
export const queryNumber = (fallback: number, check: v.GenericSchema<number>) => v.pipe(v.nullable(v.string()), v.transform(value => value ? Number(value) : fallback), check);
/** The identity Cloudflare Access signs: a subject and an email, issued no later than now. */
export const cloudflareAccessClaims = v.object({
  sub: v.pipe(v.string(), v.nonEmpty()), email: v.pipe(v.string(), v.includes('@'), v.toLowerCase()),
  iat: v.pipe(v.number(), v.check(iat => iat <= Date.now() / 1000 + 5)),
});
/** An Idempotency-Key: 16 to 128 letters, digits, `-` or `_`, unique to one operation. */
export const idempotencyKey = (message?: string) => v.pipe(v.string(message), v.regex(/^[a-zA-Z0-9_-]{16,128}$/, message));
const email = v.pipe(v.string('Enter a valid email address.'), v.trim(), v.toLowerCase(), v.maxLength(254, 'Enter a valid email address.'), v.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'));

/* ---------- files ---------- */

/** Artifacts accepts blobs up to 32 MB; leave room for the Git object header. No aggregate pull request cap. */
export const LIMITS = { bytes: 32_000_000 - 1024, baseBytes: 6 * 1024 * 1024 };
const UNSAFE_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[\uD800-\uDFFF]/u;
const FILE_COUNT = 'Submit at least 1 changed file.';
const PATHS = 'Use unique repository paths outside protected paths such as .git, .braid and .env files.';

/** New contents by path, or null to delete. Paths are unique and never inside .git or .braid, or credential files. */
function fileEdits(allowed: (path: string) => boolean) {
  return v.pipe(
    v.array(v.pipe(
      v.object({
        path: v.pipe(v.string(PATHS), v.check(allowed, PATHS)),
        content: v.nullable(v.pipe(v.string('Send text content, or null to delete a file.'), v.check(content => !UNSAFE_TEXT.test(content), 'Changes contain UTF-8 text only.'))),
        mode: v.optional(v.picklist(['100644', '100755'], 'Use a regular or executable file mode.')),
      }, 'Send each file as an object with a path and content.'),
      v.check(file => !(file.mode && file.content === null), 'A deleted file has no mode.')), FILE_COUNT),
    v.minLength(1, FILE_COUNT),
    v.check(files => new Set(files.map(file => file.path)).size === files.length, PATHS));
}
/** Braid's own task results also carry the task's record under `.braid/missions/`, and its instruction changes the instructions file. */
const LEDGER = /^\.braid\/missions\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_.-]{1,80}$/;
const FILES = { agent: fileEdits(validPath), system: fileEdits(path => validPath(path) || LEDGER.test(path) || path === INSTRUCTIONS_PATH) };
export type FileEdit = v.InferOutput<typeof FILES.agent>[number];
const blobFile = (allowed: (path: string) => boolean) => v.strictObject({
  path: v.pipe(v.string(PATHS), v.check(allowed, PATHS)), blob: commit('Provide a Git blob hash from this repository.'),
  mode: v.optional(v.picklist(['100644', '100755'])),
});
const changeFiles = (system: boolean) => v.pipe(v.array(v.union([
  system ? FILES.system.item : FILES.agent.item,
  blobFile(path => validPath(path) || system && (LEDGER.test(path) || path === INSTRUCTIONS_PATH)),
]), FILE_COUNT), v.minLength(1, FILE_COUNT), v.check(files => new Set(files.map(file => file.path)).size === files.length, PATHS));
export type SubmissionFile = v.InferOutput<ReturnType<typeof changeFiles>>[number];
/** Container stdout is untrusted, including when the command exits successfully. */
export const collectedFiles = v.pipe(v.string(), v.parseJson(), FILES.agent);

/** The binding returns Error objects with a numeric prefix; no upstream text leaves this boundary. */
export function parseWorkersAiError(error: unknown): number | undefined {
  const parsed = v.safeParse(v.object({ message: v.string() }), error);
  const code = parsed.success ? /^(\d{4}):/.exec(parsed.output.message)?.[1] : undefined;
  return code ? Number(code) : undefined;
}

/** Only structured runtime fields participate in environment classification. */
export const repositoryInspection = v.object({
  manifests: v.array(v.object({ path: v.string(), data: v.optional(v.unknown()), text: v.optional(v.string()), error: v.optional(v.string()), exitCode: v.optional(v.number()) })),
  lockfiles: v.array(v.string()), instructions: v.array(v.string()), omitted: v.optional(v.number()),
});
export const preparation = v.object({
  decision: text('Environment decision', 1600), sources: v.pipe(v.array(text('Source path', 400)), v.maxLength(32)),
  setup: v.pipe(v.array(text('Setup command', 4000)), v.maxLength(16)),
  checks: v.pipe(v.array(text('Check command', 4000)), v.maxLength(16)),
  noTestsReason: v.optional(text('Reason no tests are available', 1200)),
});
export const hostedTiming = v.object({
  limitKind: v.optional(v.picklist(['command', 'task', 'model', 'transport'])),
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(0))),
  elapsedMs: v.optional(v.pipe(v.number(), v.minValue(0))),
});

export const hostedRuntimeError = v.object({
  code: v.optional(v.union([v.string(), v.number()])), exitCode: v.optional(v.pipe(v.number(), v.integer())),
  signal: v.optional(v.union([v.pipe(v.number(), v.integer()), v.literal('SIGKILL')])),
  name: v.optional(v.string()), oomKilled: v.optional(v.boolean()),
});
export const hostedProviderError = v.object({
  internalCode: v.optional(v.number()), errors: v.optional(v.array(v.object({ code: v.number() }))),
});
export const hostedProcessResult = v.object({
  stdout: v.string(), stderr: v.string(), exitCode: v.pipe(v.number(), v.integer()), truncated: v.boolean(),
  timeoutMs: v.optional(v.number()), elapsedMs: v.optional(v.number()),
  signal: v.optional(v.number()), timedOut: v.optional(v.boolean()), code: v.optional(v.string()), oomKilled: v.optional(v.boolean()),
  outputTail: v.optional(v.pipe(v.string(), v.maxLength(16000))), diskFull: v.optional(v.boolean()),
});
export const hostedCollectionFailure = v.object({ collectionFailure: v.object({
  reason: v.picklist(['empty', 'limit', 'binary', 'protected', 'credential', 'race', 'invalid', 'command']),
  exitCode: v.optional(v.pipe(v.number(), v.integer())), signal: v.optional(v.pipe(v.number(), v.integer())), code: v.optional(v.pipe(v.string(), v.maxLength(100))),
}) });
export const hostedPackage = v.object({ engines: v.optional(v.object({ node: v.optional(v.string()) })),
  volta: v.optional(v.object({ node: v.optional(v.string()) })), packageManager: v.optional(v.string()) });
export const hostedNetworkResult = v.variant('ok', [v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: v.pipe(v.string(), v.regex(/^[A-Z0-9_]+$/), v.maxLength(100)) })]);
export const hostedFailure = v.object({
  cause: v.picklist(['container_start', 'image_pull', 'out_of_memory', 'process_killed', 'disk_full', 'install_failed', 'network', 'timeout', 'provider', 'collection', 'workflow_step', 'preflight', 'command', 'interrupted']),
  phase: v.picklist(['preflight', 'start', 'checkout', 'setup', 'model', 'command', 'collection', 'workflow']),
  message: v.pipe(v.string(), v.maxLength(1200)), action: v.picklist(['retry', 'more_time', 'edit_setup']), retryable: v.boolean(),
  evidence: v.object({ source: v.picklist(['container', 'process', 'workers_ai', 'provider', 'collector', 'workflow', 'repository']), operation: v.pipe(v.string(), v.maxLength(400)),
    exitCode: v.optional(v.number()), signal: v.optional(v.number()), code: v.optional(v.pipe(v.string(), v.maxLength(100))), status: v.optional(v.number()), providerCode: v.optional(v.number()),
    limitKind: v.optional(v.picklist(['command', 'task', 'model', 'transport'])), timeoutMs: v.optional(v.number()), elapsedMs: v.optional(v.number()),
    retryAfterMs: v.optional(v.number()), timedOut: v.optional(v.boolean()), oomKilled: v.optional(v.boolean()), diskAvailableBytes: v.optional(v.number()), truncated: v.optional(v.boolean()), step: v.optional(v.pipe(v.string(), v.maxLength(120))), reason: v.optional(v.pipe(v.string(), v.maxLength(120))) }),
  output: v.pipe(v.string(), v.maxLength(16000)), at: v.string(),
});

/** The platform limits each blob, not the sum of a pull request's files. */
export function checkSize(files: SubmissionFile[]) {
  const encoder = new TextEncoder();
  for (const file of files) if ('content' in file && file.content !== null && encoder.encode(file.content).length > LIMITS.bytes)
    throw new HttpError(413, 'Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.');
}

/** What an agent says it ran. Braid records these as reports, never as its own results. */
const testReports = v.optional(v.pipe(
  v.array(v.object({
    command: text('Test command', 400),
    result: v.picklist(['passed', 'failed', 'not-run'], 'Test results must be passed, failed, or not-run.'),
    detail: v.optional(text('Test detail', 2000)),
  }, 'Provide a command and result for each local test report.'), 'Include at most ten local test reports.'),
  v.maxLength(10, 'Include at most ten local test reports.')), []);

/* ---------- evidence ---------- */

/** What a revision may bring as evidence: 12 screenshots of at most 600 KB and 4 MB together, and 10 command runs with 8,000 characters of output each. */
const EVIDENCE = { screenshots: 12, imageBytes: 600_000, imagesBytes: 4_000_000, commands: 10, output: 8000 };
/** Leave 1 MiB below Workers' 32 MiB serialized RPC limit for the context and serialization overhead. */
export const SUBMISSION_BYTES = 31 * 1024 * 1024;
export const SUBMISSION_TOO_LARGE = 'Cloudflare Workers limits serialized RPC messages to 32 MiB. Keep JSON submissions below 31 MiB; use Git uploads and blob hashes for larger pull requests.';
const IMAGE = 'Send each screenshot as base64 PNG, JPEG or WebP data of at most 600 KB.';
const PAGE = 'Name the page each screenshot shows with a path starting with / or an http(s) URL, in at most 300 characters.';
const SIDE = 'Give each screenshot\'s width and height in whole pixels, up to 4,000.';
const OUTPUT = 'Send at most 8,000 characters of each command\'s output, its end if it printed more.';
/** The bytes each image type starts with, and where. */
const SIGNATURES = { 'image/png': [[0, '\x89PNG\r\n\x1a\n']], 'image/jpeg': [[0, '\xff\xd8\xff']], 'image/webp': [[0, 'RIFF'], [8, 'WEBP']] } as const;
/** How many bytes standard base64 decodes to. */
const decodedSize = (data: string) => data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
/** Standard base64 with padding, decoding to at most one screenshot's bytes. */
function base64Image(data: string) {
  return data.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(data.replace(/={1,2}$/, '')) && decodedSize(data) <= EVIDENCE.imageBytes;
}
/** Terminal output as a person reads it: colour and cursor codes gone, and a line redrawn with carriage returns as it ended. */
const plainOutput = (output: string) => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g, '')
  .split('\n').map(line => line.replace(/\r$/, '').split('\r').at(-1)!).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
/** Whether a screenshot's bytes begin the way its declared image type does. */
function declared(item: { contentType: keyof typeof SIGNATURES; data: string }) {
  const head = atob(item.data.slice(0, 16));
  return SIGNATURES[item.contentType].every(([at, bytes]) => head.startsWith(bytes, at));
}
const screenshot = v.object({
  kind: v.literal('screenshot'),
  page: v.pipe(v.string(PAGE), v.maxLength(300, PAGE), v.check(page => /^\/(?!\/)[^\s\x00-\x1f\x7f]*$/.test(page) || (/^https?:\/\/[^\s\x00-\x1f\x7f]+$/.test(page) && URL.canParse(page)), PAGE)),
  viewport: v.picklist(['desktop', 'mobile'], 'A screenshot\'s viewport is desktop or mobile.'),
  width: whole(1, 4000, SIDE),
  height: whole(1, 4000, SIDE),
  contentType: v.picklist(['image/png', 'image/jpeg', 'image/webp'], IMAGE),
  data: v.pipe(v.string(IMAGE), v.maxLength(Math.ceil(EVIDENCE.imageBytes / 3) * 4, IMAGE), v.check(base64Image, IMAGE)),
}, IMAGE);
const command = v.object({
  kind: v.literal('command'),
  command: text('Command', 300),
  exitCode: v.pipe(v.number('Give each command its exit code as a whole number.'), v.safeInteger('Give each command its exit code as a whole number.')),
  output: v.pipe(v.string(OUTPUT), v.maxLength(EVIDENCE.output, OUTPUT), v.transform(plainOutput)),
  durationMs: v.optional(whole(0, 86_400_000, 'Give a command\'s duration in milliseconds, up to a day.')),
}, 'Send each command run with its command, exit code and output.');
/** Screenshots and command runs an agent shows with a revision. Braid records them as reported, never as its own results. */
const evidence = v.optional(v.pipe(
  v.array(v.variant('kind', [screenshot, command], 'Send each piece of evidence as a screenshot or a command run.'), 'Send evidence as a list.'),
  v.check(items => items.filter(item => item.kind === 'screenshot').length <= EVIDENCE.screenshots, `Include at most ${EVIDENCE.screenshots} screenshots.`),
  v.check(items => items.filter(item => item.kind === 'command').length <= EVIDENCE.commands, `Include at most ${EVIDENCE.commands} command runs.`),
  v.check(items => items.reduce((sum, item) => sum + (item.kind === 'screenshot' ? decodedSize(item.data) : 0), 0) <= EVIDENCE.imagesBytes, 'Include at most 4 MB of screenshots in one submission.'),
  v.check(items => items.every(item => item.kind !== 'screenshot' || declared(item)), 'A screenshot\'s data is not the image type it declares.')), []);

/* ---------- provenance ---------- */

const GIT_COMMAND = 'Send Git commands as <old commit> <new commit> <ref>.';
/** Receive-pack commands, parsed before refs are inspected or a pack is forwarded. Only the first names capabilities. */
export const gitPushCommands = v.pipe(
  v.array(v.pipe(v.string(GIT_COMMAND), v.regex(/^[a-f0-9]{40} [a-f0-9]{40} refs\/[^\x00-\x20\x7f]+(?:\0[^\x00-\x1f\x7f]*)?\n?$/, GIT_COMMAND)), GIT_COMMAND),
  v.minLength(1, GIT_COMMAND), v.maxLength(64, 'Push at most 64 refs.'),
  v.check(lines => lines.slice(1).every(line => !line.includes('\0')), GIT_COMMAND),
  v.transform(lines => lines.map(line => { const [old, next, ref] = line.split('\0')[0].replace(/\n$/, '').split(' '); return { old, new: next, ref }; })),
  v.check(commands => new Set(commands.map(command => command.ref)).size === commands.length, 'Push each ref only once.'),
);

const TOOL = 'Name the tool with at most 80 letters, digits and . _ / @ + - characters, such as claude-code/2.4.1.';
const SESSION = 'Give session ids of at most 80 letters, digits, _ and - characters.';
const session = (message: string) => v.optional(v.pipe(v.string(message), v.regex(/^[A-Za-z0-9_-]{1,80}$/, message)));
/** The run behind a change: the coding tool with its version, its session, and the orchestrator's session that started it. */
const agentRun = v.optional(v.object({
  tool: v.optional(v.pipe(v.string(TOOL), v.regex(/^[A-Za-z0-9._/@+-]{1,80}$/, TOOL))),
  session: session(SESSION),
  parentSession: session(SESSION),
}, 'Send agent as an object with tool, session and parentSession.'), {});
const CO_AUTHORS = 'Send at most 5 co-authors, each as Name <email> in at most 200 characters.';
/** One `Name <email>` co-author, as a submission sends it or a pushed commit's trailer names it. */
export const coAuthor = v.pipe(v.string(CO_AUTHORS), v.maxLength(200, CO_AUTHORS), v.regex(/^[^<>\s][^<>\r\n]* <[^<>\s@]+@[^<>\s@]+>$/, CO_AUTHORS));
/** The co-author lines the submitted commits carried, which the landed commit keeps verbatim: at most five `Name <email>`. */
const coAuthors = v.optional(v.pipe(
  v.array(coAuthor, CO_AUTHORS),
  v.maxLength(5, CO_AUTHORS)), []);
const FILE = 'Choose a file in the repository.';
/** `GET /api/blame?path=&ref=`: one file on main, any file Git tracks there. */
export const blameQuery = body({
  path: v.pipe(v.string(FILE), v.check(path => path.length <= 240 && !/[\x00-\x1f\x7f\\]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), FILE)),
  ref: v.optional(v.string()),
}, FILE);
const COMMITS = 'List 1–100 full commit IDs, separated by commas.';
/** `GET /api/provenance?commits=a,b`: up to 100 full commit IDs. */
export const provenanceQuery = body({
  commits: v.pipe(v.string(COMMITS), v.transform(value => [...new Set(value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))]),
    v.minLength(1, COMMITS), v.maxLength(100, COMMITS), v.check(items => items.every(item => /^[a-f0-9]{40}$/.test(item)), COMMITS)),
}, COMMITS);
const agentScopes = ['read', 'setup', 'work', 'fleet'] as const;
const owner = v.object({ id: v.optional(v.string()), publicId: v.optional(v.string()), name: v.string(), email: v.optional(v.string()), github: v.optional(v.string()) });
/** A person as the gateway passes them to repository objects: the owner of the agents and changes in a request. */
export const ownerHeader = v.pipe(v.string(), v.transform(decodeURIComponent), v.parseJson(), owner);

/** Signed access claims still cross an input boundary before Braid trusts their types. */
export const accessClaims = v.object({
  v: v.literal(1), grant: v.string(), user: v.object({ id: v.string(), email: v.string(), name: v.string() }),
  workspace: v.string(), team: v.string(), scope: v.picklist(agentScopes), agent: v.string(), name: v.string(), model: v.optional(v.string()),
  /** The approving person as the owner of the agent's work, and the fleet connection that minted it, read once at minting. */
  owner: v.optional(owner), fleet: v.optional(v.string()),
  exp: v.pipe(v.number(), v.finite(), v.check(value => value > Date.now())),
});
/** An OAuth access token's claims: an agent's, with the MCP resource it is for and the OAuth client it was issued to. */
export const mcpAccessClaims = v.object({ ...accessClaims.entries, aud: v.string(), client: v.string() });
export const actorHeader = v.pipe(v.string(), v.transform(decodeURIComponent));
export const githubVisibility = v.object({ private: v.boolean() });

/* ---------- changes ---------- */

const PREVIOUS = 'Provide previousRevision, the revision this one replaces.';
export const dependsOn = v.pipe(v.array(v.union([
  whole(1, Number.MAX_SAFE_INTEGER, 'Use a positive pull request number.'),
  v.pipe(v.string(), v.regex(/^ch_[0-9a-f]{13}$/, 'Use a pull request number or change id.')),
])), v.maxLength(16, 'A pull request can depend on at most 16 pull requests.'));
function changeEntries(system: boolean) {
  return {
    title: text('Title', 120),
    summary: text('Summary', 1200),
    intent: optionalText('Intent', 4000),
    rationale: optionalText('Rationale', 6000),
    baseCommit: commit('Provide the 40-character trunk commit this change is based on.'),
    dependsOn: v.optional(dependsOn),
    taskId: optionalText('Task', 100),
    model: optionalText('Model', 120),
    agent: agentRun,
    coAuthors,
    files: changeFiles(system),
    tests: testReports,
    evidence,
  };
}
const revisionOf = (system: boolean) => body({ ...changeEntries(system), title: optionalText('Title', 120), previousRevision: whole(1, Number.MAX_SAFE_INTEGER, PREVIOUS) }, 'Send a JSON change.');
/** A new change from an agent or person, or from Braid itself, which may include the task's record. */
export const submission = { agent: body(changeEntries(false), 'Send a JSON change.'), system: body(changeEntries(true), 'Send a JSON change.') };
export const revision = { agent: revisionOf(false), system: revisionOf(true) };

export const restack = body({ previousRevision: whole(1, Number.MAX_SAFE_INTEGER, PREVIOUS) }, 'Send the current previousRevision.');
export const stackPage = v.object({ stackCursor: v.optional(v.pipe(v.string(), v.transform(Number), whole(0, Number.MAX_SAFE_INTEGER, 'Invalid stack cursor.')), '0') });

export const review = body({
  revision: v.number('Review the current revision.'),
  verdict: v.picklist(['approve', 'revise', 'escalate', 'reject', 'comment'], 'Use approve, revise, escalate, reject or comment.'),
  risk: v.optional(v.picklist(['low', 'medium', 'high'], 'Risk is low, medium or high.')),
  summary: text('Review summary', 8000),
  findings: v.optional(v.pipe(v.array(v.object({
    severity: v.optional(v.picklist(['info', 'warning', 'error'], 'Finding severity is info, warning or error.'), 'warning'),
    message: text('Finding', 500),
    path: v.optional(v.pipe(v.string('A finding path is text.'), v.maxLength(240, 'A finding path has at most 240 characters.'))),
    line: v.optional(whole(1, Number.MAX_SAFE_INTEGER, 'A finding line is a whole number.')),
  }, 'Send each finding with a message.'), 'Send findings as a list.'), v.maxLength(20, 'Send at most 20 findings.')), []),
}, 'Send a JSON review.');
/** A new instruction from a person: what every agent should do, strings a change may never add, and the files it covers. */
export const instruction = body({
  text: instructionText,
  block: v.optional(blockedStrings),
  paths: v.optional(instructionPaths),
}, 'Send the instruction as text, with optional block and paths lists.');
export const closing = body({ reason: v.optional(v.picklist(['abandoned', 'superseded', 'rejected'], 'Close as abandoned, superseded or rejected.'), 'abandoned') }, 'Send a JSON object.');

/* ---------- merge queue and CI ---------- */

export const landing = body({ enabled: v.boolean('Send enabled: true or false.') }, 'Send enabled: true or false.');
/** The webhook to a repository's CI; the address itself is checked where it is stored. */
export const hook = body({
  url: v.string('Send the HTTPS address of your CI.'),
  secret: v.pipe(v.string('Use a secret of 16 to 200 characters.'), v.minLength(16, 'Use a secret of 16 to 200 characters.'), v.maxLength(200, 'Use a secret of 16 to 200 characters.')),
}, 'Send a url and a secret.');
const CI_STATUS = 'Send a state (pending, success, failure or error) and a context.';
/** A commit status from CI, in the shape of GitHub's statuses API. Links are kept only when they use HTTPS. */
export const ciStatus = v.pipe(v.string(), v.parseJson(undefined, 'Send JSON.'), body({
  state: v.picklist(['pending', 'success', 'failure', 'error'], CI_STATUS),
  context: v.pipe(v.string(CI_STATUS), v.regex(/^[\w./ :-]{1,100}$/, CI_STATUS)),
  description: v.optional(v.pipe(v.string('The description is text.'), v.transform(value => value.slice(0, 300)))),
  target_url: v.optional(v.pipe(v.string('target_url is a link.'), v.transform(value => /^https:\/\//.test(value) ? value.slice(0, 500) : undefined))),
}, CI_STATUS));
export const simulation = body({
  agents: whole(1, 2000, 'Choose between 1 and 2000 simulated agents.'),
  scenario: v.optional(v.picklist(['mixed', 'hotspot', 'disjoint'], 'Choose the mixed, hotspot or disjoint scenario.'), 'mixed'),
}, 'Send the number of agents and a scenario.');

/* ---------- tasks and repositories ---------- */

/** What a local proposal says when it names no model: not a model, so it never names the agent. */
export const LOCAL_MODEL = 'Local coding agent';
const PREVIEW = 'Open the integration preview again before merging.';
export const task = body({
  title: text('Title', 120),
  intent: text('Intent', 4000),
  execution: v.optional(v.picklist(['cloud', 'local'], 'Choose local or Cloudflare execution.'), 'cloud'),
  agentCount: v.optional(whole(1, 3, 'Choose one to three agents.')),
}, 'Send a title and intent.');
const githubSelection = body({
  installationId: positiveId('Choose a GitHub account and repository.'),
  repositoryId: positiveId('Choose a GitHub account and repository.'),
}, 'Choose a GitHub account and repository.');
/** A local page to resume after GitHub authorization; never an external redirect. */
export const githubFlowStart = body({ returnTo: v.optional(v.pipe(v.string(), v.maxLength(4096), v.check(path => path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x20]/.test(path), 'Choose a local return page.'))) }, 'Invalid GitHub connection request.');
export const githubLink = body({ ...githubSelection.entries, mode: v.picklist(['pull-requests', 'mirror'], 'Choose pull requests or mirror.') }, 'Choose a GitHub account and repository.');
export const project = v.pipe(body({
  name: v.pipe(text('Repository name', 48), v.regex(/^[a-z][a-z0-9-]{1,47}$/, 'Use 2–48 lowercase letters, digits, and hyphens, starting with a letter.')),
  description: v.optional(v.pipe(v.string('The description is text.'), v.transform(value => value.slice(0, 300))), ''),
  github: v.optional(githubSelection),
  sourceUrl: v.optional(text('Repository URL', 500)),
}, 'Send a repository name.'), v.check(input => !(input.github && input.sourceUrl), 'Choose a GitHub repository or enter a public URL, not both.'));
export const projectImportRetry = body({}, 'Send an empty object to retry the repository import.');
export const contextNote = body({
  title: text('Title', 120),
  body: text('Context', 4000),
  kind: v.optional(v.picklist(['constraint', 'learning'], 'Context is a constraint or a learning.'), 'constraint'),
}, 'Send a title and context.');
export const resolution = body({
  collisionId: v.string('Choose a valid proposal for this overlap.'),
  agentId: v.string('Choose a valid proposal for this overlap.'),
  reason: optionalText('Decision reason', 2000),
}, 'Choose a valid proposal for this overlap.');
export const merge = body({ integrationFingerprint: v.optional(hex(64, PREVIEW)) }, PREVIEW);
export const finish = body({ agentIds: v.array(v.string('Send the agents whose work you reviewed.'), 'Send the agents whose work you reviewed.') }, 'Send the agents whose work you reviewed.');
export const progress = body({ message: text('Progress', 1200) }, 'Send a progress message.');
/** A hosted agent finishes with a description and optional prerequisites; files come from its checkout. */
export const agentFinish = v.object({ summary: text('Summary', 1200), rationale: text('Rationale', 6000), dependsOn: v.optional(dependsOn) });
/** A local agent's proposal for its task; the base commit is checked against the task, not here. */
export const localSubmission = body({
  dependsOn: v.optional(dependsOn),
  previousCommit: v.optional(v.nullable(commit('Provide the previous proposal commit or null.'))),
  baseCommit: v.optional(v.string('Provide the commit this proposal is based on.'), ''),
  summary: text('Summary', 1200),
  rationale: text('Rationale', 6000),
  files: FILES.agent,
  model: v.optional(text('Agent model', 120), LOCAL_MODEL),
  agent: agentRun,
  coAuthors,
  tests: testReports,
  evidence,
}, 'Send a JSON proposal.');

/* ---------- accounts and agent connections ---------- */

/** Feedback carries no caller-supplied identity; the gateway supplies it from the connection. */
export const agentReport = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.regex(/\S/, 'Give the report a summary.')),
  details: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  tool: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.regex(/\S/, 'Name the tool or command.'))),
  pull_request: v.optional(positiveId()),
});
export const agentReportId = v.pipe(v.string(), v.regex(/^ar_[a-f0-9-]{36}$/, 'Report not found.'));

export const agentRequest = body({
  name: text('Agent name', 60),
  scope: v.picklist(agentScopes, 'Request read, setup, local work or fleet access.'),
}, 'Send an agent name and scope.');
const APPROVAL = 'Approve the requested permission or reduce it to read-only.';
export const agentApproval = body({ workspaceId: v.pipe(v.string(APPROVAL), v.nonEmpty(APPROVAL), v.maxLength(100, APPROVAL)), scope: v.picklist(agentScopes, APPROVAL) }, APPROVAL);
export const deviceToken = body({ deviceCode: v.pipe(v.string('Provide the device authorization code.'), v.maxLength(200, 'Provide the device authorization code.')) }, 'Provide the device authorization code.');
const FLEET_NAME = 'Name each fleet agent with 1–60 letters, digits, spaces or . : @ / - characters.';
/** Exchanging a connection for an access token; a fleet connection names the agent it is for. */
export const agentSession = body({ name: v.optional(v.pipe(v.string(FLEET_NAME), v.trim(), v.regex(/^[\w .:@/-]{1,60}$/, FLEET_NAME))), model: optionalText('Agent model', 120) }, 'Send a JSON object.');
export const ownerSession = body({ token: v.string('That owner key is not valid.') }, 'That owner key is not valid.');
const visibility = v.picklist(['public', 'private'], 'Choose public or private visibility.');
export const organizationName = body({ name: text('Organization name', 60) }, 'Send an organization name.');
const username = v.pipe(v.string('Choose a username.'), v.transform(value => value.toLowerCase()),
  v.regex(SLUG, 'Use 1–39 letters, digits and single hyphens, with no hyphen at either end.'),
  v.check(value => !RESERVED_OWNERS.has(value), 'This username is reserved.'));
export const accountUsername = v.strictObject({ username }, 'Send a username.');
const memberRole = v.picklist(['owner', 'member'], 'Choose an owner or member role.');
export const organizationMember = body({ role: memberRole }, 'Send a role.');
export const teamName = body({ name: text('Organization name', 60), visibility: v.optional(visibility) }, 'Send an organization name.');
export const teamUpdate = v.pipe(v.strictObject({
  name: v.optional(text('Organization name', 60)),
  slug: v.optional(v.pipe(v.string('Send an organization slug.'), v.regex(SLUG, 'Use 1–39 lowercase letters, digits and single hyphens.'), v.check(value => !RESERVED_OWNERS.has(value), 'This organization slug is reserved.'))),
}, 'Send an organization name or slug.'), v.check(input => Object.keys(input).length > 0, 'Send an organization name or slug.'));
export const repositoryLabel = body({ name: text('Repository label', 60), visibility: v.optional(visibility) }, 'Send a repository label.');
export const rosterIdFilter = v.pipe(v.string(), v.regex(/^roster:[a-f0-9]{64}$/, 'Public author and agent filters require a roster id.'));
export const repositoryUpdate = v.pipe(v.strictObject({
  name: v.optional(text('Repository label', 60)),
  slug: v.optional(v.pipe(v.string('Send a repository slug.'), v.regex(SLUG, 'Use 1–39 lowercase letters, digits and single hyphens.'))),
  visibility: v.optional(visibility),
}, 'Send visibility, slug or name.'), v.check(input => Object.keys(input).length > 0, 'Send visibility, slug or name.'));
/** A URL path segment, decoded. A malformed escape decodes to nothing, which the segment's own check refuses. */
const pathSegment = v.pipe(v.string(), v.transform(value => { try { return decodeURIComponent(value); } catch { return ''; } }));
const addressSlug = v.pipe(pathSegment, v.toLowerCase(), v.regex(SLUG, 'Repository not found.'));
// GitHub repository names also contain dots and underscores, and may be longer than owner names.
const repositoryName = v.pipe(pathSegment, v.toLowerCase(),
  v.regex(/^[a-z0-9_.-]{1,100}$/, 'Repository not found.'), v.check(value => value !== '.' && value !== '..', 'Repository not found.'));
export const repositoryAddress = v.object({ owner: addressSlug, repo: repositoryName });
export const githubNamespace = v.object({ id: positiveId(), login: v.pipe(v.string(), v.regex(/^[a-z\d-]{1,39}$/i)), type: v.picklist(['User', 'Organization']) });
export const githubOrganizationMembership = v.object({ role: v.picklist(['admin', 'member']), state: v.picklist(['active', 'pending']), organization: v.object({ id: positiveId(), login: v.string() }) });
export const githubMirrorRepository = v.object({ id: positiveId(), full_name: v.pipe(v.string(), v.regex(/^[a-z\d-]{1,39}\/[a-z\d_.-]{1,100}$/i)), private: v.boolean(),
  default_branch: v.pipe(v.string(), v.nonEmpty()), size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)), disabled: v.optional(v.boolean()), owner: githubNamespace });
export const githubMirrorHead = v.object({ branch: v.pipe(v.string(), v.nonEmpty(), v.maxLength(250), v.check(value => !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{'))), head: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)) });
export const workspaceSelection = v.pipe(v.string('Select a repository first.'), v.nonEmpty('Select a repository first.'), v.maxLength(100, 'Invalid repository ID.'), v.regex(/^[a-zA-Z0-9_-]+$/, 'Invalid repository ID.'));
const repositoryCursorFields = { updatedAt: v.pipe(v.string('Invalid repository cursor.'), v.isoTimestamp('Invalid repository cursor.')), id: workspaceSelection };
const repositoryCursor = cursor('Invalid repository cursor.', 1000, v.union([
  v.object({ ...repositoryCursorFields, sort: v.optional(v.literal('updated')) }),
  v.object({ ...repositoryCursorFields, sort: v.literal('name'), name: v.pipe(v.string(), v.maxLength(200)) }),
], 'Invalid repository cursor.'));
export const repositoryListQuery = v.pipe(v.object({
  limit: v.optional(queryNumber(20, v.pipe(v.number('Use a limit from 1 to 100.'), v.integer('Use a limit from 1 to 100.'), v.minValue(1, 'Use a limit from 1 to 100.'), v.maxValue(100, 'Use a limit from 1 to 100.'))), '20'),
  cursor: v.optional(repositoryCursor),
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200, 'Search with at most 200 characters.'), v.toLowerCase()), ''),
  sort: v.optional(v.picklist(['updated', 'name'], 'Sort by updated or name.'), 'updated'),
}), v.check(query => !query.cursor || (query.cursor.sort ?? 'updated') === query.sort, 'Use a cursor for the selected sort.'));
export const invite = body({ email, role: memberRole }, 'Send an email and role.');
/** `?before=` on the audit log: a time in milliseconds, or the newest entries when missing. */
export const auditCursor = queryNumber(Number.MAX_SAFE_INTEGER, v.pipe(v.number('Invalid audit cursor.'), v.safeInteger('Invalid audit cursor.')));
export const inviteToken = body({ token: v.pipe(v.string('This invitation is not valid.'), v.nonEmpty('This invitation is not valid.'), v.maxLength(200, 'This invitation is not valid.')) }, 'This invitation is not valid.');
export const emailStart = body({ email }, 'Enter a valid email address.');
const CODE = 'Enter the code in the browser where you requested it.';
/** A sign-in code as a person reads it: eight characters, with any spaces or hyphens they type removed. */
const signInCode = (message: string) => v.pipe(v.string(message), v.transform(value => value.replace(/[\s-]/g, '').toUpperCase()), v.length(8, message));
export const emailCode = body({
  flowId: v.pipe(v.string(CODE), v.nonEmpty(CODE)),
  code: signInCode(CODE),
}, CODE);

/* ---------- agents that sign themselves up ---------- */

const REPOSITORY_NAME = 'Name the repository as owner/repo.';
const signupScope = v.optional(v.picklist(['read', 'setup', 'work'], 'Ask for read, setup or work access.'), 'work');
/** What a self-connecting agent names: itself and, when the person has several repositories, the one to use. */
const agentSignupTarget = {
  checkout: v.optional(v.object({ name: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{1,47}$/)), github: v.optional(repositoryAddress) })),
  name: text('Agent name', 60),
  repository: v.optional(v.pipe(v.string(REPOSITORY_NAME), v.maxLength(141, REPOSITORY_NAME), v.regex(/^[^/\s]+\/[^/\s]+$/, REPOSITORY_NAME),
    v.transform(value => { const [owner, repo] = value.split('/'); return { owner, repo }; }), repositoryAddress)),
  workspaceId: v.optional(workspaceSelection),
};
const GITHUB_TOKEN = 'Send the token that gh auth token prints.';
/** A GitHub token an agent read from the GitHub CLI, used once to read who the person is and then discarded. */
export const agentGitHubSignup = body({
  token: v.pipe(v.string(GITHUB_TOKEN), v.regex(/^[\x21-\x7e]{20,255}$/, GITHUB_TOKEN)),
  scope: signupScope,
  ...agentSignupTarget,
}, GITHUB_TOKEN);
/** The access is fixed when the code is sent, so the email can say what the code allows. */
export const agentEmailStart = body({ email, scope: signupScope }, 'Enter a valid email address.');
const AGENT_CODE = 'Send the flowId from the start request and the code the person read in their email.';
export const agentEmailVerify = body({
  flowId: v.pipe(v.string(AGENT_CODE), v.uuid(AGENT_CODE)),
  code: signInCode(AGENT_CODE),
  ...agentSignupTarget,
}, AGENT_CODE);
/** The email GitHub shows on a profile, which GitHub lets a person choose only from their verified addresses. */
export const githubProfileEmail = v.object({ email: v.nullish(v.pipe(v.string(), v.trim(), v.toLowerCase())) });

/* ---------- OAuth for MCP clients ---------- */

const oauthText = (max: number) => v.pipe(v.string(), v.maxLength(max));
/** An authorization request (RFC 6749 4.1.1 with PKCE and RFC 8707). Each value is read here; the OAuth checks follow in order. */
export const oauthAuthorization = v.object({
  response_type: v.optional(oauthText(40)), client_id: v.optional(oauthText(2048)), redirect_uri: v.optional(oauthText(2048)),
  code_challenge: v.optional(oauthText(256)), code_challenge_method: v.optional(oauthText(32)), scope: v.optional(oauthText(256)),
  state: v.optional(oauthText(2048)), resource: v.optional(oauthText(2048)),
});
const CONSENT = 'Approve or deny the authorization request.';
export const oauthConsent = body({
  request: v.record(v.string(), v.pipe(v.string(), v.maxLength(2048)), CONSENT),
  decision: v.picklist(['approve', 'deny'], CONSENT),
  workspaceId: v.optional(workspaceSelection),
  scope: v.optional(v.picklist(['read', 'work'], 'Choose read or work access.')),
}, CONSENT);
const redirectUris = (max: number) => v.pipe(v.array(v.pipe(v.string(), v.maxLength(2048))), v.minLength(1), v.maxLength(max));
/** Dynamic client registration (RFC 7591). Unlisted metadata is dropped; Braid uses only what it shows and checks. */
export const oauthRegistration = v.object({
  redirect_uris: redirectUris(10),
  client_name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  token_endpoint_auth_method: v.optional(v.picklist(['none', 'client_secret_post', 'client_secret_basic']), 'client_secret_basic'),
  grant_types: v.optional(v.pipe(v.array(v.picklist(['authorization_code', 'refresh_token'])), v.minLength(1)), ['authorization_code', 'refresh_token']),
  response_types: v.optional(v.array(v.picklist(['code'])), ['code']),
});
/** A client ID metadata document. A document client cannot hold a shared secret, so it authenticates with none. */
export const oauthClientDocument = v.pipe(v.looseObject({
  client_id: v.string(),
  client_name: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(200)),
  redirect_uris: redirectUris(20),
  token_endpoint_auth_method: v.optional(v.literal('none'), 'none'),
  grant_types: v.optional(v.array(v.string()), ['authorization_code']),
  response_types: v.optional(v.array(v.string()), ['code']),
}), v.check(document => !('client_secret' in document) && !('client_secret_expires_at' in document)));
const OAUTH_SECRET = v.optional(oauthText(512));
/** A token request's form: an authorization code with its PKCE verifier, or a refresh token. */
export const oauthTokenRequest = v.variant('grant_type', [
  v.object({ grant_type: v.literal('authorization_code'), code: oauthText(512), redirect_uri: oauthText(2048),
    code_verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{43,128}$/, 'The code_verifier must be 43–128 unreserved characters.')),
    client_id: v.optional(oauthText(2048)), client_secret: OAUTH_SECRET, resource: v.optional(oauthText(2048)) }),
  v.object({ grant_type: v.literal('refresh_token'), refresh_token: oauthText(512),
    client_id: v.optional(oauthText(2048)), client_secret: OAUTH_SECRET, scope: v.optional(oauthText(256)), resource: v.optional(oauthText(2048)) }),
]);
export const oauthRevocation = v.object({ token: oauthText(4096), token_type_hint: v.optional(oauthText(40)), client_id: v.optional(oauthText(2048)), client_secret: OAUTH_SECRET });
/* A passkey's answer, as @simplewebauthn/server reads it: RegistrationResponseJSON and AuthenticationResponseJSON. */
const PASSKEY = 'Send the passkey response.', FLOW = 'Start a new passkey request in this browser.';
/** Base64URL (RFC 4648 section 5), with the optional padding the library accepts. */
const base64url = v.pipe(v.string(PASSKEY), v.regex(/^[A-Za-z0-9_-]+={0,2}$/, PASSKEY));
const passkeyCredential = <const TResponse extends v.ObjectEntries>(response: TResponse) => v.pipe(v.object({
  id: base64url, rawId: base64url, type: v.literal('public-key', PASSKEY), response: v.object(response, PASSKEY),
  authenticatorAttachment: v.optional(v.picklist(['cross-platform', 'platform'], PASSKEY)),
  clientExtensionResults: v.object({ appid: v.optional(v.boolean(PASSKEY)), credProps: v.optional(v.object({ rk: v.optional(v.boolean(PASSKEY)) }, PASSKEY)), hmacCreateSecret: v.optional(v.boolean(PASSKEY)) }, PASSKEY),
}, PASSKEY), v.check(credential => credential.id === credential.rawId, PASSKEY));
export const passkeyId = v.pipe(pathSegment, v.nonEmpty('Choose a passkey.'));
export const passkeyRegistration = body({ flowId: v.string(FLOW), response: passkeyCredential({
  clientDataJSON: base64url, attestationObject: base64url, authenticatorData: v.optional(base64url), transports: v.optional(v.array(v.string(PASSKEY), PASSKEY)),
  publicKeyAlgorithm: v.optional(v.number(PASSKEY)), publicKey: v.optional(base64url) }) }, FLOW);
export const passkeyAuthentication = body({ flowId: v.string(FLOW), response: passkeyCredential({
  clientDataJSON: base64url, authenticatorData: base64url, signature: base64url, userHandle: v.optional(base64url) }) }, FLOW);

/* ---------- model output ---------- */

const guideSentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const guideText = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(700), v.check(text => !/[\r\n]/.test(text) && [...guideSentences.segment(text)].length <= 2, 'Use one or two plain sentences.'));
const guideLine = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** The model alone assigns chapter kinds and reading order. Hunk membership is verified against the actual diff. */
export const guideOutput = v.object({
  before: guideText, after: guideText,
  chapters: v.pipe(v.array(v.object({
    title: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(120), v.check(text => text.split(/\s+/).length <= 8 && !/[\r\n]/.test(text), 'Use a title of at most eight words.')),
    summary: guideText,
    kind: v.picklist(['logic', 'tests', 'generated', 'docs', 'config', 'mechanical']),
    hunks: v.pipe(v.array(v.object({ path: v.pipe(v.string(), v.nonEmpty(), v.maxLength(1024)), newStart: guideLine, newLines: guideLine })), v.minLength(1), v.maxLength(600)),
  })), v.minLength(1), v.maxLength(100)),
});

/**
 * A model's structured answer. Workers AI returns it already parsed, as
 * `response`, inside OpenAI-style `choices`, or as JSON text, sometimes in a
 * Markdown fence.
 */
export function modelOutput<const TSchema extends v.GenericSchema>(schema: TSchema) {
  const answer = v.union([schema, v.pipe(v.string(), v.transform(text => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), v.parseJson(), schema)]);
  return v.union([
    answer,
    v.pipe(v.object({ choices: v.pipe(v.array(v.object({ message: v.object({ content: v.unknown() }) })), v.minLength(1)) }), v.transform(output => output.choices[0].message.content), answer),
    v.pipe(v.object({ response: v.unknown() }), v.transform(output => output.response), answer),
  ]);
}

/* ---------- repository history ---------- */

const historyRef = v.pipe(v.string(), v.maxLength(1024), v.regex(/^[^\x00-\x20\x7f]+$/, 'Invalid history reference.'));
const historyPath = v.pipe(v.string(), v.maxLength(4096), v.check(path => !/[\x00-\x1f\x7f\\]/.test(path) && (!path || path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')), 'Invalid repository path.'));
const historyCursor = cursor('Invalid history cursor.', 24_000,
  v.object({ v: v.literal(1), ref: historyRef, path: historyPath, head: commit('Invalid history cursor.'), next: commit('Invalid history cursor.') }, 'Invalid history cursor.'));
export const historyQuery = v.object({
  ref: v.optional(historyRef), path: v.optional(historyPath, ''), cursor: v.optional(historyCursor),
});
export const repositoryTreeQuery = v.object({
  ref: v.optional(v.union([v.literal(''), historyRef])), path: v.optional(historyPath, ''),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(16), v.regex(/^(0|[1-9]\d*)$/, 'Invalid directory cursor.'), v.check(value => Number.isSafeInteger(Number(value)), 'Invalid directory cursor.'))),
});

/* ---------- repository comparisons ---------- */

const compareRef = v.pipe(v.string('Choose a branch or commit.'), v.nonEmpty('Choose a branch or commit.'), v.maxLength(1024), v.regex(/^[^\x00-\x20\x7f~^:?*\[\\]+$/, 'Invalid comparison reference.'), v.check(ref => !ref.includes('..') && !ref.includes('@{'), 'Invalid comparison reference.'));
export const repositoryCompareQuery = v.object({ base: compareRef, head: compareRef });
export const repositoryDiffQuery = v.object({ base: commit('Choose a full base commit.'), head: commit('Choose a full head commit.'), path: v.pipe(historyPath, v.nonEmpty('Choose a file.')) });
export const repositoryCommitQuery = v.object({ sha: v.pipe(v.string('Choose a commit hash.'), v.regex(/^[a-f0-9]{7,40}$/i, 'Choose a commit hash of 7–40 hexadecimal characters.'), v.toLowerCase()) });
export const repositoryCommitDiffQuery = v.object({ ...repositoryCommitQuery.entries, path: repositoryDiffQuery.entries.path });

/* ---------- repository code search ---------- */
export const repositorySearchQuery = v.object({
  q: v.pipe(v.string('Enter a search query.'), v.nonEmpty('Enter a search query.'), v.maxLength(256, 'Use at most 256 characters.'), v.regex(/^[^\x00-\x1f\x7f]+$/, 'Search one line at a time.'), v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const error = parseSearch(dataset.value).error;
    if (error) addIssue({ message: error });
  })),
  ref: v.optional(compareRef),
});
export const globalSearchQuery = v.pick(repositorySearchQuery, ['q']);

/* ---------- personal notifications ---------- */
export const notificationPreferences = v.pipe(v.strictObject({
  attention: v.optional(v.boolean('Choose whether to email review requests.')),
  returned: v.optional(v.boolean('Choose whether to email returned pull requests.')),
}), v.check(value => value.attention !== undefined || value.returned !== undefined, 'Choose a notification preference.'));
const UNSUBSCRIBE = 'This unsubscribe link is invalid or expired.';
export const notificationUnsubscribe = v.pipe(
  v.string(UNSUBSCRIBE), v.maxLength(200, UNSUBSCRIBE),
  v.regex(/^[a-f0-9]{32}\.(attention|returned)\.\d{13}\.[a-f0-9]{64}$/, UNSUBSCRIBE),
  v.transform(value => { const [person, kind, expires, signature] = value.split('.'); return { person, kind, expires: Number(expires), signature }; }),
  v.object({ person: v.string(), kind: v.picklist(['attention', 'returned']), expires: v.pipe(v.number(), v.safeInteger()), signature: v.string() }),
);

/* ---------- teams within organizations ---------- */
export const organizationPersonId = v.pipe(pathSegment, v.nonEmpty('Choose an organization member.'), v.maxLength(200, 'Invalid member ID.'));
const teamDescription = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500, 'Use at most 500 characters.')));
export const orgTeamCreate = body({ name: text('Team name', 60), description: teamDescription }, 'Send a team name.');
export const orgTeamUpdate = v.pipe(v.strictObject({
  name: v.optional(text('Team name', 60)),
  slug: v.optional(v.pipe(v.string(), v.regex(SLUG, 'Use 1–39 lowercase letters, digits and single hyphens.'))),
  description: teamDescription,
}, 'Send a name, address or description.'), v.check(input => Object.keys(input).length > 0, 'Send a name, address or description.'));
export const orgTeamMember = body({ role: v.picklist(['maintainer', 'member'], 'Choose maintainer or member.') }, 'Send a team role.');
export const orgTeamRepository = body({ permission: v.picklist(['read', 'write'], 'Choose read or write access.') }, 'Send a repository permission.');

/** A public fetch's arguments: only those Git sends, so every commit it wants is seen and checked before Artifacts answers. */
export const publicGitFetchLines = v.pipe(v.array(v.pipe(v.string(), v.regex(
  /^(?:want [a-f0-9]{40}(?: [^\r\n\x00]+)?|have [a-f0-9]{40}|shallow [a-f0-9]{40}|deepen [0-9]+|deepen-since [0-9]+|deepen-not [^\s\x00]+|want-ref [^\s\x00]+|filter [^\r\n\x00]+|done|thin-pack|no-progress|include-tag|ofs-delta|deepen-relative|wait-for-done|sideband-all)\n?$/,
  'Unsupported Git fetch argument.'))), v.maxLength(8192, 'Too many Git fetch arguments.'));

/** Anonymous GitHub metadata used only to choose a public import. */
export const agentPublicSource = v.object({ private: v.boolean(), disabled: v.optional(v.boolean()) });
