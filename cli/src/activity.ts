import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { LocalActivityBatch, LocalActivityEvent } from '../../shared/agent-activity';
import { safeActivityIdentity } from '../../shared/activity-privacy';
import { retryAfter } from './api';
import { loadCredentials, normalizeOrigin, privateDirectory, readPrivateJson, resolveOrigin, savedCredentials, writePrivateJson } from './config';
import { CliError, type BraidContext } from './context';
import { braidRemote, branchFiles, currentRemote, processAlive, readState, withLock, type Repository } from './repository';
import { currentBranch, gitPath } from './git';
import { activityModel, hookModel, hookObservation } from './activity-hooks';

const text = v.pipe(v.string(), v.maxLength(240));
const eventSchema = v.object({ id: text, sequence: v.number(), at: text,
  source: v.picklist(['process', 'claude-hook', 'codex-notify', 'git']), kind: v.picklist(['started', 'working', 'editing', 'command', 'waiting', 'finished', 'failed', 'commit']),
  path: v.optional(text), command: v.optional(text), exitCode: v.optional(v.number()), commit: v.optional(text), completed: v.optional(v.boolean()),
});
const metadataSchema = v.object({ origin: text, workspaceId: text, session: text, root: v.string(), branch: v.nullable(v.string()), pid: v.number(),
  tool: v.optional(text), model: v.optional(text), changeId: v.optional(text), changeNumber: v.optional(v.number()), changeUrl: v.optional(v.string()), closed: v.optional(v.boolean()),
});
type Metadata = v.InferOutput<typeof metadataSchema>;
const stateSchema = v.object({ retryAt: v.number(), attempts: v.number(), lastError: v.optional(text), sentChange: v.optional(text), heartbeat: v.optional(v.number()) });
const ack = v.object({ accepted: v.array(v.string()) });
const emptyState: v.InferOutput<typeof stateSchema> = { retryAt: 0, attempts: 0 };
const activityFolder = (context: BraidContext, root: string) => gitPath(context, root, 'braid/activity');
const metadata = (folder: string) => readPrivateJson(join(folder, 'run.json'), metadataSchema);
const delivery = (folder: string) => readPrivateJson(join(folder, 'delivery.json'), stateSchema) ?? emptyState;
const pending = (folder: string) => readdirSync(folder).filter(name => /^event-[A-Za-z0-9_-]+\.json$/.test(name));
const runs = (folder: string) => existsSync(folder) ? readdirSync(folder).filter(name => /^s_[A-Za-z0-9_-]+$/.test(name)).map(name => join(folder, name)) : [];

export function queueActivity(folder: string, event: Omit<LocalActivityEvent, 'id' | 'at' | 'sequence'>, now = Date.now()) {
  const id = randomUUID();
  const observed: LocalActivityEvent = { ...event, id, at: new Date(now).toISOString(), sequence: now * 1000 + Math.floor(Math.random() * 1000) };
  writePrivateJson(join(folder, `event-${id}.json`), observed, { exclusive: true });
  return observed;
}

/** This is deliberately local-only; launching the agent never waits for a network request. */
export function beginActivity(context: BraidContext, repository: Repository, session: string, model?: string, tool?: string) {
  const origin = resolveOrigin(context, repository.link);
  const workspaceId = repository.link?.workspaceId ?? context.env.BRAID_WORKSPACE_ID;
  if (!workspaceId) throw new CliError('Run braid init to link this checkout before reporting activity.');
  if (context.env.BRAID_WORKSPACE_ID && context.env.BRAID_WORKSPACE_ID !== workspaceId) throw new CliError(`Wrong repository in BRAID_WORKSPACE_ID. Unset it and run braid init --workspace ${workspaceId}.`);
  const expected = braidRemote(origin, workspaceId), remote = currentRemote(context, repository.root);
  if (remote !== undefined && remote !== expected) throw new CliError(`Wrong braid remote. Run git remote set-url braid ${expected}, then braid init.`);
  const folder = privateDirectory(join(privateDirectory(activityFolder(context, repository.root)), session));
  const state = readState(repository.root, branchFiles(context, repository.root));
  const linked = state?.origin === origin && state.workspaceId === workspaceId && state.change && !['landed', 'closed'].includes(state.change.status) ? state.change : undefined;
  const run: Metadata = { origin: normalizeOrigin(origin), workspaceId, root: repository.root, session, branch: currentBranch(context, repository.root) ?? null, pid: process.pid,
    ...(model && v.is(activityModel, model) ? { model } : {}), ...(tool && safeActivityIdentity(tool) ? { tool } : {}), ...(linked ? { changeId: linked.id, changeNumber: linked.number, changeUrl: linked.html_url } : {}) };
  writePrivateJson(join(folder, 'run.json'), run);
  queueActivity(folder, { source: 'process', kind: 'started' }, context.now());
  let error: string | undefined;
  try { loadCredentials(context, origin, workspaceId); } catch (reason) { error = reason instanceof CliError ? reason.message : 'Run braid login to connect.'; }
  return { folder, run, error };
}

