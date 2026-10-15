import * as v from 'valibot';
import type { AgentRecord, Change, ChangeStatus, Instruction, Provenance, SubmitChangeInput } from '../../shared/types';
import { ID, TOKEN } from './config';

/*
 * Everything braid reads from Braid or from its own files is parsed here, once, where it arrives. A schema keeps the
 * fields the CLI uses, typed by the shared contract in shared/types.ts, so the commands trust what they get.
 */

export const commit = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Expected a full commit id.'));
/** Browser links are optional for older servers; only absolute HTTP(S) URLs reach the terminal. */
export const htmlUrl = v.pipe(v.string(), v.url(), v.check(value => /^https?:\/\//.test(value) && !/[\x00-\x20\x7f]/.test(value) && !new URL(value).username && !new URL(value).password));
const lineCount = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Offline attribution of the surviving lines at HEAD, as `braid stats --json` prints it. */
const statsRow = v.object({
  kind: v.picklist(['agent', 'human', 'bot']), name: v.string(), model: v.optional(v.string()), owner: v.optional(v.string()), tool: v.optional(v.string()),
  lines: lineCount, share: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});
export const repositoryStats = v.object({
  repository: v.string(), head: commit, files: lineCount, lines: lineCount, rows: v.array(statsRow),
  skipped: v.object({ binary: lineCount, generated: lineCount, large: lineCount }),
});
export type StatsRow = v.InferOutput<typeof statsRow>;
export type RepositoryStats = v.InferOutput<typeof repositoryStats>;
export const token = v.pipe(v.string(), v.regex(TOKEN, 'Expected a token.'));
const time = v.pipe(v.string(), v.check(value => Number.isFinite(Date.parse(value)), 'Expected a time.'));
export const id = v.pipe(v.string(), v.regex(ID, 'Expected an id.'));
/** A change's id, which braid puts in request paths. */
export const changeId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/, 'Expected a change id.'));
/** An idempotency key, as Braid accepts it. */
export const KEY = /^[a-zA-Z0-9_-]{16,128}$/;

/* ---------- sign-in ---------- */

export const deviceRequest = v.object({
  deviceCode: v.pipe(v.string(), v.minLength(16), v.maxLength(200)),
  userCode: v.pipe(v.string(), v.regex(/^[A-Z0-9-]{4,32}$/)),
  verificationUri: v.pipe(v.string(), v.url()),
  expiresIn: v.pipe(v.number(), v.gtValue(0), v.maxValue(3600)),
  interval: v.pipe(v.number(), v.minValue(1)),
});
export const grant = v.object({
  accessToken: token, tokenType: v.literal('Bearer'), expiresAt: time, workspaceId: id,
  scope: v.picklist(['read', 'setup', 'work', 'fleet']),
});
/** A five-minute access token exchanged for the saved connection, and the agent identity Braid gives it. */
export const access = v.object({
  accessToken: v.pipe(token, v.startsWith('braid_at_')), tokenType: v.literal('Bearer'), expiresAt: time,
  agent: v.object({ id: v.string(), name: v.string() }), workspaceId: id,
});
/** What an access token says about itself; braid reads only the approving person, to show who an agent works for. */
export const claims = v.object({ user: v.object({ id: v.string(), name: v.optional(v.string()), email: v.optional(v.string()) }), scope: v.optional(v.string()) });
export const errorBody = v.object({ error: v.string() });

/* ---------- changes ---------- */

