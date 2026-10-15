import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { artifactsOf, directoryOf, type BraidEnv } from '../env';
import type { AgentReport, BatchSummary, ChangeAuthor, ChangeCheck, ChangeConflict, ChangeReview, FileBlame, GitHubLinkStatus, Instruction, LandingStrategy, Provenance, TrunkStatus } from '../../shared/types';
import { NOTES_REF } from '../../shared/provenance';
import { commitMessage, githubByline, gitAuthor, publicAuthor } from '../repositories/provenance';
import type { AgentLineTotals } from './file-lines';
import { POLICY_PATH, type Policy } from '../../shared/policy';
import { plural, reviewerName } from '../../shared/labels';
import { parsePolicy } from '../../shared/policy-file';
import { INSTRUCTIONS_PATH, parseInstructions } from '../../shared/instructions-file';
import { ContentStore } from '../workspace/content';
import { composeChanges, TreeSnapshot, type ComposedChange } from './compose';
import type { CommitSpec } from '../git/push';
import { checkAuthorization, type Authorization } from '../http/authorization';
import { advertisement, GitError, relay, updateRef, ZERO, type GitEndpoint } from '../git/transport';
import { closePullRequest, failedChecks, githubEndpoint, installationToken, mergePullRequest, openPullRequest, pullRequestGate, requestReviewers, type GitHubGate, type GitHubLink } from '../github/bridge';
import { githubApi } from '../github/client';
import { waitForPublicReads } from '../http/public-access';
import { HttpError, logFailure, refusal, refused, unwrap, shown, type Refusal, type Result } from '../errors';
import type { VerifiedCheck, VerifyJob, VerifyResult } from '../agents/runner';
import { digest, equalSecret, mac } from '../http/auth';
import { ciPayload, validHookUrl, type CiStatus, type Hook, type HookDelivery } from './ci';
import { ciStatus, githubVisibility, parseFrom, verificationResult } from '../schemas';
import { ObjectCache } from './cache';
import { changeShardOf, runnerName, shardOf } from './names';
import type { AgentSandbox } from '../agents/sandbox';
import type { LandingPatch, RepositoryInfo } from './shard';
import type { CommandRun } from './evidence';
import { StackGraph, type StackNode } from './stacks';
import { AgentReportStore } from '../agents/reports';
import { LocalActivityStore } from './local-activity';
import type { LocalActivityBatch, LocalActivityRun } from '../../shared/agent-activity';
import { Attribution } from './attribution';
import { now } from '../workspace/domain';
import { Meta } from '../sql';
import type { GitHubEvent } from '../github/webhook';

interface QueueEntry { changeId: string; shard: number; number: number; revision: number; title: string; author?: string }
interface LandingSettings { enabled: boolean; authorization?: Authorization; by?: string; since?: string; paused?: string }
interface PlanEntry {
  changeId: string; shard: number; number: number; revision: number; title: string; author: string; summary: string; paths: string[]; commit: number | null; strategies: Record<string, LandingStrategy>;
  /** Who made the change and who approved it, for its commit's note and Braid's record; plans saved before Braid kept them have none. */
  who?: { author: ChangeAuthor; fileAuthors?: Record<string, ChangeAuthor>; taskId?: string; approvedBy: string };
}
interface Plan { batchId: string; head: string; prepared?: string[]; entries: PlanEntry[] }
type Row = { change_id: string; shard: number; number: number; revision: number; title: string; attempts: number; author: string; enqueued_at: number };
type GateState = 'pending' | 'passed' | 'failed' | 'error';
/** A composed batch on a staging branch, waiting for its gates before trunk moves. */
interface Verifying {
  batch: BatchSummary; base: string; tip: string; staging: string; plan: Plan; retries: number; startedAt: number;
  runner?: { job: VerifyJob; state: GateState; result?: VerifyResult };
  github?: { pr: number; url: string; branch: string; openedAt: number; polledAt: number; state: GitHubGate['state']; reason: string; gate?: GitHubGate; reviewers?: string[]; wait?: number };
  /** The repository's own CI, told through the merge_group webhook and answering with statuses. */
  ci?: { required: string[]; statuses: Record<string, CiStatus>; startedAt: number; minutes: number; timedOut?: boolean };
}
interface LinkState { link: GitHubLink; mirroredHead?: string; status: GitHubLinkStatus['status']; message?: string; checkedAt?: string; notes?: string }

const MAX_BATCH = 64;
const RECENT_BATCHES = 50;
const GITHUB_POLL = 20_000;
/** A compare-and-swap that lost to another write: compose again on the new head. */
const moved = (error: unknown) => error instanceof GitError && (error.code === 'moved' || error.code === 'rejected');
export const STORAGE_FULL = 'Cloudflare Artifacts limits each repository to 1 GB. This repository is full, so merging is paused. Every change stays queued; resume once the repository has room.';
const named = (entries: { changeId: string; number: number }[]) => entries.map(({ changeId, number }) => ({ changeId, number }));

/**
 * The landing pull request's description: each change linked to Braid, where it lives (a bare `#n` on GitHub would
 * point at GitHub's own pull requests), and who made it, as a model for its owner or a person.
 */
