import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { answer, Braid, send } from './api';
import { command, describeChange, describeComments, checkoutArgs, nextStep, poll, settled } from './change';
import { checkoutRoot, collectProposal, pinnedBase } from './checkout';
import { withLock } from './repository';
import { decodeText, LIMITS, readTests, validPath } from './collect';
import { agentLogin } from './commands/login';
import { CliError, fail, print, type BraidContext } from './context';
import { ID, loadCredentials, normalizeOrigin, originOf, privateDirectory, readPrivateJson, realDirectory, savedCredentials, writePrivate, writePrivateJson, type Credentials } from './config';
import { fetchCommit, hasCommit, isAncestor, strict, strictGit, httpsRemote } from './git';
import { readProof, runProof } from './proof';
import { change as changeSchema, changeId, commit, evidenceInput, id, KEY, dependencyInputs, testReports, reviewComment, pullRequestContext, htmlUrl, token } from './schemas';
import { SLUG } from '../../shared/routes';
import { assertNoSecrets, assertSubmittable } from './secrets';

/*
 * Tasks a person asks for in Braid, done by a coding tool on this machine. `task start` reuses the approval for the
 * task's repository, or asks the owner for one, and prepares a checkout pinned to the task's base; the agent then
 * submits its committed result as the task's proposal, revises it, updates to a newer main and waits for what comes
 * back. This is braid.mjs's task flow, with its files and receipts unchanged so either tool can continue a checkout
 * the other started: .braid/task.json, .braid/TASK.md and .braid/submission.json, all owner-only.
 */

const identifier = (value: string) => ID.test(value) ? value : fail('Invalid task, agent or repository id.');
const text = (value: string | undefined, label: string, max: number) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max && !trimmed.includes('\0') ? trimmed : fail(`Give a ${label} of 1 to ${max} characters.`);
};
const sanitized = (max: number) => v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(max), v.check(value => !value.includes('\0')));
const scopePath = v.pipe(v.string(), v.check(path => path === '*' || validPath(path.replace(/\/$/, ''))));
const sameScope = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((path, index) => path === right[index]);

/* ---------- links and metadata ---------- */

/** A task link from Braid: its origin, the task, and the repository and agent when the link names them. */
export function taskLink(value: string) {
  if (!URL.canParse(value)) fail('Give the task link from Braid.');
  const url = new URL(value), home = normalizeOrigin(url.origin);
  if (url.username || url.password || url.hash || /[\x00-\x20\x7f\\]/.test(value)) fail('That is not a valid task link.');
  const match = /^\/(?:([^/]+)\/([^/]+)\/)?tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/?$/.exec(url.pathname);
  if (!match || (match[1] && (!SLUG.test(match[1]) || !SLUG.test(match[2]))) || [...url.searchParams.keys()].some(key => !['workspace', 'agent'].includes(key)) || ['workspace', 'agent'].some(key => url.searchParams.getAll(key).length > 1)) fail('Use a task link from Braid, such as https://braid.example/owner/repo/tasks/ID.');
  const workspaceId = url.searchParams.get('workspace') ?? undefined, agentId = url.searchParams.get('agent') ?? undefined;
  if ([workspaceId, agentId].some(value => value !== undefined && !ID.test(value))) fail('That task link names an invalid repository or agent.');
  return { origin: home, missionId: match[3], workspaceId, agentId, ...(match[1] ? { repository: `${match[1]}/${match[2]}` } : {}) };
}

/**
 * .braid/task.json: the task, its repository and agent, the base the next submission is against and, after an
 * update, the base Braid still reports until a submission against the newer one is accepted. Unknown fields are kept.
 */
const taskFile = v.pipe(
  v.looseObject({
    url: v.string(), workspaceId: id, missionId: id, agentId: id, baseCommit: commit, scope: v.array(scopePath),
    acceptedBase: v.optional(commit), previousCommit: v.optional(v.nullable(commit)), submissionMode: v.optional(v.literal('commits')),
    html_url: v.optional(htmlUrl),
  }),
  v.check(task => task.acceptedBase !== task.baseCommit && originOf(task.url) === task.url),
);
type Task = v.InferOutput<typeof taskFile>;
const taskPath = (root: string) => join(root, '.braid', 'task.json');

function readTask(root: string): Task {
  if (!existsSync(join(root, '.braid'))) fail('This directory is not a Braid task checkout. Start one with braid task start and the task link.');
  realDirectory(join(root, '.braid'));
  const task = readPrivateJson(taskPath(root), taskFile, { max: 32_768, readOnly: true, label: 'Task metadata' });
  return task ?? fail('This directory is not a Braid task checkout. Start one with braid task start and the task link.');
}

/** Writes only real changes, reading the file again first so fields another command changed meanwhile are kept. */
function saveTask(root: string, before: Task, next: Task): Task {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
  if (!changed.length) return before;
  const result: Record<string, unknown> = { ...readTask(root) };
  for (const key of changed) if (next[key] === undefined) delete result[key]; else result[key] = next[key];
  const checked = v.safeParse(taskFile, result);
  if (!checked.success) fail('The task metadata changed while this command ran. Run it again.');
  writePrivateJson(taskPath(root), result);
  return checked.output;
}