const changeStatus = v.picklist(['open', 'revise', 'attention', 'queued', 'landing', 'landed', 'closed'] as const satisfies readonly ChangeStatus[]);
export const dependencyInputs = v.pipe(v.array(v.union([v.pipe(v.number(), v.safeInteger(), v.minValue(1)), v.pipe(v.string(), v.regex(/^ch_[0-9a-f]{13}$/))])), v.maxLength(16));
export const dependencyFlag = v.pipe(v.string(), v.transform(value => value === 'none' ? [] : value.split(',').map(part => /^[1-9]\d*$/.test(part.trim()) ? Number(part.trim()) : part.trim())), dependencyInputs);
export const restackReceipt = v.object({ key: v.pipe(v.string(), v.regex(KEY)), previousRevision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), pending: v.boolean(), origin: v.string(), workspaceId: v.string() });
const changeReference = v.object({ id: changeId, number: v.number(), status: changeStatus });
export const pullRequestContext = v.object({ id: changeId, number: v.number(), html_url: v.optional(htmlUrl), status: changeStatus, next: v.optional(v.string()), dependsOn: v.optional(v.array(changeReference)), waitingOn: v.optional(v.array(changeReference)), outdated: v.optional(v.array(changeReference)) });
const list = <S extends v.GenericSchema>(item: S) => v.optional(v.array(item), []);
const command = v.object({ kind: v.literal('command'), revision: v.number(), command: v.string(), exitCode: v.number(), output: v.string(), source: v.optional(v.string()) });
export const reviewComment = v.object({
  id: v.string(), body: v.string(), revision: v.number(), createdAt: v.string(), inReplyTo: v.optional(v.string()), resolved: v.optional(v.boolean()),
  author: v.object({ name: v.string(), kind: v.string(), owner: v.optional(v.object({ name: v.string(), email: v.optional(v.string()), github: v.optional(v.string()) })) }),
  anchor: v.optional(v.object({ path: v.string(), line: v.number(), side: v.picklist(['LEFT', 'RIGHT']), revision: v.number(), position: v.nullable(v.number()), outdated: v.boolean() })),
});
/** The parts of a change braid prints: where it stands, and everything that sent it back. */
export const change = v.object({
  id: changeId, number: v.number(), html_url: v.optional(htmlUrl), title: v.string(), status: changeStatus,
  closeReason: v.optional(v.picklist(['abandoned', 'superseded', 'rejected'])), revision: v.number(),
  next: v.optional(v.string()), landedCommit: v.optional(v.string()),
  dependsOn: v.optional(v.array(changeReference)), requiredBy: v.optional(v.array(changeReference)), waitingOn: v.optional(v.array(changeReference)), outdated: v.optional(v.array(changeReference)),
  comments: list(reviewComment),
  conflicts: list(v.object({ path: v.string(), kind: v.string(), regions: v.optional(v.array(v.object({ baseStart: v.number() }))) })),
  checks: list(v.object({ revision: v.number(), label: v.string(), status: v.string(), detail: v.string(), source: v.string() })),
  guards: list(v.object({ kind: v.string(), path: v.string(), detail: v.string() })),
  reviews: list(v.object({ revision: v.number(), reviewer: v.string(), verdict: v.string(), summary: v.string(), findings: list(v.object({ path: v.optional(v.string()), line: v.optional(v.number()), message: v.string() })) })),
  evidence: list(v.variant('kind', [command, v.object({ kind: v.literal('screenshot'), revision: v.number() })])),
  overlaps: list(v.object({ number: v.number() })),
}) satisfies v.GenericSchema<unknown, Pick<Change, 'id' | 'number' | 'title' | 'status' | 'closeReason' | 'revision' | 'next' | 'landedCommit'>>;
export type ChangeView = v.InferOutput<typeof change>;
export const trunk = v.object({ remote: v.pipe(v.string(), v.url()), token, branch: v.string(), head: commit });

/* ---------- instructions ---------- */

const instruction = v.object({ id: v.string(), text: v.string(), block: v.optional(v.array(v.string())), paths: v.optional(v.array(v.string())) }) satisfies v.GenericSchema<unknown, Instruction>;
export const instructions = v.object({ instructions: v.array(instruction), errors: v.optional(v.array(v.string()), []) });

/* ---------- provenance ---------- */