function pullRequestBody(plan: Plan, base: string, origin: string) {
  const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const change = (entry: PlanEntry) => origin ? `[#${entry.number}](${origin}/pull/${entry.number})` : `\`#${entry.number}\``;
  return [
    `Braid's merge queue combined ${plural(plan.entries.length, 'change')} on \`${base.slice(0, 12)}\`. Each passed its Braid rules, secret scanning and dependency review (OSV.dev); this pull request lets this repository's checks, review apps and branch rules judge the combined result.`,
    '',
    '| Change | Author | Summary | Merged with concurrent work |',
    '| --- | --- | --- | --- |',
    ...plan.entries.map(entry => {
      const merged = Object.entries(entry.strategies).filter(([, strategy]) => strategy !== 'fast-forward' && strategy !== 'already-applied');
      return `| ${change(entry)} ${escape(entry.title)} | ${escape(entry.who ? githubByline(entry.who.author) : entry.author)} | ${escape(entry.summary.slice(0, 160))} | ${merged.length ? merged.slice(0, 4).map(([path, strategy]) => `\`${escape(path)}\` (${strategy})`).join(', ') : '—'} |`;
    }),
    '',
    'Braid merges this pull request when GitHub allows it. If a check fails, Braid narrows the failure to the responsible change and sends that change back to its author; review comments are routed to the changes that touched the commented files.',
  ].join('\n');
}

/**
 * The landing queue for one repository's trunk. It composes queued changes in
 * order onto the current head with a three-way merge, ejects only changes that
 * truly conflict, and lands the rest with compare-and-swap so a moved trunk
 * means composing again, never overwriting. Batches can first pass gates: the
 * repository's own checks in a Cloudflare container, and GitHub's checks,
 * review apps and branch protection on a landing pull request.
 */
export class Trunk extends DurableObject<BraidEnv> {
  private graph: StackGraph;
  private meta: Meta;
  private stackBases = new Map<string, Promise<string>>();
  private cache: ObjectCache;
  private content: ContentStore;
  private attribution: Attribution;
  private reports: AgentReportStore;
  private activity: LocalActivityStore;
  private processing = false;
  private landing?: BatchSummary;
  private landingIds = new Set<string>();
  private policyCache?: { head: string; policy: Policy; errors: string[]; instructions: { instructions: Instruction[]; errors: string[] } };
  private headCache?: { at: number; head: string };
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.graph = new StackGraph(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS queue (change_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, shard INTEGER NOT NULL, number INTEGER NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL DEFAULT '')");
    // Outcomes per author: unattended landing is earned, and daily caps bound any one author.
    sql.exec("CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, landed INTEGER NOT NULL DEFAULT 0, sent_back INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', landed_today INTEGER NOT NULL DEFAULT 0)");
    sql.exec('CREATE INDEX IF NOT EXISTS queue_order ON queue(seq)');
    sql.exec('CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL)');
    this.meta = new Meta(sql);
    sql.exec('CREATE TABLE IF NOT EXISTS number_blocks (start INTEGER PRIMARY KEY, end INTEGER NOT NULL, shard INTEGER NOT NULL)');
    // The change shards that hold any change, so a list asks only them; complete once `shards-recorded` is set.
    sql.exec('CREATE TABLE IF NOT EXISTS change_shards (shard INTEGER PRIMARY KEY)');
    // Changes the queue let go of whose shard could not be told yet; retried until they arrive.
    sql.exec('CREATE TABLE IF NOT EXISTS outbox (change_id TEXT NOT NULL, revision INTEGER NOT NULL, shard INTEGER NOT NULL, value TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, PRIMARY KEY (change_id, revision))');
    this.content = new ContentStore(ctx.storage);
    this.cache = new ObjectCache(sql);
    this.attribution = new Attribution(ctx, env, this.meta, this.cache, {
      repository: key => this.repository(key), head: (artifacts, repository, maxAge) => this.head(artifacts, repository, maxAge),
      endpoint: (artifacts, repository, scope) => this.artifactsEndpoint(artifacts, repository, scope),
      bind: key => this.bind(key), requirePublicBuild: network => this.requirePublicBuild(network), githubLink: () => this.linkState()?.link,
    });
    // Agent feedback uses only this repository's local storage, never its Git or queue.
    this.reports = new AgentReportStore(ctx.storage);
    this.activity = new LocalActivityStore(ctx.storage);
  }

  agentReports() { return this.reports.list(); }
  reportProblem(agent: AgentReport['agent'], input: unknown) { return this.reports.add(agent, input); }
  resolveAgentReport(id: string) { return this.reports.resolve(id); }
  localActivity(changeId?: string) { return this.activity.list(changeId); }
  recordLocalActivity(owner: string, agent: LocalActivityRun['agent'], input: LocalActivityBatch, changeNumber?: number) { return this.activity.add(owner, agent, input, changeNumber); }

  private bind(key: string) { if (this.meta.get('repository') !== key) this.meta.set('repository', key); }
  private settings(): LandingSettings { return this.meta.json<LandingSettings>('landing', { enabled: false }); }
  private linkState() { return this.meta.json<LinkState | undefined>('github', undefined); }
  private saveLink(state: LinkState) { this.meta.setJson('github', state); }
  private async repository(key: string): Promise<RepositoryInfo> {
    const info = await this.env.WORKSPACES.getByName(key).repository();
    if (!info) throw new Error('The repository is not available.');
    return info;
  }
  private queued() { return this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue').one().count; }
  /** Batches verifying in order: each was composed on the previous one's result and lands only after it. */
  private stack() { return this.meta.json<Verifying[]>('verifying', []); }
  private saveStack(stack: Verifying[]) { if (stack.length) this.meta.setJson('verifying', stack); else this.meta.delete('verifying'); }
  private saveVerifying(verifying: Verifying) {
    const stack = this.stack(), index = stack.findIndex(item => item.batch.id === verifying.batch.id);
    if (index >= 0) { stack[index] = verifying; this.saveStack(stack); }
  }
  private dropVerifying(batchId: string) { this.saveStack(this.stack().filter(item => item.batch.id !== batchId)); }
  /** Up to `verify.parallel` batches verify at once; narrowing a failure runs one batch at a time. */
  private room() {
    const stack = this.stack();
    if (!stack.length) return true;
    if (this.meta.json<string[]>('suspects', []).length) return false;
    return stack.length < (this.policyCache?.policy.verify.parallel ?? 3);
  }
  private async artifactsEndpoint(artifacts: ArtifactsRepo, repository: RepositoryInfo, scope: 'read' | 'write', seconds = 900): Promise<GitEndpoint & { revoke(): Promise<void> }> {
    const token = await artifacts.createToken(scope, seconds);
    // An unrevoked token still expires on its own within `seconds`.
    return { remote: repository.remote, token: token.plaintext, revoke: async () => { await artifacts.revokeToken(token.plaintext).catch(() => {}); } };
  }

  /* ---------- RPC ---------- */

  setDependencies(key: string, node: StackNode, dependencies: StackNode[], signature: string, retainClosed: boolean, pins?: { parent: string; revision: number }[]) {
    this.bind(key);
    try { return { ok: true as const, data: this.ctx.storage.transactionSync(() => this.graph.set(node, dependencies, signature, retainClosed, pins)) }; }
    catch (error) { return refused(error); }
  }
  async observeChanges(key: string, nodes: StackNode[]) { this.bind(key); this.graph.observe(nodes); await this.wakeDependents(); }
  dependencyPins(id: string) { return this.graph.pins(id); }
  private async wakeDependents() {
    const key = this.meta.get('repository');
    if (!key) return;
    await Promise.all(this.graph.wakes().map(async ({ id, version }) => {
      try { await changeShardOf(this.env, key, shardOf(id)!).dependencyChanged(id); this.graph.acknowledge(id, version); } catch { /* The alarm retries the durable notice. */ }
    }));
    if (this.graph.wakes().length) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + 5_000) await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }
  async checkDependencies(key: string, references: (number | string)[], child?: string): Promise<Result<null>> {
    try {
      const nodes = await Promise.all(references.map(async reference => {
        const shard = typeof reference === 'number' ? await this.shardForNumber(reference) : shardOf(reference);
        if (shard === null) throw new HttpError(404, 'Dependency not found in this repository.');
        return unwrap(await changeShardOf(this.env, key, shard).dependencyNode(String(reference)));
      }));
      this.graph.validate(child, [...new Map(nodes.map(node => [node.id, node])).values()]);
      return { ok: true, data: null };
    } catch (error) { return refused(error); }
  }
  /** A prerequisite's actual head, or an isolated Git composition for patch-only and multiple prerequisites. */
  async restackBase(key: string, id: string, authorization?: Authorization): Promise<Result<{ head: string; pins: { parent: string; revision: number }[] }>> {
    try {
      const dependencies = this.graph.dependencies(id), ancestors = this.graph.ancestors(id);
      if (!dependencies.length) throw new HttpError(409, 'This pull request has no dependencies to restack.');
      for (const node of ancestors) {
        if (node.status === 'closed') throw new HttpError(409, `#${node.number} closed without merging.`);
        if (this.graph.outdated(node.id).length) throw new HttpError(409, `Restack #${node.number} first.`);
        // Validate before either reusing a pushed head or opening a saved materialization plan.
        if (node.status !== 'landed') unwrap(await changeShardOf(this.env, key, shardOf(node.id)!).stackPatch(node.id, node.revision));
      }
      const pins = dependencies.map(item => ({ parent: item.id, revision: ancestors.find(node => node.id === item.id)!.revision }));
      const parent = dependencies.length === 1 ? ancestors.find(node => node.id === dependencies[0].id) : undefined;
      if (parent?.headCommit) return { ok: true, data: { head: parent.headCommit, pins } };
      const signature = await digest(JSON.stringify(ancestors.map(node => [node.id, node.revision, node.status])));
      let pending = this.stackBases.get(signature);
      if (!pending) {
        pending = this.materializeStackBase(key, signature, ancestors, authorization);
        this.stackBases.set(signature, pending);
        // The caller awaits `pending` itself; this only keeps the cleanup's copy of a failure from going unhandled.
        void pending.finally(() => this.stackBases.delete(signature)).catch(() => {});
      }
      return { ok: true, data: { head: await pending, pins } };
    } catch (error) { return refused(error); }
  }
  private async materializeStackBase(key: string, signature: string, ancestors: StackNode[], authorization?: Authorization): Promise<string> {
    const planKey = `stack-base:${signature}`;
    const saved = this.content.get<{ head: string; prepared?: string[]; done?: boolean; files?: CommitSpec['files'] }>(planKey);
    if (saved?.done) return saved.prepared!.at(-1)!;
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const head = saved?.head ?? await this.head(artifacts, repository);
    const reader = this.cache.reader(artifacts), patches = [];
    let files = saved?.files;
    if (!files) {
      for (const node of ancestors.filter(node => node.status !== 'landed')) {
        patches.push({ id: node.id, ...unwrap(await changeShardOf(this.env, key, shardOf(node.id)!).stackPatch(node.id, node.revision)) });
      }
      const composed = await composeChanges(reader, head, patches, (await this.policy(key)).policy.merge);
      const conflicted = composed.find(item => item.status === 'conflicted');
      if (conflicted) throw new HttpError(409, `#${ancestors.find(node => node.id === conflicted.id)!.number} conflicts with its prerequisites or main. Revise it first.`);
      files = Object.assign(Object.create(null), ...composed.map(item => item.files));
    }
    const plan = { ...saved, head, files };
    this.content.put(planKey, plan);
    await checkAuthorization(this.env, authorization);
    const endpoint = await this.artifactsEndpoint(artifacts, repository, 'write', 600);
    try {
      const prepared = await (await import('../git/push')).pushCommits({ remote: endpoint.remote, token: endpoint.token, branch: `braid/stacks/${signature}`, expectedHead: ZERO, parent: head, repository: reader,
        commits: [{ files: files!, message: 'Compose pull request prerequisites' }], prepared: plan.prepared,
        onPrepared: async commits => { await checkAuthorization(this.env, authorization); plan.prepared = commits; this.content.put(planKey, plan); } });
      this.content.put(planKey, { ...plan, prepared, done: true });
      return prepared.at(-1)!;
    } finally { await endpoint.revoke(); }
  }
  dependencyHeads(base: string) { return this.graph.heads(base); }
  dependencies(id: string) { return this.graph.dependencies(id); }
  stackViews(ids: string[]) { return this.graph.views(ids); }

  async enqueue(key: string, entry: QueueEntry): Promise<{ position: number }> {
    this.bind(key);
    if (this.graph.outdated(entry.changeId).length || this.graph.dependencies(entry.changeId).some(item => item.status !== 'landed')) return { position: 0 };
    const existing = this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM queue WHERE change_id = ?', entry.changeId).toArray()[0];
    if (!existing || existing.revision !== entry.revision) {
      const seq = Number(this.meta.get('sequence') ?? 0) + 1;
      this.meta.set('sequence', String(seq));
      this.ctx.storage.sql.exec('INSERT INTO queue (change_id, seq, shard, number, revision, title, enqueued_at, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(change_id) DO UPDATE SET seq = excluded.seq, revision = excluded.revision, title = excluded.title, enqueued_at = excluded.enqueued_at, attempts = 0, author = excluded.author',
        entry.changeId, seq, entry.shard, entry.number, entry.revision, entry.title.slice(0, 200), Date.now(), entry.author ?? '');
    }
    // A short delay lets concurrent arrivals share one batch and one push.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 250) await this.ctx.storage.setAlarm(Date.now() + 150);
    const seq = this.ctx.storage.sql.exec<{ seq: number }>('SELECT seq FROM queue WHERE change_id = ?', entry.changeId).one().seq;
    return { position: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue WHERE seq < ?', seq).one().count + 1 };
  }

  /**
   * Hands a shard a block of change numbers, so numbers stay dense and roughly ordered by time. Every change takes its
   * number here before it is written, so this is also where a shard joins the record of shards that hold changes.
   */
  async allocate(key: string, shard: number, count: number): Promise<number> {
    this.bind(key);
    const start = Number(this.meta.get('numbers') ?? 1);
    this.ctx.storage.transactionSync(() => {
      this.meta.set('numbers', String(start + count));
      this.ctx.storage.sql.exec('INSERT INTO number_blocks (start, end, shard) VALUES (?, ?, ?)', start, start + count, shard);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO change_shards (shard) VALUES (?)', shard);
    });
    return start;
  }
  /**
   * The shards that hold this repository's changes, or null while the record is not yet known to be complete: a
   * repository from before the record keeps it from the first full gather, which `recordShards` stores.
   */
  async occupiedShards(key: string): Promise<number[] | null> {
    this.bind(key);
    if (this.meta.get('shards-recorded') !== '1') return null;
    return this.ctx.storage.sql.exec<{ shard: number }>('SELECT shard FROM change_shards ORDER BY shard').toArray().map(row => row.shard);
  }
  /** Completes the record from a full gather: the shards seen holding changes, with any that took a number block since. */
  async recordShards(key: string, shards: number[]): Promise<void> {
    this.bind(key);
    this.ctx.storage.transactionSync(() => {
      for (const shard of shards) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO change_shards (shard) VALUES (?)', shard);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO change_shards (shard) SELECT DISTINCT shard FROM number_blocks');
      this.meta.set('shards-recorded', '1');
    });
  }

  async author(key: string, id: string): Promise<{ landed: number; sentBack: number; landedToday: number }> {
    this.bind(key);
    const row = this.ctx.storage.sql.exec<{ landed: number; sent_back: number; day: string; landed_today: number }>('SELECT landed, sent_back, day, landed_today FROM authors WHERE id = ?', id).toArray()[0];
    return { landed: row?.landed ?? 0, sentBack: row?.sent_back ?? 0, landedToday: row && row.day === now().slice(0, 10) ? row.landed_today : 0 };
  }
  private recordAuthor(id: string, outcome: 'landed' | 'sent-back') {
    if (!id) return;
    const day = now().slice(0, 10);
    this.ctx.storage.sql.exec("INSERT INTO authors (id, day) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", id, day);
    if (outcome === 'landed') this.ctx.storage.sql.exec('UPDATE authors SET landed = landed + 1, landed_today = CASE WHEN day = ? THEN landed_today + 1 ELSE 1 END, day = ? WHERE id = ?', day, day, id);
    else this.ctx.storage.sql.exec('UPDATE authors SET sent_back = sent_back + 1 WHERE id = ?', id);
  }

  async shardForNumber(number: number): Promise<number | null> {
    return this.ctx.storage.sql.exec<{ shard: number }>('SELECT shard FROM number_blocks WHERE start <= ? AND end > ? ORDER BY start DESC LIMIT 1', number, number).toArray()[0]?.shard ?? null;
  }

  async dequeue(key: string, changeId: string): Promise<{ removed: boolean; landing: boolean }> {
    this.bind(key);
    if (this.landingIds.has(changeId) || this.stack().some(item => item.plan.entries.some(entry => entry.changeId === changeId))) return { removed: false, landing: true };
    const removed = this.ctx.storage.sql.exec('DELETE FROM queue WHERE change_id = ?', changeId).rowsWritten > 0;
    return { removed, landing: false };
  }

  /** Cold public reads share one repository-owned allowance, across shards and Worker isolates.
   * Thirty builds/minute permits normal browsing while bounding upstream history and Git-object work. */
  publicBuild(network = 'unattributed'): { allowed: boolean; retryAfter: number } {
    const time = Date.now();
    const budget = this.meta.json<{ used: number; expires: number; networks: Record<string, number> }>('public-build-budget', { used: 0, expires: 0, networks: {} });
    if (budget.expires <= time) { budget.used = 0; budget.expires = time + 60_000; budget.networks = {}; }
    if (budget.used >= 30 || (budget.networks[network] ?? 0) >= 10) return { allowed: false, retryAfter: Math.ceil((budget.expires - time) / 1000) };
    budget.used++;
    budget.networks[network] = (budget.networks[network] ?? 0) + 1;
    this.meta.setJson('public-build-budget', budget);
    return { allowed: true, retryAfter: 0 };
  }
  private requirePublicBuild(network?: string) {
    const budget = this.publicBuild(network);
    if (!budget.allowed) throw new HttpError(503, 'This repository is preparing public content. Retry shortly.', budget.retryAfter);
  }

  /** Serialize public build refusals: custom error properties do not cross Durable Object RPC. */
  private async publicResult<T>(read: () => Promise<T>): Promise<Result<T>> {
    try { return { ok: true, data: await read() }; }
    catch (error) { return refused(error); }
  }
  publicPolicy(key: string, network?: string) { return this.publicResult(() => this.policy(key, true, network)); }
  publicInstructions(key: string, network?: string) { return this.publicResult(() => this.instructions(key, true, network)); }

  /** Main's policy and the instructions every change is checked against, as of main's head. */
  async policy(key: string, cacheOnly = false, network?: string): Promise<{ policy: Policy; errors: string[]; head: string; instructions: Instruction[] }> {
    const { policy, errors, head, instructions } = await this.rules(key, cacheOnly, network);
    return { policy, errors, head, instructions: instructions.instructions };
  }

  /** `.braid/instructions.json` on main, with what Braid could not read in it. */
  async instructions(key: string, cacheOnly = false, network?: string): Promise<{ instructions: Instruction[]; errors: string[]; head: string }> {
    const { head, instructions } = await this.rules(key, cacheOnly, network);
    return { ...instructions, head };
  }

  private async rules(key: string, cacheOnly: boolean, network?: string) {
    if (cacheOnly) {
      if (this.policyCache?.head === (this.meta.get('head') ?? '')) return this.policyCache;
      this.requirePublicBuild(network);
    }
    this.bind(key);
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    return this.policyAt(this.cache.reader(artifacts), await this.head(artifacts, repository, 10_000));
  }

  async configure(key: string, update: { enabled: boolean; authorization?: Authorization; actor: string }): Promise<TrunkStatus> {
    this.bind(key);
    const settings: LandingSettings = update.enabled ? { enabled: true, ...(update.authorization ? { authorization: update.authorization } : {}), by: update.actor, since: now() } : { enabled: false, by: update.actor, since: now() };
    this.meta.setJson('landing', settings);
    if (settings.enabled && (this.queued() || this.stack().length)) await this.ctx.storage.setAlarm(Date.now() + 50);
    return this.status(key);
  }

  async status(key: string, publicViewer = false, stackCursor = 0): Promise<TrunkStatus> {
    if (!publicViewer) this.bind(key);
    const settings = this.settings();
    const recent = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM batches ORDER BY started_at DESC LIMIT 20').toArray().map(row => JSON.parse(row.value) as BatchSummary);
    const stats = this.meta.json<TrunkStatus['stats']>('stats', { landed: 0, ejected: 0, batches: 0, strategies: {}, since: now() });
    const stacked = this.stack(), queued = this.queued();
    const queueChange = (entry: QueueEntry) => ({ changeId: entry.changeId, number: entry.number, title: entry.title });
    const stack: NonNullable<TrunkStatus['verifying']> = stacked.map(verifying => ({ ...verifying.batch, changes: verifying.plan.entries.map(queueChange),
      ...(verifying.runner ? { checks: verifying.runner.job.checks.map(command => {
        const result = verifying.runner!.result?.checks.find(check => check.phase === 'check' && check.command === command);
        return { command, status: result ? (result.exitCode === 0 ? 'passed' as const : 'failed' as const) : verifying.runner!.state === 'error' ? 'error' as const : 'pending' as const };
      }) } : {}), ...(verifying.github ? { pullRequest: { number: verifying.github.pr, url: verifying.github.url, state: verifying.github.state, reason: verifying.github.reason } } : {}),
      ...(verifying.ci ? { ci: { required: verifying.ci.required, statuses: verifying.ci.statuses } } : {}) }));
    const landing = stack[0] ?? this.landing;
    const merging = stacked.flatMap(verifying => verifying.plan.entries.map(queueChange));
    const inFlight = new Set([...merging.map(entry => entry.changeId), ...this.landingIds]);
    const waitingEntries = this.ctx.storage.sql.exec<Pick<Row, 'change_id' | 'number' | 'title'>>('SELECT change_id, number, title FROM queue ORDER BY seq LIMIT ?', 100 + inFlight.size).toArray()
      .filter(entry => !inFlight.has(entry.change_id)).slice(0, 100).map(entry => ({ changeId: entry.change_id, number: entry.number, title: entry.title }));
    const waiting = Math.max(0, queued - inFlight.size);
    const github = this.linkState();
    const result: TrunkStatus = { branch: this.meta.get('branch') ?? 'main', head: this.meta.get('head') ?? '', enabled: settings.enabled, ...(settings.paused ? { paused: settings.paused } : {}),
      queued, waiting, waitingEntries, waitingEntriesTruncated: waiting > waitingEntries.length, merging, ...(landing ? { landing } : {}), ...(stack.length ? { verifying: stack } : {}), recent, stats, ...this.graph.active(stackCursor), ...(github ? { github: this.publicLink(github) } : {}) };
    if (!publicViewer || github?.link.private === false) return result;
    const hiddenName = github?.link.fullName;
    const hide = (value: unknown): unknown => {
      if (typeof value === 'string') return (hiddenName ? value.replaceAll(hiddenName, '[private repository]') : value).replace(/https?:\/\/[^\s<>"']+/g, '[private URL]');
      if (Array.isArray(value)) return value.map(hide);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([name]) => !['github', 'pullRequest', 'url', 'fullName'].includes(name)).map(([name, item]) => [name, hide(item)]));
    };
    return hide(result) as TrunkStatus;
  }

  /* ---------- GitHub link ---------- */

  publicChecks(): boolean { return this.linkState()?.link.private === false; }

  private publicLink(state: LinkState): GitHubLinkStatus {
    return { fullName: state.link.fullName, defaultBranch: state.link.defaultBranch, mode: state.link.mode, status: state.status, linkedBy: state.link.linkedBy, linkedAt: state.link.linkedAt,
      ...(state.message ? { message: state.message } : {}), ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}), ...(state.mirroredHead ? { mirroredHead: state.mirroredHead } : {}) };
  }

  async githubLink(key: string): Promise<GitHubLinkStatus | null> {
    this.bind(key);
    const state = this.linkState();
    return state ? this.publicLink(state) : null;
  }

  /**
   * Links this repository to GitHub after confirming the two histories agree:
   * trunk must equal GitHub's default branch or be behind it (pull requests), or
   * GitHub must equal or be behind trunk, or be empty (mirror).
   */
  async linkGitHub(key: string, link: GitHubLink): Promise<Result<GitHubLinkStatus>> {
    this.bind(key);
    try {
      if (this.stack().length) return { ok: false, status: 409, error: 'Wait for the batches being verified to finish landing before linking GitHub.' };
      const repository = await this.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const head = await this.head(artifacts, repository);
      await this.refreshGitHubVisibility(link, link.mode === 'mirror');
      const github = await githubEndpoint(this.env, link, link.mode === 'mirror');
      const githubHead = (await advertisement(github, 'git-upload-pack')).refs.get(`refs/heads/${link.defaultBranch}`);
      const state: LinkState = { link, status: 'synced', checkedAt: now() };
      if (!githubHead) {
        if (link.mode !== 'mirror') return { ok: false, status: 409, error: 'The GitHub repository is empty. Link it as a mirror so Braid pushes its history there.' };
        const source = await this.artifactsEndpoint(artifacts, repository, 'read');
        try { await relay({ source, target: github, want: head, ref: `refs/heads/${link.defaultBranch}`, expected: ZERO }); } finally { await source.revoke(); }
        state.mirroredHead = head;
      } else if (githubHead !== head) {
        const compared = await githubApi(`/repos/${link.fullName}/compare/${head}...${githubHead}`, await installationToken(this.env, link, false), { allowNotFound: true });
        if (compared === null) return { ok: false, status: 409, error: 'Braid\'s trunk history is not part of this GitHub repository. Link the repository it was imported from, or an empty repository as a mirror.' };
        const relation = parseFrom(v.object({ status: v.string() }), compared, 'GitHub returned an unexpected comparison.').status;
        if (relation === 'ahead' && link.mode === 'pull-requests') await this.syncFromGitHub(key, state, repository, artifacts, head, githubHead);
        else if (relation === 'ahead') return { ok: false, status: 409, error: 'GitHub has commits Braid does not. Link with pull requests so Braid follows GitHub, or bring Braid up to date first.' };
        else if (relation === 'behind' && link.mode === 'mirror') {
          const source = await this.artifactsEndpoint(artifacts, repository, 'read');
          try { await relay({ source, target: github, want: head, ref: `refs/heads/${link.defaultBranch}`, expected: githubHead, have: [githubHead] }); } finally { await source.revoke(); }
          state.mirroredHead = head;
        } else if (relation === 'behind') return { ok: false, status: 409, error: 'Braid has landed commits GitHub does not have. Link as a mirror so Braid pushes them.' };
        else if (relation !== 'identical') return { ok: false, status: 409, error: 'Braid and GitHub have diverged. Reconcile the histories before linking.' };
      } else state.mirroredHead = head;
      this.saveLink(state);
      return { ok: true, data: this.publicLink(state) };
    } catch (error) {
      // GitHub's own refusals, such as permissions the app was never granted, keep their status.
      return refused(error, 502, shown(error, 'GitHub could not be linked.'));
    }
  }

  /** Unlinks GitHub, answering the repository id the link stored so its webhook route can be removed by id. */
  async unlinkGitHub(key: string): Promise<Result<{ repositoryId: number } | null>> {
    this.bind(key);
    if (this.stack().some(item => item.github)) return refusal(new HttpError(409, 'A batch is landing through GitHub. Wait for it to finish.'));
    const link = this.linkState()?.link;
    if (link?.authorization) await directoryOf(this.env).repositoryUnlinked(link.authorization.workspaceId);
    this.meta.delete('github');
    return { ok: true, data: link ? { repositoryId: link.repositoryId } : null };
  }

  /** Webhook from GitHub for this repository: wake up to read the gate or sync, rather than trusting the payload. */
  async githubEvent(key: string, event: GitHubEvent) {
    this.bind(key);
    const state = this.linkState();
    if (!state) return;
    if (event.name === 'installation_removed') { state.status = 'error'; state.message = 'The GitHub App no longer has access to this repository.'; this.saveLink(state); return; }
    for (const verifying of this.stack()) if (verifying.github && (event.number === verifying.github.pr || event.sha === verifying.tip)) {
      verifying.github.polledAt = 0;
      this.saveVerifying(verifying);
    }
    if (event.name === 'push' && event.ref === `refs/heads/${state.link.defaultBranch}`) { state.status = 'behind'; this.saveLink(state); }
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private async refreshGitHubVisibility(link: GitHubLink, write = false) {
    const token = await installationToken(this.env, link, write);
    const metadata = parseFrom(githubVisibility, await githubApi(`/repos/${link.fullName}`, token), 'GitHub returned an unexpected repository visibility.');
    link.private = metadata.private;
    if (link.authorization) {
      const until = await directoryOf(this.env).repositoryLinked(link.authorization.workspaceId, metadata.private, link.authorization.user.id);
      await waitForPublicReads(until);
    }
  }
  /** Makes Artifacts follow GitHub's default branch, sending only missing objects. */
  private async syncFromGitHub(key: string, state: LinkState, repository: RepositoryInfo, artifacts: ArtifactsRepo, head: string, githubHead: string) {
    await this.refreshGitHubVisibility(state.link);
    this.saveLink(state);
    const source = await githubEndpoint(this.env, state.link, false);
    const target = await this.artifactsEndpoint(artifacts, repository, 'write');
    try {
      await relay({ source, target, want: githubHead, ref: `refs/heads/${repository.branch}`, expected: head, have: [head], ...(state.link.shallowRoot ? { shallow: [state.link.shallowRoot] } : {}) });
    } finally { await target.revoke(); }
    this.attribution.dropMaps();
    this.policyCache = undefined;
    this.headCache = { at: Date.now(), head: githubHead };
    this.meta.set('head', githubHead);
    state.status = 'synced'; state.checkedAt = now(); delete state.message;
    this.saveLink(state);
    await this.env.WORKSPACES.getByName(key).trunkAdvanced(githubHead, { batchId: 'github-sync', landed: 0, ejected: 0, synced: true }).catch(error => logFailure('trunk_advanced_failed', error));
    return githubHead;
  }

  /** Mirror mode: push trunk to GitHub only as a fast-forward of what Braid last mirrored. */
  private async mirror(state: LinkState, repository: RepositoryInfo, artifacts: ArtifactsRepo, tip: string) {
    try {
      await this.refreshGitHubVisibility(state.link);
      const github = await githubEndpoint(this.env, state.link, true);
      const githubHead = (await advertisement(github, 'git-receive-pack')).refs.get(`refs/heads/${state.link.defaultBranch}`) ?? ZERO;
      if (githubHead === tip) { state.mirroredHead = tip; state.status = 'synced'; return; }
      if (state.mirroredHead && githubHead !== state.mirroredHead) {
        state.status = 'diverged'; state.message = 'Someone pushed to GitHub directly, so Braid stopped mirroring to avoid overwriting it. Land that work through Braid or switch to pull requests.';
        return;
      }
      const source = await this.artifactsEndpoint(artifacts, repository, 'read');
      try { await relay({ source, target: github, want: tip, ref: `refs/heads/${state.link.defaultBranch}`, expected: githubHead, have: githubHead === ZERO ? [] : [githubHead] }); }
      finally { await source.revoke(); }
      state.mirroredHead = tip; state.status = 'synced'; delete state.message;
    } catch (error) {
      state.status = 'error'; state.message = shown(error, 'Mirroring to GitHub failed.');
    } finally { state.checkedAt = now(); this.saveLink(state); }
  }

  async alarm() {
    const blame = this.attribution.seedPublicBlame();
    await this.wakeDependents();
    await this.deliverOutbox();
    await this.process();
    const notes = await this.retryNotes();
    await this.attribution.backfillFileLines();
    await blame;
    const next = Math.min(this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM outbox').one().due ?? Infinity, notes ? Date.now() + 60_000 : Infinity, this.attribution.due());
    const scheduled = await this.ctx.storage.getAlarm();
    if (next !== Infinity && (!scheduled || next < scheduled)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, next));
  }

  /**
   * Returns a change the queue let go of to its shard: back in line, or to its
   * author with the evidence. The queue no longer holds it, so a call that
   * fails is kept and retried rather than leaving the change merging forever.
   */
  private async requeue(key: string, entry: { shard: number; changeId: string; revision: number }, failed?: ChangeCheck[], reviews?: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[], runs?: CommandRun[]) {
    try { await changeShardOf(this.env, key, entry.shard).requeue(key, entry.changeId, entry.revision, failed, reviews, runs); }
    catch {
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO outbox (change_id, revision, shard, value, attempts, due) VALUES (?, ?, ?, ?, 0, ?)',
        entry.changeId, entry.revision, entry.shard, JSON.stringify({ failed, reviews, runs }), Date.now() + 5_000);
    }
  }
  private async deliverOutbox() {
    const key = this.meta.get('repository');
    if (!key) return;
    const due = this.ctx.storage.sql.exec<{ change_id: string; revision: number; shard: number; value: string; attempts: number }>('SELECT change_id, revision, shard, value, attempts FROM outbox WHERE due <= ? LIMIT 25', Date.now()).toArray();
    const busy = new Set(this.stack().flatMap(verifying => verifying.plan.entries.map(entry => entry.changeId)));
    for (const row of due) {
      if (busy.has(row.change_id)) { this.ctx.storage.sql.exec('DELETE FROM outbox WHERE change_id = ? AND revision = ?', row.change_id, row.revision); continue; }
      const { failed, reviews, runs } = JSON.parse(row.value) as { failed?: ChangeCheck[]; reviews?: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[]; runs?: CommandRun[] };
      try {
        await changeShardOf(this.env, key, row.shard).requeue(key, row.change_id, row.revision, failed, reviews, runs);
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE change_id = ? AND revision = ?', row.change_id, row.revision);
      } catch {
        this.ctx.storage.sql.exec('UPDATE outbox SET attempts = attempts + 1, due = ? WHERE change_id = ? AND revision = ?', Date.now() + Math.min(600_000, 5_000 * 2 ** row.attempts), row.change_id, row.revision);
      }
    }
  }

  /* ---------- processing ---------- */

  /**
   * The trunk's head, read by branch name. Artifacts cannot always read a branch by name, as with a copy still shallow
   * from its import; Git's own listing then names the branch's commit exactly, which a landing's compare-and-swap needs.
   */
  private async head(artifacts: ArtifactsRepo, repository: RepositoryInfo, maxAge = 0) {
    if (maxAge && this.headCache && Date.now() - this.headCache.at < maxAge) return this.headCache.head;
    const head = (await artifacts.log({ ref: repository.branch, limit: 1 }))[0]?.hash || await this.listedHead(artifacts, repository);
    if (!head) throw new Error('The trunk branch is not available yet.');
    this.headCache = { at: Date.now(), head };
    this.meta.set('head', head); this.meta.set('branch', repository.branch);
    return head;
  }
  private async listedHead(artifacts: ArtifactsRepo, repository: RepositoryInfo) {
    const endpoint = await this.artifactsEndpoint(artifacts, repository, 'read');
    try { return (await advertisement(endpoint, 'git-upload-pack', 4 * 1024 * 1024)).refs.get(`refs/heads/${repository.branch}`); }
    finally { await endpoint.revoke(); }
  }

  private async policyAt(reader: ReturnType<ObjectCache['reader']>, head: string) {
    if (this.policyCache?.head === head) return this.policyCache;
    const snapshot = new TreeSnapshot(reader);
    // Only an absent policy uses defaults; a present file the text reader cannot read fails closed.
    const read = async (path: string) => { const version = await snapshot.version(head, path); return version.kind === 'absent' ? null : version.kind === 'file' ? await snapshot.text(version) ?? undefined : undefined; };
    this.policyCache = { head, ...parsePolicy(await read(POLICY_PATH)), instructions: parseInstructions(await read(INSTRUCTIONS_PATH) ?? null) };
    return this.policyCache;
  }

  private async process() {
    if (this.processing) return;
    const key = this.meta.get('repository');
    const settings = this.settings();
    if (!key || !settings.enabled || settings.paused) return;
    this.processing = true;
    const started = Date.now();
    let delay = 50;
    try {
      if (this.stack().length) await this.watch(key, this.stack());
      if (!this.stack().length) await this.recover(key);
      // A gate can pause merging partway through (a broken main, a closed pull request): stop starting batches at once.
      while (Date.now() - started < 20_000 && this.queued() && this.room() && !this.settings().paused && await this.runBatch(key, this.settings()));
    } catch (error) {
      // No landing fits into a repository at its storage limit, so the queue waits for an owner instead of retrying.
      if (error instanceof GitError && error.code === 'full') this.pause(this.settings(), STORAGE_FULL);
      const failures = Number(this.meta.get('failures') ?? 0) + 1;
      this.meta.set('failures', String(failures));
      delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
      logFailure('landing_failed', error, { failures });
    } finally {
      this.processing = false;
      this.landing = undefined; this.landingIds.clear();
    }
    const stack = this.stack();
    if (stack.some(verifying => verifying.github && ['pending', 'blocked'].includes(verifying.github.state))) await this.ctx.storage.setAlarm(Date.now() + GITHUB_POLL);
    else if (this.queued() && this.settings().enabled && !this.settings().paused && this.room()) {
      // Changes inside the veto delay become eligible later; wake when the first one does.
      const wait = (this.policyCache?.policy.delay.minutes ?? 0) * 60_000;
      const first = this.ctx.storage.sql.exec<{ at: number | null }>('SELECT MIN(enqueued_at) AS at FROM queue').one().at;
      await this.ctx.storage.setAlarm(Math.max(Date.now() + delay, wait && first ? first + wait : 0));
    }
  }

  /* ---------- CI through webhooks and statuses ---------- */

  private hookConfig(): Hook | null { return this.meta.json<Hook | null>('hook', null); }
  /** The webhook without its secret, with recent deliveries, for owners. */
  async hook(key: string): Promise<(Omit<Hook, 'secret'> & { deliveries: HookDelivery[] }) | null> {
    this.bind(key);
    const hook = this.hookConfig();
    if (!hook) return null;
    const { secret: _secret, ...rest } = hook;
    return { ...rest, deliveries: this.meta.json<HookDelivery[]>('hook-deliveries', []) };
  }
  async setHook(key: string, input: { url: string; secret: string; actor: string; origin: string }) {
    this.bind(key);
    const problem = validHookUrl(input.url);
    if (problem) return { ok: false as const, status: 400, error: problem };
    this.meta.setJson('hook', { url: input.url, secret: input.secret, origin: input.origin, by: input.actor, createdAt: now() } satisfies Hook);
    this.meta.delete('hook-deliveries');
    return { ok: true as const, data: await this.hook(key) };
  }
  async deleteHook(key: string) { this.bind(key); this.meta.delete('hook', 'hook-deliveries'); }

  /** Tells the repository's CI that a merge group is ready, signed like GitHub webhooks, with a ten-minute read-only clone token. */
  private async deliver(key: string, hook: Hook, verifying: Verifying, repository: RepositoryInfo, artifacts: ArtifactsRepo) {
    const token = await artifacts.createToken('read', 600);
    const body = JSON.stringify(ciPayload({ hook, key, verifying: { tip: verifying.tip, base: verifying.base, staging: verifying.staging, batchId: verifying.batch.id, entries: verifying.plan.entries.map(entry => ({ number: entry.number, title: entry.title })) },
      repository, token: token.plaintext.split('?expires=')[0], expiresAt: token.expiresAt }));
    const id = crypto.randomUUID();
    let status: number | string;
    try {
      const response = await fetch(hook.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'Braid-Hookshot', 'x-braid-event': 'merge_group', 'x-braid-delivery': id, 'x-braid-signature-256': `sha256=${await mac(hook.secret, body)}` }, body });
      status = response.status;
      await response.body?.cancel();
    } catch { status = 'unreachable'; }
    const deliveries = [{ id, event: 'merge_group', at: now(), status, sha: verifying.tip } satisfies HookDelivery, ...this.meta.json<HookDelivery[]>('hook-deliveries', [])].slice(0, 20);
    this.meta.setJson('hook-deliveries', deliveries);
  }

  /**
   * RPC from the statuses endpoint: CI reports a status for a merge group's
   * commit, signed with the webhook secret. Unknown commits are ignored, so a
   * late report for a batch that already finished changes nothing.
   */
  async report(key: string, sha: string, body: string, signature: string | null): Promise<{ ok: true } | Refusal> {
    this.bind(key);
    const hook = this.hookConfig();
    if (!hook) return { ok: false, status: 404, error: 'This repository has no webhook.' };
    const expected = `sha256=${await mac(hook.secret, body)}`;
    if (!signature || !await equalSecret(signature, expected))
      return { ok: false, status: 401, error: 'The signature does not match the webhook secret.' };
    const input = v.safeParse(ciStatus, body);
    if (!input.success) return { ok: false, status: 400, error: input.issues[0].message };
    const { state, context, description, target_url: url } = input.output;
    const verifying = this.stack().find(item => item.tip === sha);
    if (!verifying?.ci) return { ok: true };
    verifying.ci.statuses[context] = { state, at: now(), ...(description ? { description } : {}), ...(url ? { url } : {}) };
    this.saveVerifying(verifying);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { ok: true };
  }
  private ciEvidence(context: string, status: CiStatus): ChangeCheck {
    return { revision: 0, label: context, status: status.state === 'success' ? 'passed' : status.state === 'pending' ? 'warning' : 'failed', source: 'ci',
      detail: `${status.description ?? `Reported ${status.state} by this repository's CI`} for the merge queue's combined commit.${status.url ? `\n${status.url}` : ''}` };
  }

  /** Polls undecided GitHub gates, stops verifications that never report back, then acts on the front batch. */
  private async watch(key: string, stack: Verifying[]) {
    const state = this.linkState();
    for (const verifying of stack) {
      if (verifying.github && state && ['pending', 'blocked'].includes(verifying.github.state) && Date.now() - verifying.github.polledAt >= GITHUB_POLL - 1000) {
        const gate = await pullRequestGate(this.env, state.link, verifying.github.pr, verifying.tip, verifying.github.openedAt, { reviewers: verifying.github.reviewers ?? [], waitMs: (verifying.github.wait ?? 0) * 60_000 });
        Object.assign(verifying.github, { state: gate.state, reason: gate.reason, gate, polledAt: Date.now() });
        this.saveVerifying(verifying);
      }
      // CI that never reports is missing evidence: compose again rather than merge or blame.
      if (verifying.ci && !verifying.ci.timedOut && verifying.ci.required.some(context => verifying.ci!.statuses[context]?.state !== 'success')
        && Date.now() - verifying.ci.startedAt > (verifying.ci.minutes + 5) * 60_000) { verifying.ci.timedOut = true; this.saveVerifying(verifying); }
      const budget = (verifying.runner?.job.timeoutMs ?? 0) + 45 * 60_000;
      if (verifying.runner?.state === 'pending' && Date.now() - verifying.startedAt > budget) {
        verifying.runner.state = 'error';
        verifying.runner.result = { id: verifying.runner.job.id, commit: verifying.tip, status: 'error', checks: [], startedAt: now(), finishedAt: now(), error: 'Verification did not report back.' };
        this.saveVerifying(verifying);
      }
    }
    await this.drain(key);
  }

  /** Acts on the front batch only; batches behind it wait for it to land or fail. */
  private async drain(key: string) {
    for (let landed = 0; landed < 20; landed++) {
      const front = this.stack()[0];
      if (!front || await this.decide(key, front) !== 'landed') return;
    }
  }

  /** After the front batch fails or lands as a different commit, the batches composed on top of it are composed again. */
  private async cancelStack(key: string, note: string) {
    const stack = this.stack();
    if (!stack.length) return;
    this.saveStack([]);
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    for (const verifying of stack) {
      verifying.batch.status = 'failed'; verifying.batch.finishedAt = now(); verifying.batch.note = note; verifying.batch.requeued = named(verifying.plan.entries);
      for (const entry of verifying.plan.entries) await this.requeue(key, entry);
      this.record(verifying.batch);
      await this.closeGitHub(verifying, `Braid will compose these changes again: ${note}`);
      await this.cleanup(verifying, artifacts, repository);
    }
  }

  private batchSize() { return Math.max(1, Math.min(MAX_BATCH, this.failureCap(), Number(this.meta.get('batch-size') ?? 8))); }
  /**
   * The largest batch worth verifying at once. With a per-change failure rate
   * p, a batch of n fails with probability 1-(1-p)^n, and keeping that near a
   * quarter needs n <= 0.29/p. The rate is a decayed count of changes found
   * responsible for failed checks among landed ones, from a prior of 1 in 100.
   */
  private failureCap() {
    const { changes, culprits } = this.meta.json('failure-rate', { changes: 0, culprits: 0 });
    return Math.max(4, Math.min(MAX_BATCH, Math.floor(0.29 * (changes + 100) / (culprits + 1))));
  }
  private recordOutcome(landed: number, culprits: number) {
    const current = this.meta.json('failure-rate', { changes: 0, culprits: 0 });
    this.meta.setJson('failure-rate', { changes: current.changes * 0.98 + landed, culprits: current.culprits * 0.98 + culprits });
  }

  /** Composes one batch and lands it, or stages it behind its gates. Returns false when it cannot progress now. */
  private async runBatch(key: string, settings: LandingSettings): Promise<boolean> {
    // After a failed verification, only the suspects are retried, half at a time, until the culprit is isolated.
    let suspects = this.meta.json<string[]>('suspects', []);
    let rows: Row[] = [];
    if (suspects.length) {
      const queued = this.ctx.storage.sql.exec<Row>(`SELECT change_id, shard, number, revision, title, attempts, author, enqueued_at FROM queue WHERE change_id IN (${suspects.map(() => '?').join(',')}) ORDER BY seq`, ...suspects).toArray();
      suspects = queued.map(row => row.change_id);
      this.meta.setJson('suspects', suspects);
      rows = queued.slice(0, Math.ceil(queued.length / 2));
    }
    const inflight = new Set(this.stack().flatMap(item => item.plan.entries.map(entry => entry.changeId)));
    if (!rows.length) rows = this.eligible(this.batchSize(), inflight);
    if (!rows.length) return false;
    const batchId = `b_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
    const batch: BatchSummary = { id: batchId, status: 'composing', base: '', startedAt: now(), landed: [], ejected: [], strategies: {} };
    this.landing = batch; this.landingIds = new Set(rows.map(row => row.change_id));
    // A change taken into a new batch no longer needs to hear that it left an earlier one.
    for (const row of rows) this.ctx.storage.sql.exec('DELETE FROM outbox WHERE change_id = ?', row.change_id);
    const fetched = await Promise.all(rows.map(row => changeShardOf(this.env, key, row.shard).forLanding(key, row.change_id, row.revision, batchId)
      .catch(error => refused(error, 503, 'The change store is unavailable.'))));
    const ready: { row: Row; patch: LandingPatch }[] = [];
    let stale = 0;
    fetched.forEach((result, index) => {
      if (result.ok) ready.push({ row: rows[index], patch: result.data });
      else if (result.status === 404 || result.status === 409) { this.ctx.storage.sql.exec('DELETE FROM queue WHERE change_id = ? AND revision = ?', rows[index].change_id, rows[index].revision); stale++; }
    });
    if (!ready.length) return stale > 0;
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const reader = this.cache.reader(artifacts);
    const link = this.linkState();
    try {
      for (let attempt = 0; ; attempt++) {
        // A stacked batch is composed on the result of the batch verifying ahead of it.
        const ahead = this.stack().at(-1);
        let head = ahead ? ahead.tip : await this.head(artifacts, repository);
        // GitHub is the source of truth for linked repositories: start from its latest commit.
        if (!ahead && link?.link.mode === 'pull-requests') {
          await this.refreshGitHubVisibility(link.link);
          this.saveLink(link);
          const githubHead = (await advertisement(await githubEndpoint(this.env, link.link, false), 'git-upload-pack')).refs.get(`refs/heads/${link.link.defaultBranch}`);
          if (githubHead && githubHead !== head) head = await this.syncFromGitHub(key, link, repository, artifacts, head, githubHead);
        }
        batch.base = head; batch.status = 'composing';
        const { policy } = await this.policyAt(reader, head);
        const composed = await composeChanges(reader, head, ready.map(({ patch }) => ({ id: patch.changeId, baseCommit: patch.baseCommit, files: patch.files })), policy.merge);
        const byId = new Map(composed.map(result => [result.id, result]));
        for (const item of [...ready]) {
          const result = byId.get(item.patch.changeId)!;
          if (result.status !== 'conflicted') continue;
          await this.eject(key, item, result, head, batch);
          ready.splice(ready.indexOf(item), 1);
        }
        const applied = ready.filter(item => byId.get(item.patch.changeId)!.status === 'applied');
        const plan: Plan = { batchId, head, entries: ready.map(item => ({ changeId: item.patch.changeId, shard: item.row.shard, number: item.patch.number, revision: item.patch.revision,
          title: item.patch.title, author: item.patch.author.name, summary: item.patch.summary, paths: Object.keys(item.patch.files),
          commit: applied.includes(item) ? applied.indexOf(item) : null, strategies: byId.get(item.patch.changeId)!.strategies,
          who: { author: item.patch.author, ...(item.patch.fileAuthors ? { fileAuthors: item.patch.fileAuthors } : {}), ...(item.patch.taskId ? { taskId: item.patch.taskId } : {}), approvedBy: item.patch.approvals.length ? item.patch.approvals.join(', ') : `policy (${item.patch.autonomy ?? 'auto'})` } })) };
        if (!applied.length) { await this.finalize(key, batch, plan, [], head); return true; }
        const specs = await Promise.all(applied.map(item => this.spec(item.patch, byId.get(item.patch.changeId)!)));
        if (policy.checks.length || policy.verify.required.length || link?.link.mode === 'pull-requests') return await this.stage(key, settings, repository, artifacts, reader, batch, plan, specs, policy, head, link);
        batch.status = 'pushing';
        try { await checkAuthorization(this.env, settings.authorization); }
        catch (error) { this.pause(settings); throw error; }
        const endpoint = await this.artifactsEndpoint(artifacts, repository, 'write');
        try {
          const created = { commits: new Map<string, { treeHash: string }>(), trees: new Map<string, ArtifactsTreeEntry[]>(), blobs: new Map<string, Uint8Array>() };
          const landed = await (await import('../git/push')).pushCommits({ remote: endpoint.remote, token: endpoint.token, branch: repository.branch, expectedHead: head, repository: reader, commits: specs, created,
            onPrepared: async prepared => { plan.prepared = prepared; this.content.put(`plan:${batchId}`, plan); this.meta.set('active-plan', batchId); } });
          this.cache.seed(created);
          await this.finalize(key, batch, plan, landed, landed.at(-1)!);
          if (link?.link.mode === 'mirror') {
            await this.mirror(link, repository, artifacts, landed.at(-1)!);
            await this.mirrorNotes(link, repository, artifacts);
          }
          return true;
        } catch (error) {
          // Someone else moved trunk between reading and pushing: recompose on the new head.
          if (moved(error) && attempt < 3) { this.headCache = undefined; continue; }
          throw error;
        } finally { await endpoint.revoke(); }
      }
    } catch (error) {
      batch.status = 'failed'; batch.finishedAt = now(); batch.requeued = named(ready.map(item => item.patch));
      for (const item of ready) await this.requeue(key, { shard: item.row.shard, changeId: item.patch.changeId, revision: item.patch.revision });
      this.meta.set('batch-size', String(Math.max(1, Math.floor(this.batchSize() / 2))));
      this.record(batch);
      throw error;
    }
  }

  /**
   * The next changes allowed to land: past the policy's veto delay and within
   * each author's daily cap. Waiting changes keep their place in the queue.
   */
  private eligible(limit: number, exclude: Set<string>): Row[] {
    const policy = this.policyCache?.policy;
    const delay = (policy?.delay.minutes ?? 0) * 60_000, cap = policy?.limits.dailyPerAuthor ?? 0;
    const rows = this.ctx.storage.sql.exec<Row>('SELECT change_id, shard, number, revision, title, attempts, author, enqueued_at FROM queue WHERE enqueued_at <= ? ORDER BY seq LIMIT ?', Date.now() - delay, (cap ? limit * 4 : limit) + exclude.size).toArray()
      .filter(row => !exclude.has(row.change_id));
    if (!cap) return rows.slice(0, limit);
    const today = now().slice(0, 10), used = new Map<string, number>();
    return rows.filter(row => {
      if (!row.author) return true;
      if (!used.has(row.author)) used.set(row.author, this.ctx.storage.sql.exec<{ count: number }>('SELECT landed_today AS count FROM authors WHERE id = ? AND day = ?', row.author, today).toArray()[0]?.count ?? 0);
      const count = used.get(row.author)!;
      if (count >= cap) return false;
      used.set(row.author, count + 1);
      return true;
    }).slice(0, limit);
  }

  private pause(settings: LandingSettings, reason = 'The owner who turned on merging no longer has write access. An owner must resume the merge queue.') {
    this.meta.setJson('landing', { ...settings, paused: reason });
  }

  /** A change's commit: its own message, its owner as author and Braid as committer; who made it is in the note. */
  private async spec(patch: LandingPatch, result: ComposedChange): Promise<CommitSpec> {
    patch.author = await publicAuthor(this.env, patch.author);
    if (patch.fileAuthors) patch.fileAuthors = Object.fromEntries(await Promise.all(Object.entries(patch.fileAuthors).map(async ([path, author]) => [path, await publicAuthor(this.env, author)])));
    const author = gitAuthor(patch.author);
    return { files: result.files, message: commitMessage(patch), authorName: author.name, authorEmail: author.email };
  }

  /** Pushes the composed batch to a staging branch and opens its gates; trunk moves only after they pass. */
  private async stage(key: string, settings: LandingSettings, repository: RepositoryInfo, artifacts: ArtifactsRepo, reader: ReturnType<ObjectCache['reader']>,
    batch: BatchSummary, plan: Plan, specs: CommitSpec[], policy: Policy, head: string, link: LinkState | undefined): Promise<boolean> {
    try { await checkAuthorization(this.env, settings.authorization); }
    catch (error) { this.pause(settings); throw error; }
    const staging = `braid/land/${batch.id}`;
    const endpoint = await this.artifactsEndpoint(artifacts, repository, 'write');
    let commits: string[];
    try {
      const created = { commits: new Map<string, { treeHash: string }>(), trees: new Map<string, ArtifactsTreeEntry[]>(), blobs: new Map<string, Uint8Array>() };
      commits = await (await import('../git/push')).pushCommits({ remote: endpoint.remote, token: endpoint.token, branch: staging, expectedHead: ZERO, parent: head, repository: reader, created, commits: specs });
      this.cache.seed(created);
    } finally { await endpoint.revoke(); }
    const tip = commits.at(-1)!;
    plan.prepared = commits;
    batch.status = 'verifying'; batch.head = tip;
    const verifying: Verifying = { batch, base: head, tip, staging, plan, retries: policy.verify.retries, startedAt: Date.now() };
    if (link?.link.mode === 'pull-requests') {
      const source = await this.artifactsEndpoint(artifacts, repository, 'read');
      try { await relay({ source, target: await githubEndpoint(this.env, link.link, true), want: tip, ref: `refs/heads/${staging}`, expected: ZERO, have: [head] }); }
      finally { await source.revoke(); }
      const titles = plan.entries.slice(0, 3).map(entry => `#${entry.number}`).join(', ');
      const pull = await openPullRequest(this.env, link.link, { branch: staging, title: `Braid: land ${plural(plan.entries.length, 'change')} (${titles}${plan.entries.length > 3 ? ', …' : ''})`, body: pullRequestBody(plan, head, this.env.PUBLIC_ORIGIN) });
      verifying.github = { pr: pull.number, url: pull.url, branch: staging, openedAt: Date.now(), polledAt: Date.now(), state: 'pending', reason: 'Waiting for GitHub checks to start.',
        ...(policy.github.reviewers.length ? { reviewers: policy.github.reviewers, wait: policy.github.wait } : {}) };
      const declined = await requestReviewers(this.env, link.link, pull.number, policy.github.reviewers).catch(() => 'GitHub refused the review request.');
      if (declined) batch.note = `Could not request ${policy.github.reviewers.map(reviewerName).join(', ')} on pull request #${pull.number}: ${declined}`;
    }
    if (policy.checks.length) {
      const job: VerifyJob = { id: batch.id, repo: repository.id, remote: repository.remote, commit: tip, baseline: head, ...(policy.install ? { install: policy.install } : {}), checks: policy.checks, timeoutMs: policy.verify.minutes * 60_000 };
      verifying.runner = { job, state: 'pending' };
    }
    const hook = this.hookConfig();
    if (policy.verify.required.length || hook) verifying.ci = { required: policy.verify.required, statuses: {}, startedAt: Date.now(), minutes: policy.verify.minutes };
    this.saveStack([...this.stack(), verifying]);
    if (hook) await this.deliver(key, hook, verifying, repository, artifacts);
    this.record(batch);
    if (verifying.runner) await this.env.VERIFICATIONS.create({ id: `verify-${batch.id}`, params: { repository: key, batchId: batch.id, job: verifying.runner.job } });
    if (verifying.github) await this.ctx.storage.setAlarm(Date.now() + GITHUB_POLL);
    // Stacked batches keep the queue moving while earlier ones verify.
    return this.room();
  }

  /** RPC from the verification workflow: runs the checks in a fresh sandbox for this job and waits for the result. */
  async runVerification(key: string, job: VerifyJob): Promise<VerifyResult> {
    const sandboxes = this.ctx.exports?.AgentSandbox as unknown as DurableObjectNamespace<AgentSandbox> | undefined;
    if (!sandboxes) return { id: job.id, commit: job.commit, status: 'error', checks: [], startedAt: now(), finishedAt: now(), error: 'Cloudflare sandbox execution is not configured for this deployment.' };
    using result = await sandboxes.getByName(runnerName(key, job.id)).verify(job);
    return { id: result.id, commit: result.commit, status: result.status, checks: result.checks.map(check => ({ ...check })), startedAt: result.startedAt, finishedAt: result.finishedAt, ...(result.error ? { error: result.error } : {}),
      ...(result.baseline ? { baseline: { commit: result.baseline.commit, failing: [...result.baseline.failing] } } : {}) };
  }

  /** RPC from the verification workflow with the result of the repository's checks on the composed batch. */
  async verified(key: string, batchId: string, receipt: unknown): Promise<void> {
    const verifying = this.stack().find(item => item.batch.id === batchId);
    if (!verifying?.runner || verifying.runner.state !== 'pending' || this.meta.get('repository') !== key) return;
    const parsed = v.safeParse(verificationResult(verifying.runner.job), receipt);
    if (!parsed.success) return;
    const result = parsed.output;
    verifying.runner.state = result.status;
    verifying.runner.result = result;
    this.saveVerifying(verifying);
    await this.drain(key);
    if (this.queued() && this.room()) await this.ctx.storage.setAlarm(Date.now() + 50);
  }

  /** Lands, retries or narrows the front batch once its gates have spoken. */
  private async decide(key: string, verifying: Verifying): Promise<'landed' | 'waiting' | 'stopped'> {
    const { runner, github } = verifying;
    const stopped = async (handled: Promise<void>) => {
      await handled;
      await this.cancelStack(key, 'An earlier batch did not merge, so the changes after it are combined with main again.');
      return 'stopped' as const;
    };
    if (runner?.state === 'failed') {
      // Every failing check also fails on main alone: main is broken, so pause instead of blaming these changes.
      const failing = runner.result!.checks.filter(check => check.phase === 'check' && check.exitCode !== 0).map(check => check.command);
      const broken = runner.result!.baseline?.failing ?? [];
      if (failing.length && failing.every(command => broken.includes(command))) {
        this.pause(this.settings(), `Main fails ${broken.map(command => `\`${command}\``).join(' and ')} on its own. Merging is paused until main is fixed; no pull request was blamed.`);
        return stopped(this.retry(key, verifying, `Main itself fails ${broken.join(', ')}, so these pull requests go back to the queue unblamed.`, false));
      }
      return stopped(this.failed(key, verifying, runner.result!.checks.map(check => this.evidence(check, verifying.tip, verifying.plan.entries.length, check.exitCode === 0 ? 'passed' : 'failed')), [], this.runs(verifying)));
    }
    if (github?.state === 'failed') {
      const failing = (github.gate?.checks ?? []).filter(check => check.status === 'failed').map(check => check.name);
      const state = this.linkState();
      const onMain = failing.length && state ? await failedChecks(this.env, state.link, verifying.base).catch(error => { logFailure('github_main_checks_failed', error); return []; }) : [];
      if (failing.length && failing.every(name => onMain.includes(name))) {
        this.pause(this.settings(), `Main fails ${failing.map(name => `\`${name}\``).join(' and ')} on GitHub on its own. Merging is paused until main is fixed; no pull request was blamed.`);
        return stopped(this.retry(key, verifying, `Main itself fails ${failing.join(', ')} on GitHub, so these pull requests go back to the queue unblamed.`, false));
      }
      return stopped(this.failed(key, verifying, (github.gate?.checks ?? []).filter(check => check.status === 'failed').map(check => this.githubEvidence(check)), github.gate?.reviews.filter(review => review.state === 'changes_requested') ?? []));
    }
    const ci = verifying.ci;
    const ciFailed = Object.entries(ci?.statuses ?? {}).filter(([, status]) => status.state === 'failure' || status.state === 'error');
    if (ciFailed.length) return stopped(this.failed(key, verifying, ciFailed.map(([context, status]) => this.ciEvidence(context, status)), []));
    if (ci?.timedOut) {
      const missing = ci.required.filter(context => ci.statuses[context]?.state !== 'success');
      return stopped(this.retry(key, verifying, `CI did not report ${missing.join(', ')} within ${plural(ci.minutes, 'minute')}, so these pull requests go back to the queue.`));
    }
    if (runner?.state === 'error') return stopped(this.retry(key, verifying, runner.result?.error ?? 'Verification could not run.'));
    if (github?.state === 'stale') return stopped(this.retry(key, verifying, github.reason, false));
    if (github?.state === 'closed') { this.pause(this.settings(), `Someone closed pull request #${github.pr} on GitHub, so merging paused. Resume the merge queue to continue.`); return stopped(this.retry(key, verifying, github.reason, false)); }
    if (github?.state !== 'merged' && ((runner && runner.state !== 'passed') || (github && github.state !== 'passed') || (ci && ci.required.some(context => ci.statuses[context]?.state !== 'success')))) return 'waiting';
    const landed = await this.land(key, verifying, github?.state === 'merged' ? github.gate?.mergeCommit : undefined);
    if (landed === verifying.tip) return 'landed';
    // The batch did not land, or landed as a different commit (a GitHub merge commit): later batches were composed on the wrong parent.
    await this.cancelStack(key, landed ? 'GitHub merged the previous batch with a merge commit, so later changes are combined with it again.' : 'An earlier batch did not merge, so the changes after it are combined with main again.');
    return 'stopped';
  }

  /** Lands the front batch and returns the commit trunk now points at, or null when it was put back instead. */
  private async land(key: string, verifying: Verifying, mergedOnGitHub?: string): Promise<string | null> {
    const { batch, plan } = verifying;
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const target = await this.artifactsEndpoint(artifacts, repository, 'write');
    const link = this.linkState();
    let tip = verifying.tip;
    try {
      await checkAuthorization(this.env, this.settings().authorization);
      if (verifying.github && link) {
        await this.refreshGitHubVisibility(link.link, true);
        this.saveLink(link);
        const github = await githubEndpoint(this.env, link.link, true);
        const ref = `refs/heads/${link.link.defaultBranch}`;
        if (mergedOnGitHub) tip = mergedOnGitHub;
        else {
          try { await updateRef(github, ref, verifying.base, verifying.tip); }
          catch {
            // Branch protection may forbid pushing; then GitHub merges the pull request itself.
            const current = (await advertisement(github, 'git-upload-pack')).refs.get(ref);
            if (current !== verifying.base) { await this.retry(key, verifying, 'GitHub\'s default branch moved while checks ran, so these changes will be combined with it again.', false); return null; }
            tip = await mergePullRequest(this.env, link.link, verifying.github.pr, verifying.tip, `Braid: land ${plural(plan.entries.length, 'change')}`);
          }
        }
        if (tip === verifying.tip) await updateRef(target, `refs/heads/${repository.branch}`, verifying.base, tip);
        else await relay({ source: await githubEndpoint(this.env, link.link, false), target, want: tip, ref: `refs/heads/${repository.branch}`, expected: verifying.base, have: [verifying.tip, verifying.base] });
        link.status = 'synced'; link.checkedAt = now(); link.mirroredHead = tip;
        this.saveLink(link);
        // The staging branch is temporary: one left on GitHub holds nothing main needs.
        await updateRef(github, `refs/heads/${verifying.staging}`, verifying.tip, ZERO).catch(() => {});
      } else {
        try { await updateRef(target, `refs/heads/${repository.branch}`, verifying.base, verifying.tip); }
        catch (error) {
          if (!moved(error)) throw error;
          await this.retry(key, verifying, 'Main moved while checks ran, so these changes will be combined with it again.', false);
          return null;
        }
      }
    } finally { await target.revoke(); }
    const evidence = [
      ...(verifying.runner?.result?.checks ?? []).map(check => this.evidence(check, verifying.tip, plan.entries.length, 'passed')),
      ...(verifying.github?.gate?.checks ?? []).map(check => this.githubEvidence(check)),
      ...Object.entries(verifying.ci?.statuses ?? {}).map(([context, status]) => this.ciEvidence(context, status)),
      ...(verifying.github?.gate?.missing ?? []).map((name): ChangeCheck => ({ revision: 0, label: `${reviewerName(name)} review`, status: 'warning', source: 'github',
        detail: `Requested on pull request #${verifying.github!.pr}, but no review arrived within ${verifying.github!.wait ?? 0} minutes.` })),
    ];
    const reviews = (verifying.github?.gate?.reviews ?? []).map(review => this.githubReview(review));
    await this.finalize(key, batch, plan, plan.prepared!, tip, evidence, reviews, this.runs(verifying));
    const suspects = new Set(this.meta.json<string[]>('suspects', []));
    for (const entry of plan.entries) suspects.delete(entry.changeId);
    this.meta.setJson('suspects', [...suspects]);
    await this.cleanup(verifying, artifacts, repository);
    if (link?.link.mode === 'mirror') await this.mirror(link, repository, artifacts, tip);
    await this.mirrorNotes(link, repository, artifacts);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return tip;
  }

  /** Not the changes' fault: put the batch back and compose it again later. */
  private async retry(key: string, verifying: Verifying, note: string, error = true) {
    const { batch, plan } = verifying;
    batch.status = 'failed'; batch.finishedAt = now(); batch.note = note; batch.requeued = named(plan.entries);
    if (error) this.meta.set('failures', String(Number(this.meta.get('failures') ?? 0) + 1));
    for (const entry of plan.entries) await this.requeue(key, entry);
    this.record(batch);
    await this.closeGitHub(verifying, `Braid will compose this batch again: ${note}`);
    await this.finishVerifying(key, verifying, error);
  }

  /** A gate rejected the combined result: blame a single change, route review comments, or narrow the suspects. */
  private async failed(key: string, verifying: Verifying, checks: ChangeCheck[], reviews: { reviewer: string; body: string; comments: { path: string; line?: number; body: string }[] }[], runs: CommandRun[] = []) {
    const { batch, plan } = verifying;
    batch.status = 'failed'; batch.finishedAt = now();
    const blame = async (entries: PlanEntry[], evidence: (entry: PlanEntry) => { checks?: ChangeCheck[]; reviews?: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[] }) => {
      for (const entry of entries) {
        this.recordAuthor(this.ctx.storage.sql.exec<{ author: string }>('SELECT author FROM queue WHERE change_id = ?', entry.changeId).toArray()[0]?.author ?? '', 'sent-back');
        this.ctx.storage.sql.exec('DELETE FROM queue WHERE change_id = ?', entry.changeId);
        batch.ejected.push({ changeId: entry.changeId, number: entry.number, reason: checks.length ? `Checks failed: ${checks.filter(check => check.status === 'failed').map(check => check.label).join(', ')}` : 'Review requested changes' });
        const found = evidence(entry);
        await this.requeue(key, entry, found.checks?.length ? found.checks : checks, found.reviews, runs);
      }
      const remaining = new Set(entries.map(entry => entry.changeId));
      this.meta.setJson('suspects', this.meta.json<string[]>('suspects', []).filter(id => !remaining.has(id)));
      this.recordOutcome(0, entries.length);
    };
    // Review comments name files, which identify the responsible changes without another round of verification.
    const commented = reviews.flatMap(review => review.comments.map(comment => ({ review, comment })));
    const touched = plan.entries.filter(entry => commented.some(({ comment }) => entry.paths.includes(comment.path)));
    if (touched.length && !checks.some(check => check.status === 'failed')) {
      batch.note = `Review comments on GitHub point at ${touched.map(entry => `#${entry.number}`).join(', ')}; ${touched.length === 1 ? 'it was' : 'they were'} sent back and the rest will merge after verification again.`;
      await blame(touched, entry => ({ reviews: reviews.map(review => ({ reviewer: `github:${review.reviewer}`, kind: 'agent' as const, verdict: 'revise' as const, summary: review.body.slice(0, 600) || 'Requested changes on GitHub.',
        findings: review.comments.filter(comment => entry.paths.includes(comment.path)).slice(0, 10).map(comment => ({ path: comment.path, ...(comment.line ? { line: comment.line } : {}), severity: 'error' as const, message: comment.body.slice(0, 500) })) })) }));
      batch.requeued = named(plan.entries.filter(entry => !touched.includes(entry)));
      for (const entry of plan.entries.filter(entry => !touched.includes(entry))) await this.requeue(key, entry);
    } else if (plan.entries.length > 1) {
      batch.note = `Checks failed on ${plan.entries.length} combined changes; narrowing down which one caused it.`; batch.requeued = named(plan.entries);
      this.meta.setJson('suspects', plan.entries.map(entry => entry.changeId));
      this.meta.set('batch-size', String(Math.max(1, Math.ceil(this.batchSize() / 2))));
      for (const entry of plan.entries) await this.requeue(key, entry);
    } else {
      const [entry] = plan.entries;
      const attempts = (this.ctx.storage.sql.exec<{ attempts: number }>('SELECT attempts FROM queue WHERE change_id = ?', entry.changeId).toArray()[0]?.attempts ?? 0) + 1;
      if (attempts <= verifying.retries) {
        // A lone failure is retried before it is blamed, in case a test was flaky.
        batch.note = `Checks failed for #${entry.number} alone; retrying once in case a test is flaky.`; batch.requeued = named([entry]);
        this.ctx.storage.sql.exec('UPDATE queue SET attempts = ? WHERE change_id = ?', attempts, entry.changeId);
        this.meta.setJson('suspects', [entry.changeId]);
        await this.requeue(key, entry);
      } else {
        batch.note = `#${entry.number} fails the repository's checks on the current main and was sent back to its author.`;
        await blame([entry], () => ({}));
      }
    }
    this.record(batch);
    await this.closeGitHub(verifying, `This batch did not merge. ${batch.note ?? ''} Braid will merge the remaining changes in a new pull request.`);
    await this.finishVerifying(key, verifying, false);
  }

  private async closeGitHub(verifying: Verifying, comment: string) {
    const state = this.linkState(), github = verifying.github;
    if (!github || !state || github.state === 'merged' || github.state === 'closed') return;
    await closePullRequest(this.env, state.link, github.pr, comment).catch(error => logFailure('github_close_failed', error));
    // The staging branch is temporary: one left on GitHub holds nothing main needs.
    await githubEndpoint(this.env, state.link, true).then(endpoint => updateRef(endpoint, `refs/heads/${github.branch}`, verifying.tip, ZERO)).catch(() => {});
  }

  private async finishVerifying(key: string, verifying: Verifying, error: boolean) {
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    await this.cleanup(verifying, artifacts, repository);
    if (this.queued()) await this.ctx.storage.setAlarm(Date.now() + (error ? Math.min(60_000, 2000 * 2 ** Math.min(Number(this.meta.get('failures') ?? 1), 5)) : 50));
  }

  private async cleanup(verifying: Verifying, artifacts: ArtifactsRepo, repository: RepositoryInfo) {
    this.dropVerifying(verifying.batch.id);
    // The staging branch is temporary: one left behind holds nothing main needs.
    const endpoint = await this.artifactsEndpoint(artifacts, repository, 'write').catch(() => null);
    if (endpoint) {
      await updateRef(endpoint, `refs/heads/${verifying.staging}`, verifying.tip, ZERO).catch(() => {});
      await endpoint.revoke();
    }
  }

  /** The commands Braid ran on a batch, as evidence for each change in it. */
  private runs(verifying: Verifying): CommandRun[] {
    return (verifying.runner?.result?.checks ?? []).map(check => ({ kind: 'command', command: check.command, exitCode: check.exitCode, output: check.output, durationMs: check.durationMs }));
  }
  private evidence(check: VerifiedCheck, tip: string, together: number, status: ChangeCheck['status']): ChangeCheck {
    const seconds = Math.round(check.durationMs / 1000);
    return { revision: 0, label: check.command, status, source: 'braid', run: { commit: tip, exitCode: check.exitCode, seconds },
      detail: `${check.phase === 'install' ? 'Install' : 'Check'} ran in a Braid sandbox on the combined result ${tip.slice(0, 7)}${together > 1 ? ` with ${plural(together - 1, 'other change')}` : ''}: exit ${check.exitCode} in ${seconds}s.${check.output ? `\n${check.output.slice(-1500)}` : ''}` };
  }
  private githubEvidence(check: { name: string; app?: string; status: string; conclusion?: string; url?: string; summary?: string }): ChangeCheck {
    const passed = check.status === 'passed' && check.conclusion !== 'neutral' && check.conclusion !== 'skipped';
    return { revision: 0, label: check.name, status: check.status === 'failed' ? 'failed' : passed ? 'passed' : 'warning', source: 'github',
      detail: `GitHub ${check.app ? `${check.app} ` : ''}check on the combined result: ${check.conclusion ?? check.status}.${check.summary ? ` ${check.summary}` : ''}${check.url ? `\n${check.url}` : ''}` };
  }
  private githubReview(review: { reviewer: string; bot: boolean; state: string; body: string; comments: { path: string; line?: number; body: string }[] }): Omit<ChangeReview, 'id' | 'revision' | 'createdAt'> {
    return { reviewer: `github:${review.reviewer}`, kind: review.bot ? 'agent' : 'human', verdict: review.state === 'approved' ? 'approve' : review.state === 'changes_requested' ? 'revise' : 'comment',
      summary: (review.body || (review.state === 'commented' ? 'Commented on the combined result without requesting changes.' : `Reviewed the combined result: ${review.state}.`)).slice(0, 600),
      findings: review.comments.slice(0, 10).map(comment => ({ path: comment.path, ...(comment.line ? { line: comment.line } : {}), severity: 'info' as const, message: comment.body.slice(0, 500) })) };
  }

  private async eject(key: string, item: { row: Row; patch: LandingPatch }, result: ComposedChange, head: string, batch: BatchSummary) {
    const conflicts: ChangeConflict[] = result.conflicts.map(conflict => ({ path: conflict.path, kind: conflict.kind, ...(conflict.regions ? { regions: conflict.regions } : {}), ...(conflict.jsonPaths ? { jsonPaths: conflict.jsonPaths } : {}) }));
    await changeShardOf(this.env, key, item.row.shard).conflicted(key, item.patch.changeId, item.patch.revision, { conflicts, against: head });
    this.recordAuthor(item.row.author, 'sent-back');
    this.ctx.storage.sql.exec('DELETE FROM queue WHERE change_id = ? AND revision = ?', item.patch.changeId, item.patch.revision);
    batch.ejected.push({ changeId: item.patch.changeId, number: item.patch.number, reason: `Conflicts in ${conflicts.map(conflict => conflict.path).slice(0, 3).join(', ')}` });
  }

  /** Records a landed batch. Safe to repeat after an interruption: every callback is idempotent. */
  private async finalize(key: string, batch: BatchSummary, plan: Plan, commits: string[], tip: string, evidence: ChangeCheck[] = [], reviews: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[] = [], runs: CommandRun[] = []) {
    const commitOf = (entry: PlanEntry) => entry.commit === null ? tip : commits[entry.commit];
    // Each change's commit sits on the one before it, so its parent is exactly main without it.
    const parentOf = (entry: PlanEntry) => entry.commit === null ? undefined : entry.commit === 0 ? plan.head : commits[entry.commit - 1];
    // Every change's shard hears at once, and the batch records them in plan order. A shard that could not be told
    // fails the batch once the others are recorded; recovery tells it again, and telling a shard twice changes nothing.
    const told = await Promise.allSettled(plan.entries.map(entry => {
      const parent = parentOf(entry);
      // A review of the combined result reaches each change with only the comments on that change's files.
      const own = reviews.map(review => ({ ...review, findings: review.findings.filter(finding => !finding.path || entry.paths.includes(finding.path)) }))
        .filter(review => review.findings.length || !reviews.some(other => other.reviewer === review.reviewer && other.findings.length) || review.verdict !== 'comment');
      return changeShardOf(this.env, key, entry.shard).landed(key, entry.changeId, entry.revision, { commit: commitOf(entry), ...(parent ? { parent } : {}), batchId: batch.id, strategies: entry.strategies, checks: evidence, reviews: own, runs });
    }));
    plan.entries.forEach((entry, index) => {
      if (told[index].status === 'rejected') return;
      const author = this.ctx.storage.sql.exec<{ author: string }>('SELECT author FROM queue WHERE change_id = ?', entry.changeId).toArray()[0]?.author;
      if (author) this.recordAuthor(author, 'landed');
      this.ctx.storage.sql.exec('DELETE FROM queue WHERE change_id = ? AND revision = ?', entry.changeId, entry.revision);
      batch.landed.push({ changeId: entry.changeId, number: entry.number, commit: commitOf(entry) });
      for (const strategy of Object.values(entry.strategies)) batch.strategies[strategy] = (batch.strategies[strategy] ?? 0) + 1;
    });
    const unreachable = told.find(result => result.status === 'rejected');
    if (unreachable) throw unreachable.reason;
    if (commits.length) await this.attribution.recordLanding(key, plan.entries.flatMap(entry => entry.commit === null || !entry.who ? [] : [{ commit: commits[entry.commit], parent: parentOf(entry)!, paths: entry.paths,
      change: { changeId: entry.changeId, number: entry.number, revision: entry.revision, title: entry.title, ...entry.who } }]));
    batch.status = 'landed'; batch.head = tip; batch.finishedAt = now();
    this.headCache = { at: Date.now(), head: tip };
    this.meta.set('head', tip);
    this.meta.delete('active-plan', 'failures');
    this.content.delete(`plan:${batch.id}`);
    this.recordOutcome(plan.entries.length, 0);
    if (!batch.ejected.length) this.meta.set('batch-size', String(Math.min(MAX_BATCH, this.batchSize() * 2)));
    this.record(batch);
    if (commits.length) await this.env.WORKSPACES.getByName(key).trunkAdvanced(tip, { batchId: batch.id, landed: batch.landed.length, ejected: batch.ejected.length }).catch(error => logFailure('trunk_advanced_failed', error));
  }

  /** After an interruption, a prepared direct push either landed (finish it) or did not (compose again). */
  private async recover(key: string) {
    const id = this.meta.get('active-plan');
    if (!id) return;
    const plan = this.content.get<Plan>(`plan:${id}`);
    if (plan?.prepared?.length) {
      const repository = await this.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      if (await this.head(artifacts, repository) === plan.prepared.at(-1)) {
        const batch: BatchSummary = { id, status: 'pushing', base: plan.head, startedAt: now(), landed: [], ejected: [], strategies: {} };
        await this.finalize(key, batch, plan, plan.prepared, plan.prepared.at(-1)!);
        return;
      }
    }
    this.meta.delete('active-plan');
  }

  private record(batch: BatchSummary) {
    this.ctx.storage.sql.exec('INSERT INTO batches (id, started_at, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', batch.id, batch.startedAt, JSON.stringify(batch));
    this.ctx.storage.sql.exec('DELETE FROM batches WHERE id NOT IN (SELECT id FROM batches ORDER BY started_at DESC LIMIT ?)', RECENT_BATCHES);
    if (batch.status !== 'landed' && batch.status !== 'failed') return;
    const stats = this.meta.json<TrunkStatus['stats']>('stats', { landed: 0, ejected: 0, batches: 0, strategies: {}, since: now() });
    stats.batches++; stats.landed += batch.landed.length; stats.ejected += batch.ejected.length;
    for (const [strategy, count] of Object.entries(batch.strategies) as [LandingStrategy, number][]) stats.strategies[strategy] = (stats.strategies[strategy] ?? 0) + count;
    this.meta.setJson('stats', stats);
  }

  /* ---------- provenance, notes and blame (attribution.ts) ---------- */

  blame(key: string, path: string, ref?: string, cacheOnly = false, network?: string): Promise<Result<FileBlame>> { return this.attribution.blame(key, path, ref, cacheOnly, network); }
  warmBlame(key: string, head: string): Promise<void> { return this.attribution.warmBlame(key, head); }
  provenance(key: string, commits: string[], cacheOnly = false): Promise<Provenance[]> { return this.attribution.provenance(key, commits, cacheOnly); }
  notesHead(key: string): Promise<string | null> { return this.attribution.notesHead(key); }
  async agentLines(key: string, readOnly = false, contributors = false): Promise<Record<string, AgentLineTotals>> {
    if (!readOnly) this.bind(key);
    return this.attribution.agentLines(contributors);
  }

  /** Copies refs/notes/braid to the linked GitHub repository, as a fast-forward of what Braid copied there last. */
  private async mirrorNotes(state: LinkState | undefined, repository: RepositoryInfo, artifacts: ArtifactsRepo) {
    const head = this.meta.get('notes');
    if (!state || !head || state.notes === head || state.status !== 'synced') return;
    const source = await this.artifactsEndpoint(artifacts, repository, 'read');
    try {
      await relay({ source, target: await githubEndpoint(this.env, state.link, true), want: head, ref: NOTES_REF, expected: state.notes ?? ZERO, have: state.notes ? [state.notes] : [] });
      state.notes = head;
      this.saveLink(state);
    } catch (error) { logFailure('notes_mirror_failed', error); }
    finally { await source.revoke(); }
  }
  /** Retries notes a landing could not write. Returns whether any are still pending. */
  private async retryNotes(): Promise<boolean> {
    const key = this.meta.get('repository');
    if (!key || !this.attribution.notesPending()) return false;
    try {
      const repository = await this.repository(key);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      await this.attribution.publishNotes(repository, artifacts);
      await this.mirrorNotes(this.linkState(), repository, artifacts);
    } catch (error) { logFailure('notes_failed', error); }
    return this.attribution.notesPending();
  }
}