function withPrevious(task: Task, previousCommit: string | null | undefined): Task {
  const next: Task = { ...task };
  if (previousCommit) next.previousCommit = previousCommit;
  else delete next.previousCommit;
  return next;
}

/* ---------- Braid's answers ---------- */

const connection = (credentials: Credentials) => ({ authorization: `Bearer ${credentials.accessToken}`, 'x-braid-workspace': credentials.workspaceId });
const missionPath = (task: { url: string; missionId: string; agentId: string }, action: string) => `${task.url}/api/missions/${encodeURIComponent(task.missionId)}/agents/${encodeURIComponent(task.agentId)}/${action}`;

const checkoutAnswer = v.object({
  html_url: v.optional(htmlUrl),
  pullRequest: v.optional(pullRequestContext),
  reviewComments: v.optional(v.array(reviewComment), []),
  missionId: v.string(), agentId: v.string(), baseCommit: commit, previousCommit: v.optional(v.nullable(commit)), scope: v.array(scopePath),
  remote: v.string(), token, title: sanitized(1200), intent: sanitized(12_000), context: v.optional(v.unknown()),
});
type Details = Omit<v.InferOutput<typeof checkoutAnswer>, 'context'> & { context: string };

/** What a checkout or update answer says, checked against the task asked for; nothing in it may look like a credential. */
async function checkoutDetails(context: BraidContext, response: Response, home: string, missionId: string, agentId: string, credentials: Credentials, path: string): Promise<Details> {
  const answered = await answer(response, checkoutAnswer, { path, secrets: [credentials.accessToken] });
  if (answered.missionId !== missionId || answered.agentId !== agentId) fail('Braid returned checkout details for a different task.');
  const details = { ...answered, remote: httpsRemote(answered.remote), context: typeof answered.context === 'string' ? answered.context : JSON.stringify(answered.context ?? {}, null, 2) };
  const metadata = { url: home, workspaceId: credentials.workspaceId, missionId, agentId, baseCommit: details.baseCommit, previousCommit: details.previousCommit, scope: details.scope };
  assertNoSecrets(JSON.stringify(metadata) + brief(context, details, { origin: home }), [credentials.accessToken, details.token], 'The task holds something that looks like a credential, so braid did not write it to disk.');
  return details;
}

const missions = v.object({ missions: v.array(v.object({
  html_url: v.optional(htmlUrl),
  id: v.string(), source: v.string(), execution: v.string(), status: v.string(), baseCommit: v.optional(v.string()),
  agents: v.array(v.object({ id: v.string(), status: v.string(), commit: v.optional(v.nullable(v.string())) })),
})) });
const changePage = v.object({ items: v.array(v.object({ id: changeId })) });

/* ---------- the brief an agent reads ---------- */

/** .braid/TASK.md: the task, its base and scope, its context, and how to work and submit with this CLI. */
function brief(context: BraidContext, details: Details, { origin: home, acceptedBase, committed = false, single = false }: { origin: string; acceptedBase?: string; committed?: boolean; single?: boolean }) {
  const run = (...args: string[]) => `\`${command(context, ...args)}\``;
  const base = acceptedBase
    ? `Base commit: ${details.baseCommit}\n\nMain moved after the accepted base ${acceptedBase}. Merge or rebase ${details.baseCommit} into your work, resolve any conflicts and rerun the checks before submitting.`
    : `Base commit: ${details.baseCommit}`;
  const history = committed
    ? 'Commit the result you want reviewed: submit sends committed work and refuses uncommitted files. Local branches and merges are fine while the base stays in history.'
    : 'Commit and integrate work locally as needed, preserving the pinned base in history.';
  return `# ${details.title}\n\n${details.intent}\n\n${base}\n\nScope:\n${details.scope.map(path => `- ${path}`).join('\n')}\n\n## Task context\n\n${details.context}\n\n`
    + (details.pullRequest ? `## Pull request #${details.pullRequest.number}\n\n${details.pullRequest.outdated?.length ? `${details.pullRequest.outdated.map(item => `#${item.number}`).join(', ')} changed since this was built. Run braid restack ${details.pullRequest.number}.` : details.pullRequest.next ?? details.pullRequest.status}${details.pullRequest.dependsOn?.length ? `\nDepends on ${details.pullRequest.dependsOn.map(item => `#${item.number}`).join(', ')}` : ''}\n\n` : '')
    + (details.reviewComments.length ? `## Unresolved review comments\n\n${describeComments(details.reviewComments)}\n\n` : '')
    + `Complete the requested result. Choose your own plan, coding tools, subagents and isolation. Worktrees are optional. ${history} Run the repository checks yourself.\n`
    + `Submit it for review with ${run('task', 'submit', '--summary', 'What changed')} from this checkout. Test reports are agent-reported and unverified. To revise a proposal, submit again from this checkout; the revision replaces the previous proposal with the complete change from the base.\n`
    + (single ? `If main moves, ${run('task', 'update')} fetches it without changing your branch or files.\n` : '')
    + `Add .braid/proof.json if the repository has none, and submit with --proof to attach the checks and screenshots it describes (see ${run('task', 'submit', '--help')}). After submitting, run ${run('task', 'wait')}; when the result comes back, fix exactly what it names and submit again. Keep going until it lands or Braid says a person must decide.\n`
    + `Run ${run('task', 'resume')} to refresh .braid/TASK.md with the owner’s latest task instructions without changing your work. Read it before continuing.\n`
    + `After your connection expires, run ${run('connect', '--url', home)}, then ${run('task', 'resume')} to renew this checkout.\n`
    + `If a submission is unconfirmed, ${run('task', 'submit', '--retry')} resends its saved payload and key.\n`;
}