const owner = v.object({ id: v.optional(v.string()), name: v.string(), email: v.optional(v.string()), github: v.optional(v.string()) });
const attribution = v.object({
  kind: v.picklist(['agent', 'human', 'bot']),
  agent: v.optional(v.object({ id: v.optional(v.string()), name: v.string(), model: v.optional(v.string()), tool: v.optional(v.string()), fleet: v.optional(v.string()), session: v.optional(v.string()), parentSession: v.optional(v.string()) })),
  owner: v.optional(owner),
});
export const provenance = v.object({
  commit: v.string(), at: v.string(), subject: v.string(), ...attribution.entries,
  files: v.optional(v.record(v.string(), attribution)),
  change: v.optional(v.object({ id: v.string(), number: v.number() })), task: v.optional(v.object({ id: v.string(), title: v.optional(v.string()) })),
  confidence: v.picklist(['braid', 'trailers', 'inferred']),
}) satisfies v.GenericSchema<unknown, Provenance>;
/** `GET /api/provenance?commits=`: what Braid knows about each commit it was asked about and witnessed. */
export const provenanceList = v.array(provenance);
export const agentRecords = v.array(v.object({
  id: v.string(), name: v.string(), owner: v.optional(owner), models: v.array(v.string()), tools: v.array(v.string()), fleet: v.optional(v.string()),
  changes: v.object({ landed: v.number(), sentBack: v.number(), reverted: v.number(), open: v.number() }),
  lines: v.object({ added: v.number(), alive: v.number() }), firstActive: v.string(), lastActive: v.string(), simulated: v.optional(v.literal(true)),
}) satisfies v.GenericSchema<unknown, AgentRecord>);

/* ---------- what braid submits, and keeps to retry ---------- */

const text = (max: number) => v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(max));
export const testReports = v.pipe(v.array(v.object({
  command: text(400), result: v.picklist(['passed', 'failed', 'not-run']), detail: v.optional(text(2000)),
}), 'The tests file holds a JSON list of {command, result, detail?} reports.'), v.maxLength(10, 'Report at most 10 tests.'));
export const evidenceInput = v.variant('kind', [
  v.object({ kind: v.literal('screenshot'), page: v.string(), viewport: v.picklist(['desktop', 'mobile']), width: v.number(), height: v.number(), contentType: v.picklist(['image/png', 'image/jpeg', 'image/webp']), data: v.string() }),
  v.object({ kind: v.literal('command'), command: v.string(), exitCode: v.number(), output: v.string(), durationMs: v.optional(v.number()) }),
]);
/** The agent run that made a change: its tool, its session and the session that started it. */
const agentRun = v.object({ tool: v.optional(v.string()), session: v.optional(v.string()), parentSession: v.optional(v.string()) });
const payload = v.object({
  title: v.optional(v.string()), summary: v.string(), intent: v.optional(v.string()), rationale: v.optional(v.string()), model: v.optional(v.string()),
  baseCommit: commit, files: v.array(v.object({ path: v.string(), content: v.nullable(v.string()), mode: v.optional(v.picklist(['100644', '100755'])) })),
  dependsOn: v.optional(dependencyInputs),
  tests: v.optional(testReports), evidence: v.optional(v.array(evidenceInput)),
  previousRevision: v.optional(v.number()), agent: v.optional(agentRun),
  /** The co-author lines the submitted commits carry, which Braid keeps in the commit it lands. */
  coAuthors: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(5))),
}) satisfies v.GenericSchema<unknown, Omit<SubmitChangeInput, 'title'> & { title?: string }>;
export type Payload = v.InferOutput<typeof payload>;

/** A submission saved before it is sent, so an uncertain answer can be retried with the same body and key. */
export const journal = v.object({
  status: v.picklist(['pending', 'complete', 'rejected']), key: v.pipe(v.string(), v.regex(KEY)),
  target: v.pipe(v.string(), v.regex(/^\/api\/changes(?:\/[A-Za-z0-9_-]+\/revisions)?$/)), payload,
});
export type Journal = v.InferOutput<typeof journal>;
/** The change a branch is working on, kept in the Git directory so it never shows up as a file to commit. */
export const branchState = v.object({
  origin: v.string(), workspaceId: id, base: commit, nextBase: v.optional(commit),
  change: v.optional(v.object({ id: changeId, number: v.number(), revision: v.number(), status: changeStatus, html_url: v.optional(htmlUrl) })),
});
export type BranchState = v.InferOutput<typeof branchState>;
