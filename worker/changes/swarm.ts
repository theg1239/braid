import { DurableObject } from 'cloudflare:workers';
import { artifactsOf, type BraidEnv } from '../env';
import type { ChangeCounts, ProvenanceOwner, SwarmRun, SwarmScenario } from '../../shared/types';
import { HttpError, ShownError, logFailure, refused, unwrap, type Result } from '../errors';
import { TreeSnapshot } from '../repositories/compose';
import { ObjectCache } from './cache';
import { CHANGE_SHARDS, changeShardOf, submissionShard, trunkOf } from './names';
import { SCAFFOLD, SCENARIO_PATHS, swarmEdit } from './scenario';
import type { Actor } from './shard';
import { now } from '../workspace/domain';

// Simulated agents keep rebasing like real ones; on a single contested line, the last one needs a turn per earlier agent.
const WAVE = 40, MAX_ATTEMPTS = 50, TICK = 400;
const empty = (): ChangeCounts => ({ open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 });

/**
 * Runs simulated agents against a live repository through the same change
 * store, reviewers, policy and landing queue that real agents use. Only the
 * edits are synthetic, and every simulated change is labelled as such.
 */
export class Swarm extends DurableObject<BraidEnv> {
  private cache: ObjectCache;
  private ticking = false;
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS agents (run_id TEXT NOT NULL, idx INTEGER NOT NULL, change_id TEXT NOT NULL, shard INTEGER NOT NULL, revision INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY (run_id, idx))');
    this.cache = new ObjectCache(ctx.storage.sql);
  }
  private latest(): SwarmRun | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM runs ORDER BY started_at DESC LIMIT 1').toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private save(run: SwarmRun) { this.ctx.storage.sql.exec('INSERT INTO runs (id, started_at, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', run.id, run.startedAt, JSON.stringify(run)); }
  /**
   * A simulated agent goes by its model, `simulated`, and a short session that tells it from the others; the person
   * who started the run owns its work.
   */
  private actor(run: SwarmRun, index: number, owner?: ProvenanceOwner): Actor {
    const session = index < 0 ? 'setup' : `s${String(index).padStart(4, '0')}`;
    return { kind: 'agent', id: `sim:${run.id}:${index}`, name: `Simulated ${session}`, model: 'simulated', simulated: true, ...(owner ? { owner } : {}) };
  }
  private owner(run: SwarmRun): Promise<ProvenanceOwner | undefined> { return this.ctx.storage.get<ProvenanceOwner>(`owner:${run.id}`); }

  async start(key: string, input: { agents: number; scenario: SwarmScenario }, startedBy: string, owner?: ProvenanceOwner): Promise<Result<SwarmRun>> {
    try { return { ok: true, data: await this.begin(key, input, startedBy, owner) }; }
    catch (error) { return refused(error); }
  }
  private async begin(key: string, input: { agents: number; scenario: SwarmScenario }, startedBy: string, owner?: ProvenanceOwner): Promise<SwarmRun> {
    const queue = await trunkOf(this.env, key).status(key);
    const current = this.latest();
    if (current && (current.status === 'preparing' || current.status === 'running')) throw new HttpError(409, 'A simulation is already running in this repository.');
    if (!queue.enabled || queue.paused) throw new HttpError(409, 'Turn on landing before simulating agents; their changes land through the queue.');
    const run: SwarmRun = { id: `sw${Date.now().toString(36)}`, repository: key, scenario: input.scenario, agents: input.agents, seed: Math.floor(Math.random() * 1e9), startedAt: now(), startedBy,
      status: 'preparing', launched: 0, revisions: 0, counts: empty() };
    this.save(run);
    if (owner) await this.ctx.storage.put(`owner:${run.id}`, owner);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return run;
  }

  async status(): Promise<SwarmRun | null> { return this.latest() ?? null; }

  async stop(actor: string): Promise<SwarmRun | null> {
    const run = this.latest();
    if (!run || (run.status !== 'preparing' && run.status !== 'running')) return run ?? null;
    run.status = 'stopped'; run.finishedAt = now(); run.note = `Stopped by ${actor}. Submitted changes continue through the queue.`;
    this.save(run);
    return run;
  }

  async alarm() {
    if (this.ticking) return;
    this.ticking = true;
    let again = false;
    try { again = await this.tick(); }
    catch (error) {
      const run = this.latest();
      if (run && (run.status === 'running' || run.status === 'preparing')) {
        run.failures = (run.failures ?? 0) + 1;
        run.note = 'The simulation is retrying after a temporary error.';
        if (run.failures > 20) { run.status = 'stopped'; run.finishedAt = now(); run.note = 'The simulation stopped after repeated errors. Submitted changes continue through the queue.'; }
        this.save(run);
        again = run.status !== 'stopped';
      }
      logFailure('swarm_tick_failed', error);
    } finally { this.ticking = false; }
    if (again) await this.ctx.storage.setAlarm(Date.now() + TICK);
  }

  private async files(key: string): Promise<{ head: string; files: Record<string, string | null> }> {
    const repository = await this.env.WORKSPACES.getByName(key).repository();
    if (!repository) throw new ShownError('The repository is not available.');
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const head = (await artifacts.log({ ref: repository.branch, limit: 1 }))[0]?.hash;
    if (!head) throw new ShownError('Trunk is not available.');
    const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
    const files: Record<string, string | null> = {};
    for (const path of SCENARIO_PATHS) {
      const version = await snapshot.version(head, path);
      files[path] = version.kind === 'file' ? await snapshot.text(version) : null;
    }
    return { head, files };
  }

  private async submit(key: string, run: SwarmRun, owner: ProvenanceOwner | undefined, index: number, attempt: number, head: string, files: Record<string, string | null>, previous?: { changeId: string; shard: number; revision: number }) {
    const actor = this.actor(run, index, owner);
    const edit = index < 0
      ? { title: 'Prepare shared files for simulated agents', summary: 'Creates the shared files simulated agents edit concurrently.', files: Object.entries(SCAFFOLD).filter(([path]) => files[path] === null).map(([path, content]) => ({ path, content })) }
      : swarmEdit(run.scenario, index, run.seed, attempt, files);
    const requestKey = `swarm-${run.id}-${index < 0 ? 'setup' : index}-${attempt}`;
    const body = { title: edit.title, summary: edit.summary, baseCommit: head, files: edit.files, model: 'simulated', agent: { session: `${run.id}-${index < 0 ? 'setup' : index}` }, ...(previous ? { previousRevision: previous.revision } : {}) };
    if (previous) {
      const result = await changeShardOf(this.env, key, previous.shard).revise({ repository: key, shard: previous.shard, actor }, previous.changeId, body, requestKey);
      // The change moved on (it is landing or was closed) since it was listed.
      if (!result.ok && result.status === 409) return null;
      const { id, revision } = unwrap(result);
      return { changeId: id, shard: previous.shard, revision };
    }
    const shard = submissionShard(`${actor.id}:${requestKey}`);
    const { id, revision } = unwrap(await changeShardOf(this.env, key, shard).submit({ repository: key, shard, actor }, body, requestKey));
    return { changeId: id, shard, revision };
  }

  /** One step of the simulation. Returns true while there is more to do. */
  private async tick(): Promise<boolean> {
    const run = this.latest();
    if (!run || (run.status !== 'preparing' && run.status !== 'running')) return false;
    const key = run.repository;
    const prefix = `sim:${run.id}:`;
    const owner = await this.owner(run);
    const { head, files } = await this.files(key);
    if (run.status === 'preparing') {
      if (SCENARIO_PATHS.every(path => files[path] !== null)) { run.status = 'running'; run.preparedAt = now(); }
      else if (!run.setup) run.setup = await this.submit(key, run, owner, -1, 0, head, files) ?? undefined;
      this.save(run);
      if (run.status === 'preparing') return true;
    }
    // Simulated agents whose changes were sent back redo their work on current trunk.
    const sentBack = (await Promise.all(Array.from({ length: CHANGE_SHARDS }, (_, shard) => changeShardOf(this.env, key, shard).sentBack(prefix, 20)))).flat();
    for (const change of sentBack.slice(0, WAVE)) {
      const index = Number(change.authorId.slice(prefix.length));
      const row = this.ctx.storage.sql.exec<{ attempts: number }>('SELECT attempts FROM agents WHERE run_id = ? AND idx = ?', run.id, index).toArray()[0];
      const attempts = (row?.attempts ?? 0) + 1;
      if (attempts > MAX_ATTEMPTS) {
        await changeShardOf(this.env, key, change.shard).close({ repository: key, shard: change.shard, actor: this.actor(run, index, owner) }, change.changeId, { reason: 'abandoned' });
        continue;
      }
      const revised = await this.submit(key, run, owner, index, attempts, head, files, { changeId: change.changeId, shard: change.shard, revision: change.revision });
      if (!revised) continue;
      this.ctx.storage.sql.exec('UPDATE agents SET revision = ?, attempts = ? WHERE run_id = ? AND idx = ?', revised.revision, attempts, run.id, index);
      run.revisions++;
    }
    // New agents arrive in waves, all starting from the same trunk, as real fleets do.
    const launch = Math.min(WAVE, run.agents - run.launched);
    const launched = await Promise.all(Array.from({ length: launch }, (_, offset) => run.launched + offset).map(async index => ({ index, change: await this.submit(key, run, owner, index, 0, head, files) })));
    for (const { index, change } of launched) if (change) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO agents (run_id, idx, change_id, shard, revision, attempts) VALUES (?, ?, ?, ?, ?, 0)', run.id, index, change.changeId, change.shard, change.revision);
    run.launched += launch;
    const counts = empty();
    for (const shardCounts of await Promise.all(Array.from({ length: CHANGE_SHARDS }, (_, shard) => changeShardOf(this.env, key, shard).authorCounts(prefix))))
      for (const [status, count] of Object.entries(shardCounts)) counts[status as keyof ChangeCounts] += count;
    run.counts = counts;
    const active = counts.open + counts.revise + counts.attention + counts.queued + counts.landing;
    if (run.launched >= run.agents && !active && this.latest()?.status === 'running') {
      run.status = 'finished'; run.finishedAt = now();
      run.note = `${counts.landed} simulated changes landed; ${run.revisions} revisions after conflicts or review.`;
    }
    if (this.latest()?.status === 'stopped') return false;
    this.save(run);
    return run.status === 'running';
  }
}