/* ---------- receipts ---------- */

const receipt = v.pipe(v.object({
  url: v.string(), workspaceId: v.string(), missionId: v.string(), agentId: v.string(),
  key: v.pipe(v.string(), v.regex(KEY)), body: v.string(), status: v.picklist(['pending', 'complete', 'rejected']), commit: v.optional(commit), html_url: v.optional(htmlUrl),
}), v.check(saved => saved.status !== 'complete' || !!saved.commit));
type Receipt = v.InferOutput<typeof receipt>;
const RECEIPT_LIMIT = 48 * 1024 * 1024;

/** The saved submission for this task, which must be this task's: an uncertain one is never discarded. */
function readReceipt(root: string, task: Task): Receipt | undefined {
  let saved: Receipt | undefined;
  try { saved = readPrivateJson(join(root, '.braid', 'submission.json'), receipt, { max: RECEIPT_LIMIT, label: 'The saved submission' }); } catch { return fail('Invalid submission receipt for this task. Do not discard an uncertain submission.'); }
  if (saved && (['url', 'workspaceId', 'missionId', 'agentId'] as const).some(key => saved![key] !== task[key])) fail('Invalid submission receipt for this task. Do not discard an uncertain submission.');
  return saved;
}
const receiptStatus = (root: string) => { try { return readPrivateJson(join(root, '.braid', 'submission.json'), v.looseObject({ status: v.optional(v.string()) }), { max: RECEIPT_LIMIT, readOnly: true })?.status; } catch { /* Only chooses advice; submit reads the receipt strictly. */ return undefined; } };

/** Keeps every replaced receipt, so earlier accepted proposals stay recoverable under .braid/submissions. */
function archiveReceipt(root: string, saved: Receipt) {
  const path = join(privateDirectory(join(root, '.braid', 'submissions')), `${saved.key}.json`);
  const earlier = readPrivateJson(path, v.looseObject({ key: v.optional(v.string()), body: v.optional(v.string()) }), { max: RECEIPT_LIMIT, label: 'An archived receipt' });
  if (earlier && (earlier.key !== saved.key || earlier.body !== saved.body)) fail('An archived receipt conflicts with this submission. Inspect .braid/submissions before submitting again.');
  writePrivateJson(path, saved);
}

/** A saved body as a JSON object, to compare two submissions field by field. */
const fields = (body: string) => { const result = v.safeParse(v.pipe(v.string(), v.parseJson(), v.record(v.string(), v.unknown())), body); return result.success ? result.output : {}; };
/** Identical work, summary, tests and proof, ignoring which proposal it replaces. */
const sameWork = (left: string, right: string) => {
  const strip = (body: string) => { const { previousCommit: _, ...rest } = fields(body); return JSON.stringify(rest); };
  return strip(left) === strip(right);
};
/** The latest proposal to replace: a newer confirmed receipt wins over metadata from before it. */
function expectedPrevious(task: Task, saved?: Receipt) {
  const recorded = task.previousCommit ?? null;
  if (saved?.status !== 'complete') return recorded;
  const sent = fields(saved.body).previousCommit ?? null;
  return recorded === sent || recorded === saved.commit ? saved.commit ?? null : recorded;
}