export function finishActivity(folder: string, exitCode: number, now = Date.now()) {
  queueActivity(folder, { source: 'process', kind: exitCode === 0 ? 'finished' : 'failed', exitCode }, now);
  const run = metadata(folder);
  if (run) writePrivateJson(join(folder, 'run.json'), { ...run, closed: true });
}

/** One bounded batch per run every two seconds. Acked files alone are removed, including after an uncertain retry. */
export async function flushActivity(context: BraidContext, folder: string, force = false) {
  const run = metadata(folder);
  if (!run) return false;
  const state = delivery(folder), now = context.now();
  if (!force && state.retryAt > now) return true;
  const active = !run.closed && processAlive(run.pid);
  const candidates = pending(folder).map(file => ({ file, event: readPrivateJson(join(folder, file), eventSchema, { max: 2048 })! })).sort((a, b) => a.event.sequence - b.event.sequence).slice(0, 40);
  // A path can contain multibyte characters: bound bytes as well as event count, leaving room for metadata.
  const files: typeof candidates = []; let bytes = 0;
  for (const item of candidates) {
    const size = Buffer.byteLength(JSON.stringify(item.event)) + 1;
    if (bytes + size > 28_000) break;
    files.push(item); bytes += size;
  }
  const attachment = !!run.changeId && state.sentChange !== run.changeId;
  if (!files.length && !attachment && (!active || now - (state.heartbeat ?? 0) < 15_000)) return active;
  const model = readPrivateJson(join(folder, 'model.json'), v.object({ model: activityModel }))?.model ?? run.model;
  const body: LocalActivityBatch = { session: run.session, model, tool: run.tool, changeId: run.changeId, active, events: files.map(item => item.event) };
  let wait = 0;
  try {
    const credentials = loadCredentials(context, run.origin, run.workspaceId);
    if (credentials.workspaceId !== run.workspaceId) throw new CliError('Wrong repository connection. Unset BRAID_WORKSPACE_ID and run braid login.');
    const response = await context.fetch(`${run.origin}/api/local-activity`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { authorization: `Bearer ${credentials.accessToken}`, 'x-braid-workspace': run.workspaceId, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    wait = retryAfter(response.headers.get('retry-after'), now);
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError(response.status === 401 ? 'Connection expired or revoked; run braid login. Work continues and events are queued.'
        : response.status === 403 ? 'Connection cannot report to this repository; run braid login and choose this repository. Events are queued.'
        : response.status === 400 || response.status === 413 ? 'Braid rejected the activity format. Update braid; events remain queued.'
        : 'Braid is unavailable. Work continues and events are queued.');
    }
    const parsed = v.safeParse(ack, await response.json());
    if (!parsed.success) throw new CliError('Braid did not acknowledge activity. Work continues and events are queued.');
    const accepted = new Set(parsed.output.accepted);
    for (const item of files) if (accepted.has(item.event.id)) rmSync(join(folder, item.file), { force: true });
    writePrivateJson(join(folder, 'delivery.json'), { retryAt: now + 2000, attempts: 0, heartbeat: now, ...(run.changeId ? { sentChange: run.changeId } : {}) });
    return active || pending(folder).length > 0;
  } catch (error) {
    const lastError = error instanceof CliError ? error.message : 'Braid is unavailable. Work continues and events are queued.';
    const delay = Math.max(wait, Math.min(60_000, 2000 * 2 ** Math.min(state.attempts, 5)));
    writePrivateJson(join(folder, 'delivery.json'), { ...state, attempts: state.attempts + 1, retryAt: now + delay, lastError: lastError.slice(0, 240) });
    return true;
  }
}

/** Detached from the agent's terminal; a short per-checkout lock prevents duplicate senders. */
export function startActivityUpload(context: BraidContext, root: string) {
  if (!context.script) return;
  const child = spawn(process.execPath, [context.script, 'hook', 'upload', root], { cwd: root, env: { ...context.env }, detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // The queue stays on disk for the next command to send.
  child.unref();
}
export async function uploadActivity(context: BraidContext, root: string) {
  const folder = activityFolder(context, root);
  if (!existsSync(folder)) return;
  try {
    await withLock(join(folder, 'upload.lock'), async () => {
      // Exit once every wrapped process has ended and its queue is acknowledged. Long runs and outages keep retrying.
      for (;;) {
        let keep = false;
        for (const run of runs(folder)) keep = await flushActivity(context, run) || keep;
        if (!keep) break;
        await context.sleep(2000);
      }
    });
  } catch { /* A sender already owns the queue, or it remains intact for the next command. */ }
}

/** A hook only reduces and spools data; it never talks to Braid or influences the tool. */
export async function recordActivityHook(context: BraidContext, source: string, payload?: string) {
  try {
    const folder = context.env.BRAID_ACTIVITY_DIR;
    if (!folder) return;
    const run = metadata(folder);
    if (!run) return;
    const raw = payload ?? await context.input();
    if (Buffer.byteLength(raw) > 1_048_576) return;
    const parsed: unknown = JSON.parse(raw);
    const model = source === 'claude' ? hookModel(parsed) : undefined;
    if (model) writePrivateJson(join(folder, 'model.json'), { model });
    const observation = hookObservation(parsed, run.root, source === 'claude' ? 'claude-hook' : 'codex-notify');
    if (observation) queueActivity(folder, observation, context.now());
  } catch { /* Fail open: telemetry cannot interrupt the coding agent. */ }
}

export function attachActivity(context: BraidContext, root: string, origin: string, workspaceId: string, change: { id: string; number: number; html_url?: string }) {
  try {
    const branch = currentBranch(context, root) ?? null;
    for (const folder of runs(activityFolder(context, root))) {
      const run = metadata(folder);
      if (!run || run.origin !== origin || run.workspaceId !== workspaceId || run.branch !== branch || (run.changeId && run.changeId !== change.id)) continue;
      writePrivateJson(join(folder, 'run.json'), { ...run, changeId: change.id, changeNumber: change.number, changeUrl: change.html_url });
    }
    startActivityUpload(context, root);
  } catch { /* A successful submission stays successful even when local telemetry is unavailable. */ }
}

export function activityStatus(context: BraidContext, repository: Repository) {
  const entries = runs(activityFolder(context, repository.root)).map(folder => ({ folder, run: metadata(folder), state: delivery(folder), count: pending(folder).length }));
  let origin: string | undefined, workspaceId = repository.link?.workspaceId ?? context.env.BRAID_WORKSPACE_ID;
  try { origin = resolveOrigin(context, repository.link); } catch (error) { if (!(error instanceof CliError)) throw error; /* Not signed in: status says disconnected. */ }
  const credentials = origin ? savedCredentials(context.env, origin).find(value => value.workspaceId === workspaceId) : undefined;
  const selected = entries.filter(item => item.run && item.run.origin === origin && item.run.workspaceId === workspaceId);
  return { origin, workspaceId, expiry: credentials?.expiresAt, queued: selected.reduce((total, item) => total + item.count, 0), lastError: selected.findLast(item => item.state.lastError)?.state.lastError,
    connected: !!context.env.BRAID_ACCESS_TOKEN || !!(credentials?.expiresAt && Date.parse(credentials.expiresAt) > context.now()) };
}