/** A proposal as Braid accepts it, checked again before every send, including a retry of a body saved earlier. */
const proposal = v.object({
  dependsOn: v.optional(dependencyInputs),
  baseCommit: commit, previousCommit: v.optional(v.nullable(commit)), summary: sanitized(1200), rationale: sanitized(6000), model: v.optional(sanitized(120)),
  files: v.pipe(v.array(v.object({ path: v.string(), content: v.nullable(v.string()), mode: v.optional(v.picklist(['100644', '100755'])) })), v.minLength(1)),
  tests: v.optional(testReports), evidence: v.optional(v.array(evidenceInput)),
});
type Proposal = v.InferOutput<typeof proposal>;
const readProposal = (body: string) => v.safeParse(v.pipe(v.string(), v.parseJson(), proposal), body);
function checkProposal(body: string, bases: (string | undefined)[], secrets: readonly string[]) {
  const result = readProposal(body);
  if (!result.success) return fail('The saved submission is not a valid proposal for this task. Do not discard an uncertain submission.');
  const payload = result.output;
  if (!bases.includes(payload.baseCommit)) fail('The saved submission does not match this task\'s base.');
  const paths = new Set<string>();
  for (const file of payload.files) {
    if (!validPath(file.path) || paths.has(file.path) || (file.mode && file.content === null)) fail(`${file.path} is a protected, repeated or invalid path in the proposal.`);
    paths.add(file.path);
    if (file.content === null) continue;
    const encoded = Buffer.from(file.content, 'utf8');
    if (decodeText(encoded) !== file.content) fail('Only UTF-8 text files can be submitted.');
    assertNoSecrets(`${file.path}\n${file.content}`, secrets, `${file.path} looks like it contains a credential. Remove it before submitting.`);
    if (encoded.length > LIMITS.bytes) fail('Cloudflare Artifacts limits each Git blob to 32 MB.');
  }
  assertSubmittable(payload, secrets);
  return payload;
}

/* ---------- the commands ---------- */

/** The approval for a task's repository, signing in for the person when none is saved. */
async function approved(context: BraidContext, home: string, workspaceId?: string) {
  if (!context.env.BRAID_ACCESS_TOKEN && !savedCredentials(context.env, home).some(saved => (!workspaceId || saved.workspaceId === workspaceId) && Date.parse(saved.expiresAt ?? '') > context.now())) await agentLogin(context, home, { workspace: workspaceId });
  return loadCredentials(context, home, workspaceId);
}
function checkoutCredentials(context: BraidContext, task: Task) {
  const credentials = loadCredentials(context, task.url, task.workspaceId);
  if (credentials.workspaceId !== task.workspaceId) fail('The approved repository does not match this checkout. Connect to the right repository.');
  return credentials;
}
/** The existing task approval, shared with pull-request commands. */
export function taskConnection(context: BraidContext, root: string) { return new Braid(context, checkoutCredentials(context, readTask(root))); }
/** Adds `.braid/` to the checkout's own Git excludes, so task files never show up to be committed. */
function excludeBraid(context: BraidContext, root: string) {
  const path = resolve(root, strict(context, ['rev-parse', '--git-path', 'info/exclude'], { cwd: root }).toString('utf8').trim());
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !lstatSync(path).isFile()) fail('Git\'s exclude file must be a regular file.');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, '\n.braid/\n'); } finally { closeSync(fd); }
}

interface CheckoutInput { url: string; mission: string; agent: string; dir: string; workspace?: string; existing?: boolean; committed?: boolean; single?: boolean }

/** Prepares a checkout for one task: a new directory cloned at the task's base, or with `existing`, a clean checkout at it. */
export async function checkoutTask(context: BraidContext, input: CheckoutInput) {
  const home = normalizeOrigin(input.url);
  const missionId = identifier(input.mission), agentId = identifier(input.agent);
  const requested = resolve(context.cwd, input.dir), dir = join(realpathSync(dirname(requested)), basename(requested));
  const credentials = loadCredentials(context, home, input.workspace);
  if (input.workspace && credentials.workspaceId !== input.workspace) fail('The approved repository does not match this task. Connect to its repository first.');
  if (input.existing) checkoutRoot(context, dir);
  else try { mkdirSync(dir, { mode: 0o700 }); } catch { fail('Checkout needs a NEW directory with an existing parent. No existing directory will be changed.'); }
  const path = `/api/missions/${missionId}/agents/${agentId}/checkout`;
  const response = await send(context, `${home}${path}`, { method: 'POST', body: {}, headers: connection(credentials) });
  if (!response.ok) fail(`Braid did not provide the checkout (HTTP ${response.status}). The new directory can be inspected or removed before retrying.`);
  const details = await checkoutDetails(context, response, home, missionId, agentId, credentials, path);
  const metadata: Task = { url: home, workspaceId: credentials.workspaceId, missionId, agentId, baseCommit: details.baseCommit, scope: details.scope, ...(input.committed ? { submissionMode: 'commits' as const } : {}), ...(details.previousCommit ? { previousCommit: details.previousCommit } : {}) };
  if (details.html_url) metadata.html_url = details.html_url;
  if (input.existing) fetchCommit(context, dir, details.remote, details.baseCommit, details.token);
  else {
    strict(context, ['clone', '--no-checkout', '--no-local', '--template=', '--', details.remote, dir], { token: details.token });
    strict(context, ['checkout', '--detach', '--no-recurse-submodules', metadata.baseCommit, '--'], { cwd: dir });
  }
  const root = checkoutRoot(context, dir);
  pinnedBase(context, root, metadata.baseCommit);
  excludeBraid(context, root);
  privateDirectory(join(root, '.braid'));
  if (existsSync(join(root, '.braid', 'TASK.md'))) fail('An existing .braid/TASK.md would be overwritten. Keep it somewhere else before binding this task.');
  writePrivateJson(taskPath(root), metadata, { exclusive: true });
  writePrivate(join(root, '.braid', 'TASK.md'), brief(context, details, { origin: home, committed: input.committed, single: input.single }), { exclusive: true });
  const revision = details.previousCommit ? ` Proposal ${details.previousCommit} was already submitted; a submission from this checkout replaces it.` : '';
  print(context, `Checkout ready at ${root}${details.html_url ? `\n${details.html_url}` : ''}\nRead .braid/TASK.md and AGENTS.md. Complete the task, run checks, and submit the integrated result.${revision}`);
  return metadata;
}

/** One entry point for starting and returning to a task. It never adopts an unrelated checkout. */
export async function startTask(context: BraidContext, input: { link: string; dir?: string }) {
  const link = taskLink(input.link);
  const dir = resolve(context.cwd, input.dir ?? (existsSync(join(context.cwd, '.git')) ? '.' : `braid-${link.missionId}`));
  let existing: Task | undefined, bind = false;
  if (existsSync(dir)) {
    checkoutRoot(context, dir);
    if (existsSync(join(dir, '.braid'))) realDirectory(join(dir, '.braid'));
    if (!existsSync(taskPath(dir))) bind = true;
    else existing = readTask(dir);
    if (existing && (existing.url !== link.origin || existing.missionId !== link.missionId || (link.workspaceId && existing.workspaceId !== link.workspaceId) || (link.agentId && existing.agentId !== link.agentId))) fail('This directory belongs to a different task. Choose a new --dir.');
    if (existing) pinnedBase(context, dir, existing.acceptedBase, existing.baseCommit);
  }
  const workspace = link.workspaceId ?? existing?.workspaceId;
  let credentials = await approved(context, link.origin, workspace);
  if (workspace && workspace !== credentials.workspaceId) fail('This task belongs to another repository. Connect to that repository, then run start again.');
  if (link.repository) {
    const path = `/api/repos/${link.repository}`;
    const address = await answer(await send(context, `${link.origin}${path}`, { headers: connection(credentials) }), v.object({ workspaceId: id }), { path, secrets: [credentials.accessToken] });
    if (address.workspaceId !== credentials.workspaceId) fail('This task belongs to another repository. Connect to that repository, then run start again.');
  }
  const read = () => send(context, `${link.origin}/api/state`, { headers: connection(credentials) });
  let response = await read();
  if (response.status === 401 && !context.env.BRAID_ACCESS_TOKEN) {
    await agentLogin(context, link.origin, { workspace: credentials.workspaceId });
    credentials = loadCredentials(context, link.origin, credentials.workspaceId);
    response = await read();
  }
  if (!response.ok) fail(`Cannot read the task (HTTP ${response.status}). Check your approved connection.`);
  const task = (await answer(response, missions, { path: '/api/state', secrets: [credentials.accessToken] })).missions.find(item => item.id === link.missionId);
  if (!task || task.execution !== 'local' || task.source !== 'live') fail('No local task was found at this link in the approved repository.');
  const agentId = existing?.agentId ?? link.agentId ?? (task.agents.length === 1 ? task.agents[0].id : undefined);
  if (!agentId) fail('This task has several agents. Use the assigned agent\'s own link from Braid.');
  const agent = task.agents.find(item => item.id === agentId) ?? fail('The requested agent was not found in this task.');
  const page = task.html_url ?? `${link.origin}/${link.repository ? `${link.repository}/` : ''}tasks/${link.missionId}${link.repository ? '' : `?workspace=${encodeURIComponent(credentials.workspaceId)}`}`;
  if (task.status === 'merged' || agent.status === 'merged') { print(context, `This task was merged into main, so there is nothing left to submit. Local files were not changed. ${page}`); return; }
  if (!['running', 'review'].includes(task.status) || agent.status === 'skipped') { print(context, `This task is no longer accepting work. Local files were not changed. ${page}`); return; }
  if (agent.status === 'review' && !existing) {
    // A revision replaces the reviewed proposal, so it must come from the checkout that holds that work.
    print(context, `Proposal ${agent.commit ?? ''} is in review at ${page}. To revise it, run start again from the checkout that submitted it. Nothing was changed here.`);
    return;
  }
  if (bind) {
    const head = strict(context, ['rev-parse', '--verify', 'HEAD'], { cwd: dir }).toString('utf8').trim();
    if (head !== task.baseCommit || strictGit(context, ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir }).stdout.length) fail('Use a clean checkout at the task\'s base, or --dir NEW_DIRECTORY. Existing commits and edits must not become part of a new task.');
  }
  if (existing) await resumeTask(context, { dir });
  else await checkoutTask(context, { url: link.origin, mission: link.missionId, agent: agentId, dir, workspace: credentials.workspaceId, existing: bind, committed: true, single: task.agents.length === 1 });
}

/** Renews the checkout's claim on its task, records Braid's latest proposal for it, and says what to do next. */
export async function resumeTask(context: BraidContext, input: { dir?: string }) {
  const root = checkoutRoot(context, input.dir ?? '.'), task = readTask(root);
  pinnedBase(context, root, task.acceptedBase, task.baseCommit);
  const credentials = checkoutCredentials(context, task);
  const response = await send(context, missionPath(task, 'checkout'), { method: 'POST', body: {}, headers: connection(credentials) });
  if (!response.ok) fail(`Braid did not renew the checkout (HTTP ${response.status}). Check your connection and run resume again.`);
  const details = await checkoutDetails(context, response, task.url, task.missionId, task.agentId, credentials, 'checkout');
  // Until a submission against a fetched main commit is accepted, Braid still reports the earlier base.
  if (!sameScope(details.scope, task.scope) || ![task.baseCommit, task.acceptedBase].includes(details.baseCommit)) fail('Braid\'s answer does not match this checkout\'s base or scope.');
  let next = details.previousCommit === undefined ? { ...task } : withPrevious(task, details.previousCommit);
  if (details.html_url) next.html_url = details.html_url;
  if (details.baseCommit === task.baseCommit) delete next.acceptedBase;
  next = saveTask(root, task, next);
  writePrivate(join(root, '.braid', 'TASK.md'), brief(context, { ...details, baseCommit: next.baseCommit }, { origin: task.url, acceptedBase: next.acceptedBase, committed: task.submissionMode === 'commits' }));
  const pending = receiptStatus(root) === 'pending';
  const guidance = pending ? `A saved submission is unconfirmed; resend it with ${command(context, 'task', 'submit', '--retry', ...checkoutArgs(context, root))} before submitting anything else.`
    : next.acceptedBase ? `Merge or rebase the fetched main commit ${next.baseCommit} into your work, rerun checks, then submit.`
    : next.previousCommit ? `Proposal ${next.previousCommit} is the latest result; submit again from this checkout to revise it.`
    : 'Continue the task, run checks, and submit the result.';
  print(context, `Renewed the checkout for task ${task.missionId}, agent ${task.agentId}. ${guidance}${next.html_url ? `\n${next.html_url}` : ''}`);
  return next;
}

/** Fetches current main for a single-agent task and records it as the next submission's base, leaving branch and files alone. */
export async function updateTask(context: BraidContext, input: { dir?: string }) {
  const root = checkoutRoot(context, input.dir ?? '.'), task = readTask(root);
  pinnedBase(context, root, task.acceptedBase, task.baseCommit);
  const credentials = checkoutCredentials(context, task);
  privateDirectory(join(root, '.braid'));
  return withLock(join(root, '.braid', 'submission.lock'), async () => {
    if (readReceipt(root, task)?.status === 'pending') fail(`An earlier submission has no confirmed result. Resend it with ${command(context, 'task', 'submit', '--retry', ...checkoutArgs(context, root))} before updating; its saved payload is unchanged.`);
    const response = await send(context, missionPath(task, 'update'), { method: 'POST', body: {}, headers: connection(credentials) });
    if (!response.ok) fail(`Braid did not accept the update (HTTP ${response.status}). Retry any unconfirmed submission first; only single-agent tasks can move to a newer main. Local files were not changed.`);
    const details = await checkoutDetails(context, response, task.url, task.missionId, task.agentId, credentials, 'update');
    if (!sameScope(details.scope, task.scope)) fail('Braid\'s answer does not match this checkout\'s scope.');
    fetchCommit(context, root, details.remote, details.baseCommit, details.token);
    if (!hasCommit(context, root, details.baseCommit)) fail('The current main commit could not be fetched. Local files were not changed.');
    const accepted = task.acceptedBase ?? task.baseCommit;
    let next = details.previousCommit === undefined ? { ...task } : withPrevious(task, details.previousCommit);
    if (details.html_url) next.html_url = details.html_url;
    next.baseCommit = details.baseCommit;
    if (details.baseCommit === accepted) delete next.acceptedBase;
    else next.acceptedBase = accepted;
    next = saveTask(root, task, next);
    writePrivate(join(root, '.braid', 'TASK.md'), brief(context, details, { origin: task.url, acceptedBase: next.acceptedBase, committed: task.submissionMode === 'commits', single: true }));
    if (!next.acceptedBase) print(context, `Main is at the accepted base ${next.baseCommit}, so this checkout is current. Local files were not changed.`);
    else {
      const fetched = details.baseCommit === task.baseCommit ? `Main is still at ${next.baseCommit}, which this checkout fetched earlier.` : `Fetched main at ${next.baseCommit} without changing your branch or files.`;
      print(context, `${fetched} Merge or rebase it into this checkout (for example, git merge ${next.baseCommit}), resolve any conflicts, and rerun the repository checks before submitting. Earlier test reports describe the previous base and are not carried over.`);
    }
    if (next.html_url) print(context, next.html_url);
    return next;
  });
}

/** Shares a milestone or blocker on the task; repeating the same message reuses its key, so a retry is never shown twice. */
export async function progressTask(context: BraidContext, input: { dir?: string; message: string }) {
  const root = checkoutRoot(context, input.dir ?? '.'), task = readTask(root), credentials = checkoutCredentials(context, task);
  const body = JSON.stringify({ message: text(input.message, 'progress message', 1200) });
  assertNoSecrets(body, [credentials.accessToken], 'The progress message looks like it contains a credential. Leave secrets out of it.');
  const path = join(root, '.braid', 'progress.json'), target = missionPath(task, 'progress');
  const saved = readPrivateJson(path, v.looseObject({ target: v.optional(v.string()), body: v.optional(v.string()), key: v.optional(v.string()) }), { max: 8192, label: 'Saved progress' });
  const key = saved?.body === body && saved.target === target && saved.key && KEY.test(saved.key) ? saved.key : randomUUID();
  writePrivateJson(path, { target, body, key });
  const response = await send(context, target, { method: 'POST', json: body, headers: { ...connection(credentials), 'idempotency-key': key } });
  if (!response.ok) fail(`Progress was not confirmed (HTTP ${response.status}). Repeat the same command to retry.`);
  const result = await answer(response, v.object({ html_url: v.optional(htmlUrl) }), { path: target, secrets: [credentials.accessToken] });
  print(context, `Progress shared.${result.html_url ? `\n${result.html_url}` : ''}`);
}

/** What to tell an agent whose submission Braid refused, by why it was refused. */
function rejection(context: BraidContext, root: string, status: number, baseCommit: string, task: Task) {
  const run = (...args: string[]) => command(context, 'task', ...args, ...checkoutArgs(context, root));
  const advice = status === 409
    ? baseCommit === (task.acceptedBase ?? task.baseCommit) ? `The task or its latest proposal changed: run ${run('resume')}, then submit again.` : `Main or the latest proposal changed: run ${run('update')}, integrate the fetched main commit, rerun checks and submit again.`
    : status === 413 ? 'The proposal exceeds a size limit.'
    : [401, 403].includes(status) ? `Check access, then run ${command(context, 'task', 'start')} with the task link.`
    : 'Check the patch requirements.';
  return `Braid refused the submission (HTTP ${status}). No proposal was confirmed. ${advice}`;
}

export interface SubmitInput { dependsOn?: (number | string)[]; dir?: string; summary?: string; rationale?: string; model?: string; tests?: string; proof?: boolean; retry?: boolean }

/**
 * Submits the task's result: the complete change from its base, saved with an idempotency key before it is sent so
 * an uncertain answer can be resent exactly. Identical work replays the saved request rather than becoming a new
 * revision, and an unconfirmed submission blocks any other until it is retried.
 */
export async function submitTask(context: BraidContext, input: SubmitInput) {
  if (input.retry && [input.dependsOn, input.summary, input.rationale, input.model, input.tests, input.proof].some(value => value !== undefined)) fail('--retry resends the saved submission exactly; leave out the description, model, tests and proof.');
  const root = checkoutRoot(context, input.dir ?? '.');
  privateDirectory(join(root, '.braid'));
  const task = readTask(root);
  pinnedBase(context, root, task.acceptedBase, task.baseCommit);
  const credentials = checkoutCredentials(context, task), secrets = [credentials.accessToken];
  const run = (...args: string[]) => command(context, 'task', ...args, ...checkoutArgs(context, root));
  const follow = `\nNext, wait until it merges or needs changes:\n  ${run('wait')}`;
  await withLock(join(root, '.braid', 'submission.lock'), async () => {
    let saved = readReceipt(root, task), body: string;
    if (input.retry) body = (saved ?? fail('There is no saved submission to retry.')).body;
    else {
      // New proof never replaces an unconfirmed submission; that one is resent exactly, with its own proof.
      if (input.proof && saved?.status === 'pending') fail(`An earlier submission has no confirmed result. Resend it with its saved proof using ${run('submit', '--retry')}, then submit again.`);
      const proof = input.proof ? readProof(root, secrets) : undefined;
      if (!isAncestor(context, root, task.baseCommit)) fail(task.acceptedBase ? `Merge or rebase the fetched main commit ${task.baseCommit} into this checkout, rerun the checks, then submit.` : 'HEAD must descend from the task\'s base commit. Keep the task\'s history before submitting.');
      const previousCommit = expectedPrevious(task, saved);
      // A revision reuses the latest description for whatever it leaves out.
      const earlier = input.summary === undefined && saved ? readProposal(saved.body) : undefined;
      const described = earlier?.success ? earlier.output : undefined;
      if (input.summary === undefined && !described) fail('Describe the result with --summary.');
      const summary = input.summary ?? described!.summary, model = input.model ?? described?.model;
      const payload: Proposal = {
        ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
        baseCommit: task.baseCommit, previousCommit, summary: text(summary, 'summary', 1200), rationale: text(input.rationale ?? described?.rationale ?? summary, 'rationale', 6000),
        ...(model ? { model: text(model, 'model', 120) } : {}),
        files: collectProposal(context, root, task.baseCommit, secrets, task.submissionMode === 'commits'),
        ...(input.tests ? { tests: readTests(context, input.tests) } : {}),
      };
      if (proof) {
        const evidence = await runProof(context, root, proof, secrets);
        if (evidence.length) payload.evidence = evidence;
      }
      body = JSON.stringify(payload);
      // Identical work resends or replays the saved request instead of becoming a new revision.
      if (saved && saved.body !== body && sameWork(saved.body, body) && (saved.status === 'pending' || (saved.status === 'complete' && saved.commit === previousCommit))) body = saved.body;
      if (saved?.status === 'pending' && saved.body !== body) fail(`An earlier submission has no confirmed result. Resend its exact saved payload with ${run('submit', '--retry')}; current edits will not be sent.`);
    }
    const payload = checkProposal(body, [task.baseCommit, task.acceptedBase], secrets);
    if (saved?.status === 'complete' && saved.body === body) { print(context, `Previously submitted proposal ${saved.commit} for review. Tests are agent-reported and unverified.${saved.html_url ? `\n${saved.html_url}` : ''}${follow}`); return; }
    const uncertain = saved?.status === 'pending';
    if (!saved || saved.body !== body) {
      if (saved) archiveReceipt(root, saved);
      saved = { url: task.url, workspaceId: task.workspaceId, missionId: task.missionId, agentId: task.agentId, key: randomUUID(), body, status: 'pending' };
    }
    const pending: Receipt = { ...saved, status: 'pending' };
    const journal = join(root, '.braid', 'submission.json');
    writePrivateJson(journal, pending);
    const sent = async () => {
      try { return await send(context, missionPath(task, 'submit'), { method: 'POST', json: pending.body, timeout: 180_000, headers: { ...connection(credentials), 'idempotency-key': pending.key } }); }
      catch (error) { if (error instanceof CliError) fail(`The submission's outcome is uncertain. Resend the saved payload and key with ${run('submit', '--retry')}.`); throw error; }
    };
    let response = await sent();
    if (response.status === 403) {
      // A valid week-long connection can renew its shorter task claim; the saved body and key stay the same.
      try { await resumeTask(context, { dir: root }); response = await sent(); }
      catch (error) { if (error instanceof CliError) fail(`Task access could not be renewed. Run ${command(context, 'task', 'start')} with the task link, then ${run('submit', '--retry')}. The saved submission is kept.`); throw error; }
    }
    if (!response.ok) {
      // A first attempt Braid refused was never applied; an earlier uncertain attempt still might have been.
      if (!uncertain && [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(response.status)) {
        writePrivateJson(journal, { ...pending, status: 'rejected' });
        fail(rejection(context, root, response.status, payload.baseCommit, task));
      }
      fail(`The submission is unconfirmed (HTTP ${response.status}). Resend the saved payload and key with ${run('submit', '--retry')}.`);
    }
    let result;
    try { result = await answer(response, v.object({ commit, html_url: v.optional(htmlUrl) }), { path: 'submit', secrets }); } catch { return fail(`The submission's outcome is uncertain. Resend the saved payload and key with ${run('submit', '--retry')}.`); }
    // Record the accepted proposal before its receipt; an interrupted run still holds a pending receipt to retry.
    const current = readTask(root), accepted = withPrevious(current, result.commit);
    if (payload.baseCommit === current.baseCommit) delete accepted.acceptedBase;
    saveTask(root, current, accepted);
    writePrivateJson(journal, { ...pending, status: 'complete', commit: result.commit, html_url: result.html_url });
    const replaced = payload.previousCommit ? `, replacing ${payload.previousCommit}` : '';
    print(context, `Submitted proposal ${result.commit} for review${replaced}. Tests are agent-reported and unverified.${result.html_url ? `\n${result.html_url}` : ''}${follow}`);
  });
}

/** Waits for what this checkout's task became: the change its result opened once the repository lands it through the queue. */
export async function waitTask(context: BraidContext, input: { dir?: string; timeout: number }) {
  const root = checkoutRoot(context, input.dir ?? '.'), task = readTask(root);
  const braid = new Braid(context, checkoutCredentials(context, task));
  await poll(context, input.timeout, async late => {
    const [latest] = (await braid.get(`/api/changes?task=${encodeURIComponent(task.missionId)}&limit=5`, changePage)).items;
    if (latest) {
      const change = await braid.get(`/api/changes/${latest.id}`, changeSchema);
      if (settled(change.status) || late()) { print(context, describeChange(change, braid.secrets) + nextStep(context, change, { root, origin: task.url, task: true })); return true; }
    } else if (late()) {
      print(context, `No change yet. The task becomes a change once its result is submitted and the repository lands through its queue; otherwise the owner lands it in Braid.${task.html_url ? `\n${task.html_url}` : ''}`);
      return true;
    }
    return false;
  });
}

/** Whether `root` is a task checkout, so branch commands can point there instead. */
export const isTaskCheckout = (root: string) => existsSync(taskPath(root));
