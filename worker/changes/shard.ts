import { DurableObject } from 'cloudflare:workers';
import { artifactsOf, directoryOf, securityOf, type BraidEnv } from '../env';
import type { AgentCheck, Change, ChangeAuthor, ChangeComment, ChangeComparison, ChangeDiff, ChangeCheck, ChangeCloseReason, ChangeConflict, ChangeCounts, ChangeEvent, ChangeFile, ChangeOverlap, ChangeReview, ChangeStatus, ChangeSummary, EvidenceInput, EvidenceSource, Instruction, LandingStrategy, LocalTestReport, PolicyRequirement, ProvenanceOwner } from '../../shared/types';
import { editedFiles, editContent, isBlobEdit, type GitFileEdit } from '../git/edits';
import { evaluatePolicy, revisionRequested, type Policy } from '../../shared/policy';
import { addedBraidTokens, secretFindings, SECRET_SCAN_VERSION } from '../../shared/secrets';
import { guardFindings, instructionFindings, type GuardFinding, type GuardFile } from '../../shared/guards';
import { AGENTS_PATH, editInstructions, INSTRUCTIONS_PATH, parseInstructions, withInstructions, type InstructionEdit } from '../../shared/instructions-file';
import { matchesAny } from '../../shared/glob';
import { introducedDependencies, type Dependency } from '../../shared/dependencies';
import { dependencyReview } from './advisories';
import { checkStateOf, labelFor } from '../../shared/questions';
import { plural } from '../../shared/labels';
import { textDiffStats } from '../../shared/diff';
import { checkAuthorization, type Authorization } from '../http/authorization';
import { artifactsFailed, HttpError, logFailure, refused, unwrap, type Result } from '../errors';
import { notifyPullRequest } from '../accounts/notify';
import { digest } from '../http/auth';
import { ContentStore } from '../workspace/content';
import { ChangeRecords } from './records';
import { checkSize, closing, LIMITS, parse, restack as restackBody, review as reviewBody, revision as revisionBody, submission, type SubmissionFile } from '../schemas';
import { composeChanges, TreeSnapshot } from './compose';
import { blobText, gitBlobHash } from '../git/objects';
import { scanBlob } from '../git/scan';
import { GitError } from '../git/transport';
import { CacheMiss, ObjectCache } from './cache';
import { CHANGE_SHARDS, byPathShard, changeId, changeShardOf, pathShard, pathShardOf, repositoryParts, shardOf, trunkOf } from './names';
import { outdatedReason, waitingReason, type StackNode } from './stacks';
import { hostedReview, simulatedReview, REVIEW_INPUT_CHARS, type ReviewInput } from './review';
import { decodeEvidence, imageType, keptEvidence, outputTail, type CommandRun, type Reported } from './evidence';
import type { PushedCommit } from '../git/history';
import { agentName, byline, personName } from '../repositories/provenance';
import { agentKey } from '../../shared/models';
import { addComment, approvalWithComment, commentBody, commentId, moveAnchor, resolveBody, resolveComment, reviewCommentText, unresolvedComments } from './comments';
import type { ChangeGuide } from '../../shared/guide';
import { explicitGuideAttributes, type AttributeFile } from '../../shared/git-attributes';
import { GuideStore } from './guide-store';
import { GUIDE_MODEL, GuideInputError, type GuideDescription, type GuideInput } from './guide';
import { publicMetadata } from '../http/public-view';
import { now } from '../workspace/domain';
import { addColumn, Meta } from '../sql';

/** Cosine similarity above which two stated intents are treated as the same work. */
const DUPLICATE_SIMILARITY = 0.92;

/** Who acts. An agent carries its model when its token names one, the person who owns its work, and the fleet that minted it. */
export interface Actor { kind: 'owner' | 'viewer' | 'agent' | 'system'; id: string; name: string; model?: string; simulated?: boolean; owner?: ProvenanceOwner; fleet?: string }
/**
 * `system` marks Braid's own callers (task results, reverts and instruction
 * changes), which may carry a `.braid/missions/` capsule or the instructions
 * file, and the checks their agents ran (`checks`, command runs included).
 * `approvedBy` names the owner who reviewed exactly this content before Braid
 * submitted it, such as a task result they chose to land; only system callers
 * may set it.
 */
export interface ChangeContext { repository: string; shard: number; actor: Actor; system?: boolean; approvedBy?: string; fileAuthors?: Record<string, ChangeAuthor>; checks?: AgentCheck[]; headCommit?: string; retainHead?: boolean; dependencyPins?: { parent: string; revision: number }[]; authorization?: Authorization }
export interface LandingPatch {
  changeId: string; number: number; revision: number; title: string; summary: string; baseCommit: string;
  files: Record<string, GitFileEdit>; author: ChangeAuthor; fileAuthors?: Record<string, ChangeAuthor>; autonomy?: string;
  /** Who approved this revision: the person first, then approving reviewers. */
  approvals: string[]; taskId?: string;
  /** Co-author lines the revision's commits carried, for its landed commit. */
  coAuthors: string[];
}
/** One agent's record in a shard: its changes by status, and what its changes were and how they fared. */
export interface AgentStats {
  key: string; kind: 'agent' | 'simulated'; name: string; owner?: ProvenanceOwner; fleet?: string; models: string[]; tools: string[];
  firstActive: string; lastActive: string; sentBack: number; reverted: number; counts: Partial<ChangeCounts>;
  /** The change author ids this record groups, such as one fleet's agents on the same model. */
  authors: string[];
}
export interface RepositoryInfo { id: string; branch: string; remote: string; head: string }
type TaskNotice = { id: string; number: number; status: ChangeStatus; commit?: string; reason?: string };
type Stored = Change & { internal: { approvedRevision?: number; approver?: string; conflictRevision?: number; enqueued?: boolean; reviewAttempts?: number; sentBack?: number; revokedTokens?: number; unreviewed?: boolean } };
type Run = { tool?: string; session?: string; parentSession?: string };
/** A revision's content: its base, its files, and the co-author lines its commits carried. */
type Patch = { baseCommit: string; files: Record<string, GitFileEdit>; fileAuthors?: Record<string, ChangeAuthor>; coAuthors?: string[]; secrets?: boolean; secretScanVersion?: number };
type Receipt = { signature: string; prior?: string; keep(change: { id: string; revision: number }): void };

const OPEN: ChangeStatus[] = ['open', 'revise', 'attention', 'queued', 'landing'];
const REVISABLE: ChangeStatus[] = ['open', 'revise', 'attention', 'queued'];
const EVENT_LIMIT = 60;

function summary(change: Stored): ChangeSummary {
  const checkState = checkStateOf(change);
  return { id: change.id, number: change.number, title: change.title, status: change.status, ...(change.closeReason ? { closeReason: change.closeReason } : {}),
    author: change.author, ...(change.risk ? { risk: change.risk } : {}), ...(change.autonomy ? { autonomy: change.autonomy } : {}), revision: change.revision,
    files: change.files.length, additions: change.additions, deletions: change.deletions, ...(change.taskId ? { taskId: change.taskId } : {}),
    ...(change.headCommit ? { headCommit: change.headCommit } : {}),
    ...(change.landedCommit ? { landedCommit: change.landedCommit } : {}), createdAt: change.createdAt, updatedAt: change.updatedAt, ...(change.next ? { next: change.next } : {}),
    ...(change.label ? { label: change.label } : {}), ...(checkState ? { checkState } : {}), commentCount: change.commentCount ?? 0,
    ...(change.dependsOn ? { dependsOn: change.dependsOn, waitingOn: change.waitingOn } : {}) };
}
/** Why a change came back after others landed first, in words for its author and for people. */
function conflictNext(conflicts: ChangeConflict[]) {
  const paths = conflicts.map(conflict => conflict.path);
  return `Conflicts with work that landed first in ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}.`;
}
const reviewId = () => `rv_${crypto.randomUUID().slice(0, 12)}`;
const totals = (files: ChangeFile[]) => ({ additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) });
function publicChange(change: Stored): Change {
  const { internal: _internal, ...rest } = change;
  return rest;
}

/**
 * One shard of a repository's changes. Each change carries its own policy
 * decision, reviews, checks and history; trunk callbacks move it through the
 * landing queue. Patches stay here until they land, never in a snapshot.
 */
export class ChangeShard extends DurableObject<BraidEnv> {
  private content: ContentStore;
  private records: ChangeRecords<Stored>;
  private cache: ObjectCache;
  private guides: GuideStore;
  private meta: Meta;
  private policyCache?: { at: number; repository: string; value: { policy: Policy; head: string; instructions: Instruction[] } };
  private authorCache = new Map<string, { at: number; landed: number }>();
  private repositoryCache?: { at: number; key: string; value: RepositoryInfo };
  private pushing: Promise<void> = Promise.resolve();
  private serial = new Map<string, Promise<unknown>>();
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, author_id TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS changes_status ON changes(status, updated_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS changes_updated ON changes(updated_at, id)');
    sql.exec('CREATE INDEX IF NOT EXISTS changes_author ON changes(author_id, updated_at)');
    this.meta = new Meta(sql);
    sql.exec('CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, signature TEXT NOT NULL, change_id TEXT NOT NULL, revision INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_notices (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS stack_waiters (id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL)');
    // Separate from status writes, so an in-flight review or queue callback cannot overwrite a conversation.
    sql.exec('CREATE TABLE IF NOT EXISTS review_comments (change_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS review_jobs (change_id TEXT NOT NULL, revision INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (change_id, revision))');
    // The latest news for a task whose workspace could not be told yet; retried until it arrives.
    sql.exec('CREATE TABLE IF NOT EXISTS task_notices (change_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL)');
    // Normalized intent embeddings of active changes, compared to catch duplicated work early.
    sql.exec('CREATE TABLE IF NOT EXISTS intents (change_id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, vector BLOB NOT NULL, active INTEGER NOT NULL)');
    // Each agent's record for the fleet roster: changes count by status through agent_key, the rest is kept as they are written.
    addColumn(sql, 'changes', 'agent_key', 'TEXT');
    addColumn(sql, 'changes', 'summary', 'TEXT');
    sql.exec('CREATE INDEX IF NOT EXISTS changes_agent ON changes(agent_key, status)');
    sql.exec('CREATE TABLE IF NOT EXISTS agent_stats (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // `git push … refs/for/main%topic=<name>`: the change each author's topic names and the commit pushed to it last.
    sql.exec('CREATE TABLE IF NOT EXISTS topics (author_id TEXT NOT NULL, topic TEXT NOT NULL, change_id TEXT NOT NULL, pushed TEXT NOT NULL, PRIMARY KEY (author_id, topic))');
    // Every commit a push carried, with whether its snapshot added a secret, by the revision it arrived in.
    sql.exec('CREATE TABLE IF NOT EXISTS pushed_commits (commit_hash TEXT NOT NULL, change_id TEXT NOT NULL, revision INTEGER NOT NULL, secrets INTEGER NOT NULL, PRIMARY KEY (commit_hash, change_id, revision))');
    sql.exec("CREATE INDEX IF NOT EXISTS changes_head ON changes(json_extract(value, '$.headCommit'))");
    this.content = new ContentStore(ctx.storage);
    this.records = new ChangeRecords(this.content);
    this.cache = new ObjectCache(sql);
    this.guides = new GuideStore(sql);
    this.migrateAgentKeys();
  }

  /* ---------- storage ---------- */

  private migrateAgentKeys() {
    if (this.meta.get('agent-key-version') === '2') return;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const stats = new Map(sql.exec<{ key: string; value: string }>('SELECT key, value FROM agent_stats').toArray().map(row => [row.key, JSON.parse(row.value) as AgentStats]));
      const groups = new Map<string, { oldKeys: Set<string>; changes: Stored[] }>();
      const destinations = new Map<string, Set<string>>();
      for (const row of sql.exec<{ agent_key: string | null; value: string }>('SELECT agent_key, value FROM changes').toArray()) {
        const change = this.records.read(row.value), key = agentKey(change.author);
        if (!key) continue;
        const oldKey = row.agent_key ?? key;
        const group = groups.get(key) ?? { oldKeys: new Set<string>(), changes: [] };
        group.oldKeys.add(oldKey); group.changes.push(change); groups.set(key, group);
        destinations.set(oldKey, new Set([...destinations.get(oldKey) ?? [], key]));
        sql.exec('UPDATE changes SET agent_key = ? WHERE id = ?', key, change.id);
      }
      sql.exec('DELETE FROM agent_stats');
      for (const [key, group] of groups) {
        const oldKey = [...group.oldKeys][0], previous = stats.get(oldKey);
        if (previous && group.oldKeys.size === 1 && destinations.get(oldKey)!.size === 1)
          sql.exec('INSERT INTO agent_stats VALUES (?, ?)', key, JSON.stringify({ ...previous, key }));
        else for (const change of group.changes) this.recordAgent(key, change, change.status === 'revise' ? 'open' : change.status, { reverted: change.revertedBy ? 1 : 0 });
      }
      this.meta.set('agent-key-version', '2');
    });
  }

  private load(reference: string): Stored | undefined {
    const row = /^\d+$/.test(reference)
      ? this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM changes WHERE number = ?', Number(reference)).toArray()[0]
      : this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM changes WHERE id = ?', reference).toArray()[0];
    if (!row) return undefined;
    const change = this.records.read(row.value);
    change.comments = this.commentsFor(change.id) ?? change.comments ?? [];
    change.commentCount = change.comments.length;
    return change;
  }
  private require(reference: string): Stored {
    const change = this.load(reference);
    if (!change) throw new HttpError(404, 'Change not found.');
    return change;
  }
  private write(change: Stored) {
    this.ctx.storage.sql.exec('INSERT INTO stack_notices (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', change.id, JSON.stringify(this.stackNode(change)));
    if (OPEN.includes(change.status) && change.dependsOn?.some(item => item.status !== 'landed' && item.status !== 'closed')) {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO stack_waiters (id, checked_at) VALUES (?, 0)', change.id);
      void this.wakeBy(Date.now() + 5_000);
    } else this.ctx.storage.sql.exec('DELETE FROM stack_waiters WHERE id = ?', change.id);
    change.comments = this.commentsFor(change.id) ?? change.comments ?? [];
    change.commentCount = change.comments.length;
    if (change.status === 'landed' || change.status === 'closed') this.ctx.storage.sql.exec('UPDATE intents SET active = 0 WHERE change_id = ?', change.id);
    change.updatedAt = now();
    change.events = change.events.slice(-EVENT_LIMIT);
    const key = agentKey(change.author);
    const previous = this.ctx.storage.sql.exec<{ status: ChangeStatus; revision: number }>("SELECT status, json_extract(value, '$.revision') AS revision FROM changes WHERE id = ?", change.id).toArray()[0];
    this.ctx.storage.transactionSync(() => {
      const value = this.records.write(change);
      this.ctx.storage.sql.exec('INSERT INTO changes (id, number, status, author_id, task_id, created_at, updated_at, value, agent_key, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, value = excluded.value, agent_key = excluded.agent_key, summary = excluded.summary',
        change.id, change.number, change.status, change.author.id, change.taskId ?? null, change.createdAt, change.updatedAt, value, key, JSON.stringify(summary(change)));
    });
    if (key) this.recordAgent(key, change, previous?.status);
    if (previous?.revision !== change.revision) this.scheduleGuide(change);
    if (this.env.DIRECTORY) this.meta.set('directory-activity', change.updatedAt);
    // Every path to a person's decision or a send-back persists here: policy, reviews, CI and conflicts. A new state or
    // revision notifies; the Directory drops repeats. The example and single-owner repositories have no workspace id.
    if ((change.status === 'attention' || change.status === 'revise') && (previous?.status !== change.status || previous.revision !== change.revision)) {
      const workspaceId = repositoryParts(this.meta.get('repository'))?.workspaceId;
      if (workspaceId) notifyPullRequest(this.env, this.ctx, { workspaceId, kind: change.status === 'attention' ? 'attention' : 'returned',
        change: { id: change.id, number: change.number, title: change.title, author: change.author, label: change.label, revision: change.revision },
        reason: change.next ?? change.label ?? (change.status === 'attention' ? 'An owner needs to review this pull request.' : 'Changes were requested.') });
    }
  }
  /**
   * Keeps an agent's record as its changes are written. A change counts as sent back once each time it goes back to
   * its author for its own reasons; conflicts with work that landed first are not the agent's doing.
   */
  private recordAgent(key: string, change: Stored, previous: ChangeStatus | undefined, extra: { reverted?: number } = {}) {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM agent_stats WHERE key = ?', key).toArray()[0];
    const stats: Omit<AgentStats, 'counts' | 'authors'> = row ? JSON.parse(row.value) : { key, kind: change.author.kind, name: '', models: [], tools: [], firstActive: change.createdAt, lastActive: change.updatedAt, sentBack: 0, reverted: 0 };
    const conflict = change.conflicts.length > 0 && change.internal.conflictRevision === change.revision;
    const add = (list: string[], value?: string) => value && !list.includes(value) ? [...list, value].slice(-10) : list;
    Object.assign(stats, {
      kind: change.author.kind, name: agentName(change.author.model, change.author.tool) ?? change.author.name, models: add(stats.models, change.author.model), tools: add(stats.tools, change.author.tool),
      ...(change.author.owner ? { owner: change.author.owner } : {}), ...(change.author.fleet ? { fleet: change.author.fleet } : {}),
      firstActive: change.createdAt < stats.firstActive ? change.createdAt : stats.firstActive, lastActive: change.updatedAt > stats.lastActive ? change.updatedAt : stats.lastActive,
      sentBack: stats.sentBack + (previous !== undefined && previous !== 'revise' && change.status === 'revise' && !conflict && !change.outdated?.length ? 1 : 0), reverted: stats.reverted + (extra.reverted ?? 0),
    });
    this.ctx.storage.sql.exec('INSERT INTO agent_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(stats));
  }
  private event(change: Stored, type: ChangeEvent['type'], message: string, actor?: string, facts: Pick<ChangeEvent, 'duplicates' | 'requirement' | 'revision' | 'base'> = {}) {
    change.events.push({ at: now(), type, message: message.slice(0, 600), ...(actor ? { actor } : {}), ...facts });
  }
  private async publishActivity() {
    const at = this.meta.get('directory-activity'), repository = this.meta.get('repository');
    const workspaceId = repositoryParts(repository)?.workspaceId;
    if (!at || !workspaceId || !this.env.DIRECTORY) return;
    try {
      await directoryOf(this.env).repositoryActivity(workspaceId, at);
      if (this.meta.get('directory-activity') === at) this.meta.delete('directory-activity');
    } catch { await this.wakeBy(Date.now() + 5_000); }
  }
  private async guard<T>(run: () => Promise<T>, readOnly = false): Promise<Result<T>> {
    try { return { ok: true, data: await run() }; }
    catch (error) {
      if (!(error instanceof HttpError)) logFailure('change_operation_failed', error);
      return refused(error, 500, 'The change operation could not complete. Retry with the same request key.');
    } finally {
      // A write's answer does not wait on the directory, one object every repository shares. The time stays in meta
      // until the directory has it, the directory keeps the later of two times, and a failed publish retries from the alarm.
      if (!readOnly) { await this.publishStacks(); this.ctx.waitUntil(this.publishActivity()); }
    }
  }

  /* ---------- repository, policy and neighbours ---------- */

  private async repository(key: string): Promise<RepositoryInfo> {
    if (this.repositoryCache?.key === key && Date.now() - this.repositoryCache.at < 60_000) return this.repositoryCache.value;
    const info = await this.env.WORKSPACES.getByName(key).repository();
    if (!info) throw new HttpError(409, 'Create or import a live repository before submitting changes.');
    this.repositoryCache = { at: Date.now(), key, value: info };
    return info;
  }
  private stackNode(change: Change): StackNode {
    return { id: change.id, number: change.number, revision: change.revision, status: change.status, baseCommit: change.baseCommit, ...(change.headCommit ? { headCommit: change.headCommit } : {}), ...(change.landedCommit ? { landedCommit: change.landedCommit } : {}) };
  }
  /** The graph learns terminal outcomes durably; a lost RPC keeps its notice for the alarm. */
  private async publishStacks() {
    const key = this.meta.get('repository');
    if (!key) return;
    const notices = this.ctx.storage.sql.exec<{ id: string; value: string }>('SELECT id, value FROM stack_notices LIMIT 50').toArray();
    if (!notices.length) return;
    try {
      await trunkOf(this.env, key).observeChanges(key, notices.map(row => JSON.parse(row.value) as StackNode));
      for (const row of notices) this.ctx.storage.sql.exec('DELETE FROM stack_notices WHERE id = ? AND value = ?', row.id, row.value);
    } catch { await this.wakeBy(Date.now() + 5_000); }
  }
  /** A narrow read avoids recursive graph calls while resolving repository-local references. */
  dependencyNode(reference: string): Result<StackNode> {
    const change = this.load(reference);
    return change ? { ok: true, data: this.stackNode(change) } : { ok: false, status: 404, error: 'Dependency not found in this repository.' };
  }
  private async setDependencies(key: string, change: Stored, declared: (number | string)[] | undefined, signature: string, pins?: { parent: string; revision: number }[]) {
    const trunk = trunkOf(this.env, key);
    const inferred = declared === undefined ? await trunk.dependencyHeads(change.baseCommit) : [];
    const references = [...new Set([...(declared ?? change.dependsOn?.map(item => item.id) ?? []), ...inferred.filter(item => item.id !== change.id).map(item => item.id)])];
    const nodes = await Promise.all(references.map(async reference => {
      const shard = typeof reference === 'number' ? await trunk.shardForNumber(reference) : shardOf(reference);
      if (shard === null) throw new HttpError(404, `Dependency ${reference} was not found in this repository.`);
      const result = await changeShardOf(this.env, key, shard).dependencyNode(String(reference));
      if (!result.ok) throw new HttpError(result.status, `Dependency ${reference} was not found in this repository.`);
      return result.data;
    }));
    const unique = [...new Map(nodes.map(node => [node.id, node])).values()];
    if (unique.length > 16) throw new HttpError(400, 'A pull request can depend on at most 16 pull requests.');
    change.dependsOn = unwrap(await trunk.setDependencies(key, this.stackNode(change), unique, signature, declared === undefined && change.revision > 1, pins));
  }
  private async policy(key: string) {
    if (this.policyCache?.repository === key && Date.now() - this.policyCache.at < 15_000) return this.policyCache.value;
    const value = await trunkOf(this.env, key).policy(key);
    this.policyCache = { at: Date.now(), repository: key, value };
    return value;
  }
  private async landedBy(key: string, author: string) {
    const cached = this.authorCache.get(author);
    if (cached && Date.now() - cached.at < 30_000) return cached.landed;
    const { landed } = await trunkOf(this.env, key).author(key, author);
    this.authorCache.set(author, { at: Date.now(), landed });
    return landed;
  }
  private async registerPaths(key: string, change: Stored, previous: string[] = []): Promise<ChangeOverlap[]> {
    const paths = change.files.map(file => file.path);
    const groups = byPathShard(paths);
    // A revision that no longer touches a shard's paths releases them there.
    for (const shard of new Set(previous.map(pathShard))) if (!groups.has(shard)) await pathShardOf(this.env, key, shard).release(change.id);
    const claim = { changeId: change.id, number: change.number, title: change.title, status: change.status, author: change.author.name };
    const results = await Promise.all([...groups].map(([shard, group]) => pathShardOf(this.env, key, shard).register(claim, group)));
    const overlaps = new Map<string, ChangeOverlap>();
    for (const result of results) for (const [path, claims] of Object.entries(result)) for (const other of claims) {
      const overlap = overlaps.get(other.changeId) ?? { changeId: other.changeId, number: other.number, title: other.title, status: other.status, paths: [] };
      overlap.paths.push(path); overlaps.set(other.changeId, overlap);
    }
    return [...overlaps.values()].sort((a, b) => b.paths.length - a.paths.length).slice(0, 20);
  }
  /** Tells the task a change came from that it landed, was sent back or closed; a task is never left waiting on a change that already merged. */
  private async notifyTask(key: string, change: Stored) {
    if (!change.taskId) return;
    const notice: TaskNotice = { id: change.id, number: change.number, status: change.status,
      ...(change.landedCommit ? { commit: change.landedCommit } : {}), ...(change.closeReason ? { reason: change.closeReason } : change.status === 'revise' && change.next ? { reason: change.next } : {}) };
    try { await this.env.WORKSPACES.getByName(key).taskChange(change.taskId, notice); }
    catch {
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO task_notices (change_id, task_id, value, attempts, due) VALUES (?, ?, ?, 0, ?)', change.id, change.taskId, JSON.stringify(notice), Date.now() + 5_000);
      await this.wakeBy(Date.now() + 5_000);
    }
  }
  private async deliverTaskNotices(key: string) {
    const due = this.ctx.storage.sql.exec<{ change_id: string; task_id: string; value: string; attempts: number }>('SELECT change_id, task_id, value, attempts FROM task_notices WHERE due <= ? LIMIT 25', Date.now()).toArray();
    for (const row of due) {
      try {
        await this.env.WORKSPACES.getByName(key).taskChange(row.task_id, JSON.parse(row.value) as TaskNotice);
        this.ctx.storage.sql.exec('DELETE FROM task_notices WHERE change_id = ? AND value = ?', row.change_id, row.value);
      } catch {
        this.ctx.storage.sql.exec('UPDATE task_notices SET attempts = attempts + 1, due = ? WHERE change_id = ?', Date.now() + Math.min(600_000, 5_000 * 2 ** row.attempts), row.change_id);
      }
    }
  }
  /** Moves the alarm earlier if `at` comes first. */
  private async wakeBy(at: number) {
    const scheduled = await this.ctx.storage.getAlarm();
    if (!scheduled || at < scheduled) await this.ctx.storage.setAlarm(at);
  }
  /** Moves the change's claims in the path index. The index only informs agents, so a failure is logged and never fails the change. */
  private async indexStatus(key: string, change: Stored) {
    const shards = new Set(change.files.map(file => pathShard(file.path)));
    try { await Promise.all([...shards].map(shard => change.status === 'landed' || change.status === 'closed' ? pathShardOf(this.env, key, shard).release(change.id) : pathShardOf(this.env, key, shard).status(change.id, change.status))); }
    catch (error) { logFailure('path_index_failed', error, { changeId: change.id, status: change.status }); }
  }

  /* ---------- duplicates ---------- */

  /** A normalized embedding of what the change says it does; null when no model is available or it fails. */
  private async intentVector(change: Stored): Promise<Float32Array | null> {
    if (!this.env.AI || change.author.kind === 'simulated') return null;
    try {
      const result = await this.env.AI.run('@cf/baai/bge-base-en-v1.5' as Parameters<Ai['run']>[0], { text: [`${change.title}\n${change.intent}\n${change.summary}`.slice(0, 2000)] } as never) as { data?: number[][] };
      const values = result.data?.[0];
      if (!Array.isArray(values) || values.length < 16) return null;
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
      return Float32Array.from(values, value => value / norm);
    } catch (error) {
      logFailure('intent_embedding_failed', error, { changeId: change.id });
      return null;
    }
  }

  /** Active changes in this shard whose intent is nearly the same as the given one. */
  similar(vector: number[], exclude: string, threshold: number): { changeId: string; number: number; title: string; similarity: number }[] {
    const query = Float32Array.from(vector), found = [];
    for (const row of this.ctx.storage.sql.exec<{ change_id: string; number: number; title: string; vector: ArrayBuffer }>('SELECT change_id, number, title, vector FROM intents WHERE active = 1 AND change_id != ?', exclude)) {
      const other = new Float32Array(row.vector);
      if (other.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < other.length; i++) dot += other[i] * query[i];
      if (dot >= threshold) found.push({ changeId: row.change_id, number: row.number, title: row.title, similarity: Math.round(dot * 1000) / 1000 });
    }
    return found.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  }

  private async findDuplicates(key: string, change: Stored) {
    const vector = await this.intentVector(change);
    if (!vector) return;
    this.ctx.storage.sql.exec('INSERT INTO intents (change_id, number, title, vector, active) VALUES (?, ?, ?, ?, 1) ON CONFLICT(change_id) DO UPDATE SET title = excluded.title, vector = excluded.vector, active = 1',
      change.id, change.number, change.title.slice(0, 200), vector.slice().buffer);
    const shards = await Promise.all(Array.from({ length: CHANGE_SHARDS }, async (_, shard) => {
      try { return await changeShardOf(this.env, key, shard).similar([...vector], change.id, DUPLICATE_SIMILARITY); }
      catch (error) {
        logFailure('duplicate_check_failed', error, { changeId: change.id, shard });
        return [];
      }
    }));
    const duplicates = shards.flat().sort((a, b) => b.similarity - a.similarity).slice(0, 3);
    if (duplicates.length) {
      change.duplicates = duplicates;
      this.event(change, 'overlap', `Possible duplicate of ${duplicates.map(duplicate => `#${duplicate.number} ${duplicate.title}`).join(', ')}.`, undefined,
        { duplicates: duplicates.map(({ number, title }) => ({ number, title })) });
    } else delete change.duplicates;
  }

  /* ---------- status ---------- */

  /** Applies policy to the current revision and moves the change between author, reviewers, people and the queue. */
  private async settle(key: string, change: Stored) {
    if (!REVISABLE.includes(change.status)) return;
    const { policy } = await this.policy(key);
    const subject = { paths: change.files.map(file => file.path), additions: change.additions, deletions: change.deletions, revision: change.revision,
      author: change.author, reviews: change.reviews, checks: change.checks, approved: change.internal.approvedRevision === change.revision,
      guards: change.guards ?? [], duplicates: change.duplicates ?? [], history: { landed: await this.landedBy(key, change.author.id), sentBack: change.internal.sentBack ?? 0 } };
    const decision = evaluatePolicy(policy, subject);
    if (change.internal.unreviewed) decision.requirements.push({ id: 'risk', label: 'File review', satisfied: subject.approved, detail: 'This pull request includes binary or large files outside line review. An owner must review this revision.' });
    change.policy = decision; change.autonomy = decision.autonomy;
    const risks = change.reviews.filter(review => review.revision === change.revision && review.risk).map(review => review.risk!);
    change.risk = risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : risks.length ? 'low' : undefined;
    const asks = revisionRequested(subject, policy);
    const unmet = decision.requirements.filter(requirement => !requirement.satisfied);
    const previous = change.status;
    const handover = unmet.find(requirement => ['risk', 'guard', 'rounds', 'duplicate'].includes(requirement.id)), other = unmet.find(requirement => requirement.id !== 'checks');
    let asked: PolicyRequirement | undefined, sentBack: Change['sentBack'];
    if (change.conflicts.length && change.internal.conflictRevision === change.revision) {
      sentBack = 'conflicts'; change.status = 'revise'; change.next = conflictNext(change.conflicts);
    } else if (asks) {
      sentBack = asks[0].from; change.status = 'revise'; change.next = asks[0].text.slice(0, 200);
    } else if (handover) {
      // A reviewer, a guard, repeated failures or a likely duplicate handed the decision to a person; more reviews would not change that.
      asked = handover; change.status = 'attention'; change.next = handover.detail.slice(0, 200);
    } else if (unmet.some(requirement => requirement.id === 'reviews')) {
      // Reviewers go first, so a person who must decide sees their verdicts instead of a raw diff.
      change.status = 'open'; change.next = unmet.find(requirement => requirement.id === 'reviews')!.detail;
    } else if (other) {
      asked = other; change.status = 'attention'; change.next = other.detail.slice(0, 200);
    } else {
      change.status = 'queued'; change.next = 'Queued to merge.';
    }
    if (change.dependsOn?.length) {
      const view = (await trunkOf(this.env, key).stackViews([change.id]))[change.id];
      change.dependsOn = view.dependsOn ?? [];
      change.outdated = view.outdated ?? [];
      change.waitingOn = change.dependsOn.filter(item => item.status !== 'landed');
      if (change.waitingOn.some(item => item.status === 'closed')) {
        asked = undefined; change.status = 'attention'; change.next = waitingReason(change.waitingOn);
      } else if (change.outdated.length && !change.conflicts.length) {
        sentBack = 'restack'; change.status = 'revise'; change.next = `${outdatedReason(change.outdated)}. Restack this pull request.`;
      } else if ((change.status === 'queued' || change.status === 'open') && change.waitingOn.length) {
        change.status = 'open'; change.next = waitingReason(change.waitingOn);
      }
    } else { change.waitingOn = []; change.outdated = []; }
    if (change.status === 'revise' && sentBack) change.sentBack = sentBack; else delete change.sentBack;
    if (change.internal.revokedTokens) change.next = `${change.next ?? 'Remove the secret before resubmitting.'} Revoked ${plural(change.internal.revokedTokens, 'live Braid connection')}.`;
    const label = labelFor(change, policy);
    if (change.waitingOn?.some(item => item.status === 'closed')) change.label = 'Dependency closed';
    else if (change.outdated?.length && !change.conflicts.length) change.label = 'Needs restack';
    else if (label) change.label = label; else delete change.label;
    // Policy names a duplicate only when the change has one.
    if (change.status === 'attention' && previous !== 'attention') this.event(change, 'escalated', change.next ?? 'Needs a person.', undefined, asked ? { requirement: asked.id,
      ...(asked.id === 'duplicate' ? { duplicates: change.duplicates!.slice(0, 1).map(({ number, title }) => ({ number, title })) } : {}) } : {});
    if (change.status === 'open' && unmet.some(requirement => requirement.id === 'reviews')) this.scheduleReview(change);
    if (previous === 'queued' && change.status !== 'queued') await trunkOf(this.env, key).dequeue(key, change.id);
    if (change.status === 'queued' && previous !== 'queued') change.internal.enqueued = false;
  }
  /** Enqueue only after the queued state is durable, so a trunk callback always finds the change. */
  private async enqueue(key: string, change: Stored) {
    if (change.status !== 'queued' || change.internal.enqueued) return;
    try {
      const { position } = await trunkOf(this.env, key).enqueue(key, { changeId: change.id, shard: Number(this.meta.get('shard')), number: change.number, revision: change.revision, title: change.title, author: change.author.id });
      if (!position) { await this.settle(key, change); this.write(change); return; }
      change.internal.enqueued = true;
      this.event(change, 'queued', 'Added to the merge queue.');
      this.write(change);
    } catch {
      // The alarm retries enqueueing; the change stays queued and visible.
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }
  private scheduleReview(change: Stored) {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO review_jobs (change_id, revision, due) VALUES (?, ?, ?)', change.id, change.revision, Date.now());
    void this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private scheduleGuide(change: Stored, revision = change.revision) {
    if (this.guides.enqueue(change.id, revision, { title: change.title, summary: revision === change.revision ? change.summary : '',
      description: revision === change.revision ? [change.intent, change.rationale].filter(Boolean).join('\n\n') : 'The original author description was not recorded for this revision.' })) {
      this.ctx.waitUntil(this.wakeBy(Date.now() + 100));
    }
  }

  /** Model-independent response latency: only the revision and its durable run are read here. */
  async guide(reference: string, revision?: number, publicViewer = false): Promise<Result<ChangeGuide>> {
    return this.guard(async () => {
      const change = this.require(reference), target = revision ?? change.revision;
      this.patchOf(change, target);
      if (publicViewer && this.withheld(change, target)) return { status: 'failed', revision: target, chapters: [], attributes: [], generatedBy: GUIDE_MODEL, error: 'This revision is not available publicly.' };
      if (!this.guides.get(change.id, target)) this.scheduleGuide(change, target);
      const guide = this.guides.get(change.id, target)!;
      // Guide before/after are model-authored prose, not verbatim Git content exempted by publicResponse.
      return publicViewer ? publicMetadata(guide, new Set(['path'])) as ChangeGuide : guide;
    }, true);
  }

  private async guideInput(key: string, id: string, revision: number, description: GuideDescription): Promise<GuideInput> {
    const change = this.require(id), patch = this.patchOf(change, revision);
    if (this.withheld(change, revision)) throw new GuideInputError('Remove secrets from this revision before generating a guide.');
    return this.readSnapshot(key, false, async snapshot => {
      const files: GuideInput['files'] = [];
      const documents: AttributeFile[] = [], paths = Object.keys(patch.files).sort();
      if (paths.length > 200) throw new GuideInputError('The guide exceeds the 200-file input limit.');
      let characters = 0;
      for (const path of paths) {
        const file = await this.fileAt(patch, path, snapshot), edit = patch.files[path];
        characters += (file.base?.length ?? 0) + (file.text?.length ?? 0);
        if (characters > 4_000_000) throw new GuideInputError('The guide exceeds the Worker memory budget for text diffs.');
        files.push({ path, before: file.base, after: file.text, binary: file.binary, ...(edit !== null && typeof edit === 'object' ? { mode: edit.mode } : {}) });
      }
      const attributes = new Set(['.gitattributes']);
      for (const path of paths) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) attributes.add(`${parts.slice(0, i).join('/')}/.gitattributes`);
      }
      if (attributes.size > 600) throw new GuideInputError('The guide exceeds the 600 attribute-file read limit.');
      let total = 0;
      for (const path of attributes) {
        const content = (await this.fileAt(patch, path, snapshot)).text;
        if (content !== null) {
          total += content.length;
          if (content.length > 64_000 || total > 256_000) throw new GuideInputError('The explicit attributes exceed the guide input limit.');
          documents.push({ path, content });
        }
      }
      return { ...description, files, attributes: explicitGuideAttributes(paths, documents) };
    });
  }

  /* ---------- files ---------- */

  private async prepareFiles(context: ChangeContext, input: { baseCommit: string; files: SubmissionFile[] }) {
    const key = context.repository, headCommit = context.retainHead ? context.headCommit : undefined;
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const cached = this.cache.reader(artifacts);
    const reader = { ...cached, readBlob: async (hash: string) => {
      try { return await cached.readBlob(hash); }
      catch (error) {
        if (artifactsFailed(error, 'MEMORY_LIMIT')) throw new HttpError(413, 'Cloudflare Artifacts cannot buffer this Git blob within its memory limit. Split this file before submitting.');
        throw error;
      }
    } };
    if (!await reader.readCommit(input.baseCommit)) throw new HttpError(409, 'That base commit is not in this repository. Fetch the current trunk and resubmit.');
    const snapshot = new TreeSnapshot(reader);
    const files: ChangeFile[] = [], patch: Record<string, GitFileEdit> = Object.create(null), guards: GuardFinding[] = [];
    const tokens = new Set<string>(), dependencies = new Map<string, Dependency>();
    const { instructions, policy } = await this.policy(key);
    let unreviewed = false;
    for (const file of input.files) {
      const base = await snapshot.version(input.baseCommit, file.path);
      if (base.kind === 'special') throw new HttpError(400, `${file.path} is a directory, symlink or submodule at the base commit; changes replace regular files only.`);
      const before = base.kind === 'file' ? await snapshot.text(base) : '';
      const blob = 'blob' in file ? await reader.readBlob(file.blob) : null;
      if ('blob' in file && !blob) throw new HttpError(409, 'Upload this Git blob to this repository before submitting it.');
      if (blob && blob.size > LIMITS.bytes) throw new HttpError(413, 'Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.');
      const after = 'blob' in file ? blob!.size <= 1024 * 1024 ? await blobText(blob!) : null : file.content;
      const deleted = 'content' in file && file.content === null;
      const mode = file.mode && (base.kind !== 'file' || file.mode !== base.mode) ? file.mode : undefined;
      const afterHash = deleted ? null : 'blob' in file ? file.blob : await gitBlobHash(file.content!);
      if (deleted && base.kind === 'absent' || base.kind === 'file' && afterHash === base.hash && !mode) continue;
      if (before === null || !deleted && (after === null || after.length > 1024 * 1024 || new TextEncoder().encode(after).length > 1024 * 1024)) unreviewed = true;
      const inspected: GuardFile[] = [{ path: file.path, before: base.kind === 'file' ? before : null, after }];
      for (const token of addedBraidTokens(inspected)) tokens.add(token);
      guards.push(...guardFindings(inspected), ...instructionFindings(inspected, instructions));
      for (const dependency of introducedDependencies(inspected)) {
        const id = `${dependency.ecosystem}:${dependency.name}@${dependency.version}`;
        if (dependencies.size < 500 || dependencies.has(id)) dependencies.set(id, dependency);
      }
      if (blob && after === null) {
        const scanned = await scanBlob(file.path, blob);
        guards.push(...scanned.findings);
        for (const token of scanned.tokens) tokens.add(token);
      }
      files.push({ path: file.path, ...(after === null && !deleted || before === null ? { additions: 0, deletions: 0 } : textDiffStats(before ?? '', after ?? '')),
        ...(deleted ? { deleted: true as const } : base.kind === 'absent' ? { added: true as const } : {}), ...(mode ? { mode } : {}),
        beforeHash: base.kind === 'file' ? base.hash : null, afterHash });
      patch[file.path] = deleted ? null : 'blob' in file ? { blob: file.blob, ...(mode ? { mode } : {}) } : mode ? { content: file.content!, mode } : file.content;
    }
    if (!files.length) throw new HttpError(400, 'This change has no differences from its base commit.');
    const revoked = this.env.SECURITY ? await Promise.all([...tokens].map(token => securityOf(this.env).revokeLeakedToken(token))) : [];
    const blobs = Object.values(patch).filter(isBlobEdit).map(edit => edit.blob);
    // A revision with a secret is withheld until a clean one replaces it, so none of its objects are retained: once the
    // incoming ref is gone they stay prunable. A clean patch keeps its blobs, but its pushed commit is retained only
    // when every pushed ancestor scanned clean too: a clean tip can have removed a secret its parents still contain.
    const secret = tokens.size > 0 || guards.some(finding => finding.kind === 'secrets');
    if (!secret && (blobs.length || headCommit)) {
      await checkAuthorization(this.env, context.authorization);
      const token = await artifacts.createToken('write', 300);
      try {
        const { retainBlobs } = await import('../git/push');
        await retainBlobs({ remote: repository.remote, token: token.plaintext, blobs, parents: [input.baseCommit, ...(headCommit ? [headCommit] : [])],
          beforePush: () => checkAuthorization(this.env, context.authorization) });
      } catch (error) {
        if (error instanceof GitError && error.code === 'full') throw new HttpError(413, 'Cloudflare Artifacts limits each repository to 1 GB. This repository has reached that limit.');
        throw error;
      } finally { await artifacts.revokeToken(token.plaintext).catch(error => logFailure('revision_token_revoke_failed', error)); }
    }
    return { files, patch, unreviewed, revokedTokens: revoked.filter(Boolean).length, guards,
      advisory: await dependencyReview([...dependencies.values()], policy.dependencyReview) };
  }

  /**
   * Checks a change arrives with: what its agent says it ran, a command it
   * shows failing (which sends it back like a failed test report, with the end
   * of its output), for Braid's own task results what their agents ran, and
   * the review of the dependency versions it adds.
   */
  private arrivalChecks(context: ChangeContext, input: { tests: LocalTestReport[]; evidence: EvidenceInput[] }, revision: number, advisory: Omit<ChangeCheck, 'revision'> | null): ChangeCheck[] {
    return [
      ...(context.system ? context.checks ?? [] : []).map(check => ({ ...check, revision, source: check.kind === 'local' || check.kind === 'report' || check.kind === 'run' ? 'agent' as const : 'braid' as const })),
      ...input.tests.map(test => ({ revision, label: test.command, status: test.result === 'failed' ? 'failed' as const : 'warning' as const, source: 'agent' as const, detail: `Agent-reported ${test.result}; not executed by Braid.${test.detail ? ` ${test.detail}` : ''}` })),
      // Braid's own callers already pass their agents' command runs among `checks`.
      ...(context.system ? [] : input.evidence).flatMap(item => item.kind === 'command' && item.exitCode !== 0
        ? [{ revision, label: item.command, status: 'failed' as const, source: 'agent' as const, detail: `Exited with ${item.exitCode} on the agent's machine; not executed by Braid.${item.output ? `\n${outputTail(item.output)}` : ''}` }] : []),
      ...(advisory ? [{ ...advisory, revision }] : []),
    ];
  }
  /** Stores a revision's screenshots and records its evidence, stamped with the revision, the time and who ran it. */
  private recordEvidence(change: Stored, items: Reported[], source: EvidenceSource, images = new Map<string, Uint8Array>()) {
    if (!items.length) return;
    for (const [image, bytes] of images) this.content.putBytes(`image:${image}`, bytes);
    const at = now();
    change.evidence = keptEvidence([...change.evidence ?? [], ...items.map(item => ({ ...item, revision: change.revision, source, at }))], change.revision);
  }
  private async receiptFor(key: string, actor: Actor, ...asked: unknown[]): Promise<Receipt> {
    const signature = await digest(JSON.stringify([actor.id, ...asked]));
    const row = this.ctx.storage.sql.exec<{ signature: string; change_id: string }>('SELECT signature, change_id FROM receipts WHERE key = ?', key).toArray()[0];
    if (row && row.signature !== signature) throw new HttpError(409, 'This request key was already used for a different change.');
    return { signature, prior: row?.change_id,
      keep: change => { this.ctx.storage.sql.exec('INSERT INTO receipts (key, signature, change_id, revision) VALUES (?, ?, ?, ?)', key, signature, change.id, change.revision); } };
  }
  private savePatch(change: Stored, context: ChangeContext, input: { baseCommit: string; coAuthors: string[] }, files: Record<string, GitFileEdit>) {
    this.content.put(`patch:${change.id}:${change.revision}`, { baseCommit: input.baseCommit, files, ...(context.system && context.fileAuthors ? { fileAuthors: context.fileAuthors } : {}),
      ...(input.coAuthors.length ? { coAuthors: input.coAuthors } : {}), secrets: !!change.guards?.some(finding => finding.kind === 'secrets'), secretScanVersion: SECRET_SCAN_VERSION } satisfies Patch);
  }

  /** Numbers come one at a time when traffic is light, so they stay dense, and in blocks when a shard is busy. */
  private async nextNumber(key: string, shard: number) {
    let next = Number(this.meta.get('number-next') ?? 0), end = Number(this.meta.get('number-end') ?? 0);
    if (next >= end) {
      const busy = Date.now() - Number(this.meta.get('number-at') ?? 0) < 2000;
      const block = busy ? 8 : 1;
      next = await trunkOf(this.env, key).allocate(key, shard, block);
      end = next + block;
      this.meta.set('number-end', String(end));
      this.meta.set('number-at', String(Date.now()));
    }
    this.meta.set('number-next', String(next + 1));
    return next;
  }

  /**
   * The author of a change: a person, or an agent known by its model (its tool when the model is unknown, and
   * otherwise just "Agent") with the person who owns it, the fleet that minted it and the run it came from. A
   * connection's own label is never its name; Braid's tasks name their combined results by their models.
   */
  private authorOf(actor: Actor, model: string | undefined, run: Run): ChangeAuthor {
    const kind = actor.simulated ? 'simulated' : actor.kind === 'agent' ? 'agent' : 'human';
    return {
      kind, id: actor.id, name: kind === 'agent' ? agentName(model, run.tool) ?? (actor.id.startsWith('agent:') ? 'Agent' : actor.name) : actor.name,
      ...(model ? { model } : {}), ...(actor.fleet ? { fleet: actor.fleet } : {}), ...(actor.owner ? { owner: actor.owner } : {}),
      ...(run.tool ? { tool: run.tool } : {}), ...(run.session ? { session: run.session } : {}), ...(run.parentSession ? { parentSession: run.parentSession } : {}),
    };
  }

  /* ---------- public operations ---------- */

  private commentsFor(id: string): ChangeComment[] | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM review_comments WHERE change_id = ?', id).toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private saveComments(id: string, comments: ChangeComment[]) {
    this.ctx.storage.sql.exec('INSERT INTO review_comments (change_id, value) VALUES (?, ?) ON CONFLICT(change_id) DO UPDATE SET value = excluded.value', id, JSON.stringify(comments));
  }
  /** One operation at a time per change or request key, each after the one before settles, whether it failed or not. */
  private serially<T>(reference: string, run: () => Promise<T>): Promise<T> {
    const id = /^\d+$/.test(reference) ? this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM changes WHERE number = ?', Number(reference)).toArray()[0]?.id ?? reference : reference;
    const result = (this.serial.get(id) ?? Promise.resolve()).then(run, run);
    this.serial.set(id, result);
    const release = () => { if (this.serial.get(id) === result) this.serial.delete(id); };
    void result.then(release, release);
    return result;
  }

  /** Resetting a visitor's copy of the example forgets the conversations it overlaid on the recording, and their receipts. */
  resetExample(repository: string) {
    if (!repository.startsWith('demo:')) throw new HttpError(403, 'Only a copy of the recorded example can be reset.');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM review_comments');
      this.ctx.storage.sql.exec('DELETE FROM receipts');
    });
  }
  /** The example overlays these per-visitor rows on its immutable recording. */
  exampleComments(ids: string[]): Record<string, ChangeComment[]> {
    return Object.fromEntries(ids.flatMap(id => { const comments = this.commentsFor(id); return comments ? [[id, comments]] : []; }));
  }

  async comment(context: ChangeContext, reference: string, raw: unknown, key: string, example?: Change, exampleDiff?: ChangeDiff): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      const input = parse(commentBody, raw);
      if (context.actor.kind !== 'owner' && context.actor.kind !== 'agent') throw new HttpError(403, 'Only people who can write and their connected agents can comment.');
      if (context.actor.kind === 'agent' && !input.inReplyTo) throw new HttpError(403, 'Connected agents may reply to a conversation. A person starts it.');
      return this.saveConversation(reference, await this.receiptFor(key, context.actor, 'comment', reference, input), example, async change => {
        let contents: string | null | undefined;
        if (input.path !== undefined) {
          const diff = exampleDiff ?? unwrap(await this.diff(context.repository, change.id, input.path, input.revision));
          if (diff.binary || diff.withheld) throw new HttpError(400, 'This file cannot receive line comments.');
          contents = input.side === 'LEFT' ? diff.before : diff.after;
        }
        return addComment(change.comments ?? [], input, this.authorOf(context.actor, context.actor.model, {}), change.revision, contents);
      });
    }));
  }

  async resolveConversation(context: ChangeContext, reference: string, id: string, raw: unknown, key: string, example?: Change): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      if (context.actor.kind !== 'owner') throw new HttpError(403, 'Only a person who can write may resolve a conversation.');
      const { resolved } = parse(resolveBody, raw);
      parse(commentId, id);
      return this.saveConversation(reference, await this.receiptFor(key, context.actor, 'resolve', reference, id, resolved), example,
        async change => resolveComment(change.comments ?? [], id, resolved, this.authorOf(context.actor, context.actor.model, {})));
    }));
  }

  /** Answers a retried request from its receipt, or saves the conversations `next` makes with one. The example's recording is never written. */
  private async saveConversation(reference: string, receipt: Receipt, example: Change | undefined, next: (change: Change) => Promise<ChangeComment[]>): Promise<Change> {
    const change = example ? { ...example, comments: this.commentsFor(example.id) ?? example.comments ?? [] } : this.require(reference);
    if (receipt.prior) return example ? { ...change, commentCount: change.comments!.length } : publicChange(this.require(change.id));
    const comments = await next(change);
    this.ctx.storage.transactionSync(() => {
      this.saveComments(change.id, comments);
      receipt.keep(change);
      if (!example) this.write(this.require(change.id));
    });
    return example ? { ...change, comments, commentCount: comments.length } : publicChange(this.require(change.id));
  }

  private async moveComments(key: string, change: Stored, next: Patch) {
    const comments = change.comments ?? [];
    const anchors = comments.flatMap(comment => comment.anchor && !comment.anchor.outdated ? [comment.anchor] : []);
    if (!anchors.length) return;
    const previous = this.patchOf(change, change.revision);
    return this.readSnapshot(key, false, async snapshot => {
      const pairs = new Map(await Promise.all([...new Set(anchors.map(anchor => anchor.path))].map(async path =>
        [path, await Promise.all([this.fileAt(previous, path, snapshot), this.fileAt(next, path, snapshot)])] as const)));
      return comments.map(comment => {
        if (!comment.anchor || comment.anchor.outdated) return comment;
        const [before, after] = pairs.get(comment.anchor.path)!;
        const side = comment.anchor.side === 'LEFT' ? 'base' : 'text';
        return { ...comment, anchor: moveAnchor(comment.anchor, before[side], after[side]) };
      });
    });
  }

  async submit(context: ChangeContext, raw: unknown, requestKey: string): Promise<Result<Change>> {
    return this.serially(`submit:${requestKey}`, () => this.guard(async () => {
      if (context.actor.kind !== 'owner' && context.actor.kind !== 'agent') throw new HttpError(403, 'Only repository owners and connected agents can submit changes.');
      this.bind(context.repository, context.shard);
      const input = parse(context.system ? submission.system : submission.agent, raw);
      checkSize(input.files);
      // Screenshots are signed by their hash, so a retry is recognised without hashing megabytes of base64 again.
      const { items, images } = await decodeEvidence(input.evidence);
      const receipt = await this.receiptFor(requestKey, context.actor, 'submit', { ...input, evidence: items.length ? items : undefined });
      if (receipt.prior) return publicChange(this.require(receipt.prior));
      const { files, patch, guards, advisory, revokedTokens, unreviewed } = await this.prepareFiles(context, input);
      const preparedKey = `stack-prepare:${requestKey}`, prepared = this.meta.get(preparedKey);
      const identity = prepared ? JSON.parse(prepared) as { id: string; number: number; signature: string }
        : { id: changeId(context.shard), number: await this.nextNumber(context.repository, context.shard), signature: receipt.signature };
      if (identity.signature !== receipt.signature) throw new HttpError(409, 'Retry this request key with its original submission.');
      this.meta.setJson(preparedKey, identity);
      const at = now();
      const author = this.authorOf(context.actor, input.model ?? context.actor.model, input.agent);
      const change: Stored = {
        id: identity.id, number: identity.number, title: input.title, intent: input.intent ?? input.summary, summary: input.summary, rationale: input.rationale ?? '',
        status: 'open', author, revision: 1, baseCommit: input.baseCommit, files, ...totals(files),
        ...(input.taskId ? { taskId: input.taskId } : {}), reviews: [], checks: this.arrivalChecks(context, input, 1, advisory), conflicts: [], overlaps: [], events: [], createdAt: at, updatedAt: at, internal: { revokedTokens, unreviewed },
        ...(guards.length ? { guards } : {}),
        ...(context.headCommit ? { headCommit: context.headCommit } : {}),
      };
      await this.setDependencies(context.repository, change, input.dependsOn, receipt.signature);
      this.recordEvidence(change, items, 'agent', images);
      this.event(change, 'submitted', `${author.name} submitted ${plural(files.length, 'file')}.`, author.name);
      if (context.system && context.approvedBy) {
        change.internal.approvedRevision = 1; change.internal.approver = personName(context.approvedBy);
        this.event(change, 'approved', `${context.approvedBy} approved these changes${input.taskId ? ' in their agent task' : ''}.`, context.approvedBy);
      }
      this.savePatch(change, context, input, patch);
      this.write(change);
      receipt.keep(change);
      this.meta.delete(preparedKey);
      change.overlaps = await this.registerPaths(context.repository, change);
      if (change.overlaps.length) this.event(change, 'overlap', `${plural(change.overlaps.length, 'other active change')} ${change.overlaps.length === 1 ? 'touches' : 'touch'} the same files; the queue merges them line by line.`);
      await this.findDuplicates(context.repository, change);
      await this.settle(context.repository, change);
      this.write(change);
      await this.enqueue(context.repository, change);
      return publicChange(change);
    }));
  }

  stackPatch(id: string, revision: number): Result<{ baseCommit: string; files: Record<string, GitFileEdit> }> {
    const change = this.load(id), patch = this.content.get<Patch>(`patch:${id}:${revision}`);
    if (!change || !patch) return { ok: false, status: 404, error: 'Dependency not found in this repository.' };
    if (change.revision !== revision) return { ok: false, status: 409, error: 'A prerequisite changed. Retry the restack.' };
    // A stack base is pushed to Git: a withheld patch must never become a public branch.
    if (this.withheld(change, revision)) return { ok: false, status: 409, error: 'Remove secrets from the prerequisite before restacking.' };
    return { ok: true, data: { baseCommit: patch.baseCommit, files: patch.files } };
  }

  async restack(context: ChangeContext, reference: string, raw: unknown, requestKey: string): Promise<Result<Change>> {
    return this.serially(`restack-key:${requestKey}`, () => this.serially(`restack:${reference}`, () => this.guard(async () => {
      const input = parse(restackBody, raw);
      const receipt = await this.receiptFor(requestKey, context.actor, 'restack', reference, input);
      if (receipt.prior) return publicChange(this.require(receipt.prior));
      const change = this.require(reference);
      if (context.actor.kind !== 'owner' && (context.actor.kind !== 'agent' || change.author.id !== context.actor.id)) throw new HttpError(403, 'Only the author or a repository owner can restack this pull request.');
      const planKey = `restack:${requestKey}`;
      type Plan = { signature: string; pins: { parent: string; revision: number }[]; fileAuthors?: Record<string, ChangeAuthor>; body: Record<string, unknown> };
      let plan = this.content.get<Plan>(planKey);
      if (plan && plan.signature !== receipt.signature) throw new HttpError(409, 'Retry this request key with its original restack.');
      if (!plan) {
        if (change.revision !== input.previousRevision || !REVISABLE.includes(change.status)) throw new HttpError(409, 'This pull request changed. Fetch it again before restacking.');
        const target = unwrap(await trunkOf(this.env, context.repository).restackBase(context.repository, change.id, context.authorization));
        const patch = this.patchOf(change, change.revision);
        const repository = await this.repository(context.repository);
        using artifacts = await artifactsOf(this.env).get(repository.id);
        const [result] = await composeChanges(this.cache.reader(artifacts), target.head, [{ id: change.id, ...patch }], (await this.policy(context.repository)).policy.merge);
        if (result.status === 'conflicted') {
          return this.serially(change.id, async () => {
            const current = this.require(change.id);
            if (current.revision !== input.previousRevision || !REVISABLE.includes(current.status)) throw new HttpError(409, 'This pull request changed. Fetch it again before restacking.');
            const removed = await trunkOf(this.env, context.repository).dequeue(context.repository, change.id);
            if (removed.landing) throw new HttpError(409, 'This pull request is merging. Wait for its result.');
            current.conflicts = result.conflicts; current.conflictBase = target.head; current.internal.conflictRevision = current.revision; current.internal.enqueued = false;
            current.status = 'revise'; current.sentBack = 'conflicts'; current.label = 'Conflicts'; current.next = 'Restack conflicts with the updated prerequisites. Resolve the files and submit a revision.';
            this.event(current, 'conflict', current.next, context.actor.name); this.write(current);
            receipt.keep(current);
            await this.indexStatus(context.repository, current); await this.notifyTask(context.repository, current);
            return publicChange(current);
          });
        }
        if (!Object.keys(result.files).length) throw new HttpError(409, 'The prerequisites already contain these changes. Close this pull request.');
        plan = { signature: receipt.signature, pins: target.pins, fileAuthors: patch.fileAuthors, body: { previousRevision: input.previousRevision, baseCommit: target.head, summary: change.summary, rationale: change.rationale,
          files: editedFiles(result.files), dependsOn: target.pins.map(pin => pin.parent), coAuthors: patch.coAuthors ?? [] } };
        this.content.put(planKey, plan);
      }
      const fileAuthors = plan.fileAuthors ?? this.content.get<Patch>(`patch:${change.id}:${input.previousRevision}`)?.fileAuthors;
      const revised = unwrap(await this.revise({ ...context, system: true, fileAuthors, dependencyPins: plan.pins }, change.id, plan.body, `restack-revision:${requestKey}`));
      receipt.keep(revised);
      this.content.delete(planKey);
      return revised;
    })));
  }

  async revise(context: ChangeContext, reference: string, raw: unknown, requestKey: string): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      this.bind(context.repository, context.shard);
      const input = parse(context.system ? revisionBody.system : revisionBody.agent, raw);
      checkSize(input.files);
      const { items, images } = await decodeEvidence(input.evidence);
      const receipt = await this.receiptFor(requestKey, context.actor, 'revise', reference, { ...input, evidence: items.length ? items : undefined });
      if (receipt.prior) return publicChange(this.require(receipt.prior));
      const change = this.require(reference);
      if (context.actor.kind !== 'owner' && change.author.id !== context.actor.id) throw new HttpError(403, 'Only the change author or a repository owner can revise it.');
      if (!REVISABLE.includes(change.status)) throw new HttpError(409, change.status === 'landing' ? 'This change is landing now. Wait for the result before revising.' : 'This change is no longer open.');
      if (input.previousRevision !== change.revision) throw new HttpError(409, `This change is at revision ${change.revision}. Fetch it again before revising.`);
      const { files, patch, guards, advisory, revokedTokens, unreviewed } = await this.prepareFiles(context, input);
      const moved = await this.moveComments(context.repository, change, { baseCommit: input.baseCommit, files: patch });
      const wasQueued = change.status === 'queued';
      if (wasQueued) {
        const removed = await trunkOf(this.env, context.repository).dequeue(context.repository, change.id);
        if (removed.landing) throw new HttpError(409, 'This change is landing now. Wait for the result before revising.');
      }
      const pins = context.dependencyPins ?? (input.baseCommit === change.baseCommit ? await trunkOf(this.env, context.repository).dependencyPins(change.id) : undefined);
      const previousPaths = change.files.map(file => file.path);
      if (guards.length) change.guards = guards; else delete change.guards;
      change.internal.revokedTokens = revokedTokens; change.internal.unreviewed = unreviewed;
      change.revision += 1;
      Object.assign(change, { baseCommit: input.baseCommit, files, ...totals(files),
        summary: input.summary, ...(input.title ? { title: input.title } : {}), ...(input.intent ? { intent: input.intent } : {}), ...(input.rationale ? { rationale: input.rationale } : {}),
        conflicts: [], status: 'open' });
      if (context.headCommit) change.headCommit = context.headCommit; else delete change.headCommit;
      try { await this.setDependencies(context.repository, change, input.dependsOn, receipt.signature, pins); }
      catch (error) {
        if (wasQueued) {
          const previous = this.require(change.id); previous.internal.enqueued = false;
          this.write(previous); await this.enqueue(context.repository, previous);
        }
        throw error;
      }
      if (moved) this.saveComments(change.id, moved);
      delete change.conflictBase;
      // The agent may come back from a new run, with another tool or model; whoever owns it stays the same.
      if (context.actor.id === change.author.id) change.author = this.authorOf({ ...context.actor, owner: context.actor.owner ?? change.author.owner, fleet: context.actor.fleet ?? change.author.fleet },
        input.model ?? context.actor.model ?? change.author.model, Object.keys(input.agent).length ? input.agent : change.author);
      change.checks.push(...this.arrivalChecks(context, input, change.revision, advisory));
      this.recordEvidence(change, items, 'agent', images);
      change.internal.enqueued = false;
      this.event(change, 'revised', `Revision ${change.revision} based on ${input.baseCommit.slice(0, 7)}.`, context.actor.name, { revision: change.revision, base: input.baseCommit });
      this.savePatch(change, context, input, patch);
      receipt.keep(change);
      this.write(change);
      change.overlaps = await this.registerPaths(context.repository, change, previousPaths);
      if (input.title || input.intent) await this.findDuplicates(context.repository, change);
      await this.settle(context.repository, change);
      this.write(change);
      await this.enqueue(context.repository, change);
      return publicChange(change);
    }));
  }

  /**
   * A change from `git push` of commit `pushed`. With a topic this author pushed before, it is the next revision of
   * that change while the change is open, and pushing the same commit again changes nothing; otherwise it opens a new
   * change, which the topic then names.
   */
  async push(context: ChangeContext, push: { topic?: string; commit: string; history?: PushedCommit[] }, raw: Record<string, unknown>): Promise<Result<Change>> {
    // Git I/O yields between the topic lookup and its update. Keep pushes ordered so two first pushes cannot open
    // different changes for one topic, and duplicate requests cannot race their receipt.
    const result = this.pushing.then(() => this.pushed(context, push, raw));
    this.pushing = result.then(() => {}, () => {});
    return result;
  }

  private async pushed(context: ChangeContext, push: { topic?: string; commit: string; history?: PushedCommit[] }, raw: Record<string, unknown>): Promise<Result<Change>> {
    this.bind(context.repository, context.shard);
    const { topic, commit } = push;
    context = { ...context, headCommit: commit, retainHead: !!push.history?.some(item => item.commit === commit) && push.history.every(item => !item.secrets) };
    const named = topic ? this.ctx.storage.sql.exec<{ change_id: string; pushed: string }>('SELECT change_id, pushed FROM topics WHERE author_id = ? AND topic = ?', context.actor.id, topic).toArray()[0] : undefined;
    const open = named ? this.load(named.change_id) : undefined;
    const newKey = `push:new:${context.actor.id}:${topic ?? ''}:${commit}`;
    const revisionKey = `push:${open?.id ?? ''}:${commit}`;
    // An older push retried after another revision is still the same request. Do not construct a new revision
    // precondition for it or move the topic back to that older commit.
    const prior = this.ctx.storage.sql.exec<{ change_id: string }>('SELECT change_id FROM receipts WHERE key IN (?, ?) LIMIT 1', newKey, revisionKey).toArray()[0];
    if (prior) {
      if (topic && !named) this.ctx.storage.sql.exec('INSERT INTO topics (author_id, topic, change_id, pushed) VALUES (?, ?, ?, ?)', context.actor.id, topic, prior.change_id, commit);
      return { ok: true, data: publicChange(this.require(prior.change_id)) };
    }
    let result: Result<Change>;
    // A retried push replays its receipt; the key names what the push does, so the same commit revising a change
    // and later opening one of its own are two requests, not one key reused for a different change.
    if (open && OPEN.includes(open.status)) {
      if (named!.pushed === commit) return { ok: true, data: publicChange(open) };
      result = await this.revise(context, open.id, { ...raw, previousRevision: open.revision }, revisionKey);
    } else result = await this.submit(context, raw, newKey);
    if (result.ok) for (const item of push.history ?? []) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO pushed_commits (commit_hash, change_id, revision, secrets) VALUES (?, ?, ?, ?)', item.commit, result.data.id, result.data.revision, Number(item.secrets));
    if (result.ok && topic) this.ctx.storage.sql.exec('INSERT INTO topics (author_id, topic, change_id, pushed) VALUES (?, ?, ?, ?) ON CONFLICT(author_id, topic) DO UPDATE SET change_id = excluded.change_id, pushed = excluded.pushed',
      context.actor.id, topic, result.data.id, commit);
    return result;
  }

  async review(context: ChangeContext, reference: string, raw: unknown, key?: string): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      const input = parse(reviewBody, raw);
      const receipt = key ? await this.receiptFor(key, context.actor, 'review', reference, input) : undefined;
      if (receipt?.prior) return publicChange(this.require(reference));
      const change = this.require(reference);
      if (context.actor.kind !== 'owner' && context.actor.kind !== 'agent') throw new HttpError(403, 'Only owners and connected agents can review changes.');
      if (change.author.id === context.actor.id) throw new HttpError(403, 'Authors cannot review their own changes.');
      const { revision, verdict, risk, summary, findings } = input;
      if (revision !== change.revision) throw new HttpError(409, `Review revision ${change.revision}, the current revision.`);
      if (!REVISABLE.includes(change.status)) throw new HttpError(409, 'This change is not accepting reviews.');
      this.addReview(change, { reviewer: context.actor.id, kind: context.actor.kind === 'owner' ? 'human' : 'agent', verdict, ...(risk ? { risk } : {}),
        summary, findings, author: this.authorOf(context.actor, context.actor.model, {}), ...(context.actor.model ? { model: context.actor.model } : {}) }, context.actor.name);
      if (verdict === 'reject' && context.actor.kind === 'owner') {
        await this.closeChange(context.repository, change, 'rejected', context.actor);
        receipt?.keep(change);
        return publicChange(change);
      }
      await this.settle(context.repository, change);
      this.write(change);
      receipt?.keep(change);
      if (change.status === 'revise') { await this.indexStatus(context.repository, change); await this.notifyTask(context.repository, change); }
      await this.enqueue(context.repository, change);
      return publicChange(change);
    }));
  }
  private addReview(change: Stored, review: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>, actor: string) {
    change.reviews = change.reviews.filter(existing => !(existing.revision === change.revision && existing.reviewer === review.reviewer));
    change.reviews.push({ ...review, id: reviewId(), revision: change.revision, createdAt: now() });
    change.reviews = change.reviews.slice(-40);
    this.event(change, 'reviewed', `${actor}: ${review.verdict}${review.risk ? ` (${review.risk} risk)` : ''} — ${review.summary}`, actor);
  }

  /**
   * Undoes a landed change with a new change based on the commit it landed as,
   * restoring each of its files to the version just before it. The queue
   * composes the revert with everything that landed since, so later work on
   * other lines survives and a real conflict comes back like any other.
   */
  async revert(context: ChangeContext, reference: string, requestKey: string): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      if (context.actor.kind !== 'owner') throw new HttpError(403, 'Only a repository owner can revert a change.');
      const change = this.require(reference);
      if (change.status !== 'landed' || !change.landedCommit) throw new HttpError(409, 'Only a landed change can be reverted.');
      if (!change.landedParent) throw new HttpError(409, 'This change landed before Braid recorded where it landed, so it cannot be reverted here. Revert its commit with Git.');
      if (change.revertedBy) {
        const existing = this.load(change.revertedBy.id);
        if (existing) return publicChange(existing);
      }
      const repository = await this.repository(context.repository);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
      const files: SubmissionFile[] = [];
      for (const file of change.files) {
        const before = await snapshot.version(change.landedParent, file.path);
        if (before.kind === 'special') throw new HttpError(409, `${file.path} was not a regular file before this change, so it cannot be restored here.`);
        if (before.kind === 'absent') { files.push({ path: file.path, content: null }); continue; }
        files.push({ path: file.path, blob: before.hash, mode: before.mode });
      }
      const submitted = unwrap(await this.submit({ ...context, system: true, approvedBy: context.actor.name }, {
        title: `Revert #${change.number}: ${change.title}`.slice(0, 120), intent: `Undo #${change.number}, “${change.title}”.`,
        summary: `Restores the ${plural(files.length, 'file')} #${change.number} changed to their versions before it landed.`, baseCommit: change.landedCommit, files,
      }, requestKey));
      const revert = this.require(submitted.id);
      revert.revertOf = { id: change.id, number: change.number };
      change.revertedBy = { id: revert.id, number: revert.number };
      this.event(change, 'reverted', `${context.actor.name} reverted it in #${revert.number}.`, context.actor.name);
      this.write(revert); this.write(change);
      const key = agentKey(change.author);
      if (key) this.recordAgent(key, change, change.status, { reverted: 1 });
      return publicChange(revert);
    }));
  }

  /**
   * Adds or removes an instruction through a change that the person who asked
   * authors and approves: `.braid/instructions.json` and the Braid section of
   * AGENTS.md, edited from main as it is now. It lands under the repository's
   * rules like any change, and the queue composes it with instructions that
   * landed meanwhile.
   */
  async instruct(context: ChangeContext, edit: InstructionEdit, requestKey: string): Promise<Result<Change>> {
    return this.serially(`instruct:${requestKey}`, () => this.guard(async () => {
      if (context.actor.kind !== 'owner') throw new HttpError(403, 'Only a person who owns the repository can change its instructions.');
      this.bind(context.repository, context.shard);
      // The request, not main as it happens to be, identifies a retry.
      const receipt = await this.receiptFor(requestKey, context.actor, 'instruct', edit);
      if (receipt.prior) return publicChange(this.require(receipt.prior));
      const repository = await this.repository(context.repository);
      using artifacts = await artifactsOf(this.env).get(repository.id);
      const head = (await artifacts.log({ ref: repository.branch, limit: 1 }))[0]?.hash;
      if (!head) throw new HttpError(409, 'Main is still preparing. Retry shortly.');
      const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
      const read = async (path: string) => {
        const version = await snapshot.version(head, path);
        const text = version.kind === 'file' ? await snapshot.text(version) : version.kind === 'absent' ? null : undefined;
        if (text === undefined) throw new HttpError(409, `${path} on main is not a text file Braid can edit.`);
        return text;
      };
      const current = await read(INSTRUCTIONS_PATH), agents = await read(AGENTS_PATH);
      const edited = editInstructions(current, edit);
      if ('error' in edited) throw new HttpError(edited.status, edited.error);
      const guide = withInstructions(agents, parseInstructions(edited.file).instructions);
      const adding = 'add' in edit, { id, text } = edited.instruction;
      const submitted = unwrap(await this.submit({ ...context, system: true, approvedBy: context.actor.name }, {
        title: `${adding ? 'Add' : 'Remove'} instruction: ${text}`.slice(0, 120), intent: adding ? `Every agent follows “${text}”.` : `Agents no longer follow “${text}”.`,
        summary: `${adding ? 'Adds' : 'Removes'} the instruction “${id}” ${adding ? 'to' : 'from'} ${INSTRUCTIONS_PATH} and the Braid section of ${AGENTS_PATH}.`, baseCommit: head,
        files: [{ path: INSTRUCTIONS_PATH, content: edited.file }, ...(guide === agents ? [] : [{ path: AGENTS_PATH, content: guide }])],
      }, `${requestKey}:instruct`));
      receipt.keep(submitted);
      return submitted;
    }));
  }

  /** A screenshot this change shows as evidence. */
  async image(reference: string, image: string, readOnly = false): Promise<Result<{ type: string; bytes: Uint8Array<ArrayBuffer> }>> {
    return this.guard(async () => {
      const change = this.require(reference);
      const bytes = change.evidence?.some(item => item.kind === 'screenshot' && item.image === image && (!readOnly || !this.withheld(change, item.revision))) ? this.content.bytes(`image:${image}`) : undefined;
      if (!bytes) throw new HttpError(404, 'This change has no such screenshot.');
      return { type: imageType(image), bytes };
    }, readOnly);
  }

  async approve(context: ChangeContext, reference: string, raw: unknown, key?: string): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      if (context.actor.kind !== 'owner') throw new HttpError(403, 'Only a repository owner can approve changes.');
      const input = parse(approvalWithComment, raw);
      const receipt = key ? await this.receiptFor(key, context.actor, 'approve', reference, input) : undefined;
      if (receipt?.prior) return publicChange(this.require(reference));
      const change = this.require(reference);
      if (input.revision !== change.revision) throw new HttpError(409, `Approve revision ${change.revision}, the current revision.`);
      if (!['open', 'revise', 'attention'].includes(change.status)) throw new HttpError(409, 'Only open changes can be approved.');
      change.internal.approvedRevision = change.revision; change.internal.approver = personName(context.actor.name);
      if (input.body) this.addReview(change, { reviewer: context.actor.id, kind: 'human', verdict: 'approve', summary: input.body, findings: [], author: this.authorOf(context.actor, context.actor.model, {}) }, context.actor.name);
      this.event(change, 'approved', `${context.actor.name} approved these changes.`, context.actor.name);
      await this.settle(context.repository, change);
      this.write(change);
      receipt?.keep(change);
      await this.enqueue(context.repository, change);
      return publicChange(change);
    }));
  }

  async close(context: ChangeContext, reference: string, raw: unknown): Promise<Result<Change>> {
    return this.serially(reference, () => this.guard(async () => {
      const change = this.require(reference);
      if (context.actor.kind !== 'owner' && change.author.id !== context.actor.id) throw new HttpError(403, 'Only the author or a repository owner can close this change.');
      const { reason } = parse(closing, raw);
      // Only an owner rejects; an author withdrawing their own change abandons it.
      const closeReason: ChangeCloseReason = reason === 'rejected' && context.actor.kind !== 'owner' ? 'abandoned' : reason;
      return publicChange(await this.closeChange(context.repository, change, closeReason, context.actor));
    }));
  }
  private async closeChange(key: string, change: Stored, reason: ChangeCloseReason, actor: Actor) {
    if (change.status === 'landed' || change.status === 'closed') throw new HttpError(409, 'This change is already finished.');
    if (change.status === 'queued' || change.status === 'landing') {
      const removed = await trunkOf(this.env, key).dequeue(key, change.id);
      if (removed.landing) throw new HttpError(409, 'This change is landing now. Wait for the result.');
    }
    change.status = 'closed'; change.closeReason = reason; delete change.next; delete change.label;
    const who = byline(this.authorOf(actor, actor.model, {}));
    this.event(change, 'closed', `${who} closed this pull request (${reason}).`, who);
    this.write(change);
    await this.indexStatus(key, change);
    await this.notifyTask(key, change);
    return change;
  }

  async get(reference: string, readOnly = false): Promise<Result<Change>> {
    return this.guard(async () => {
      const change = this.require(reference), key = this.meta.get('repository');
      const view = key ? (await trunkOf(this.env, key).stackViews([change.id]))[change.id] : {};
      const result = { ...publicChange(change), ...view };
      if (!readOnly) return result;
      // Each revision's content is read and scanned once, however many checks and screenshots name it.
      const withheld = new Map<number, boolean>();
      const shown = ({ revision }: { revision: number }) => {
        if (!withheld.has(revision)) withheld.set(revision, this.withheld(change, revision));
        return !withheld.get(revision);
      };
      return { ...result, evidence: result.evidence?.filter(shown), checks: result.checks.filter(shown) };
    }, readOnly);
  }

  /**
   * One file of a change: main's version at the revision's base against the
   * revision's, or, with `since`, the file as an earlier revision left it
   * against this one, so a reviewer sees only what an agent changed after
   * being sent back.
   */
  async diff(key: string, reference: string, path: string, revision?: number, since?: number, publicViewer = false, network?: string): Promise<Result<ChangeDiff>> {
    return this.guard(async () => {
      const change = this.require(reference);
      const target = revision ?? change.revision;
      if (since !== undefined && since >= target) throw new HttpError(400, 'Compare with an earlier revision.');
      if (publicViewer && (this.withheld(change, target) || since !== undefined && this.withheld(change, since))) return { path, revision: target, ...(since === undefined ? {} : { since }), before: null, after: null, binary: false, withheld: true as const };
      path ||= Object.keys(this.patchOf(change, target).files).sort()[0] ?? '';
      if (!path) throw new HttpError(404, 'This revision has no changed files.');
      return this.readSnapshot(key, publicViewer, async snapshot => {
        const after = await this.fileAt(this.patchOf(change, target), path, snapshot);
        const before = since === undefined ? undefined : await this.fileAt(this.patchOf(change, since), path, snapshot);
        const old = before ? before.text : after.base, result = { path, revision: target, ...(since === undefined ? {} : { since }), binary: after.binary || !!before?.binary };
        if (!after.touched && !before?.touched) throw new HttpError(404, 'That file is not part of this revision.');
        if (result.binary) return { ...result, before: old ?? '', after: after.text ?? '' };
        if (old !== null) return { ...result, before: old, after: after.text };
        if (after.text !== null) return { ...result, before: null, after: after.text };
        throw new HttpError(404, 'That file does not exist in either version.');
      }, network);
    }, publicViewer);
  }

  /** The files that differ between an earlier revision and a later one, including files the later one no longer changes. */
  async compare(key: string, reference: string, since: number, revision?: number, publicViewer = false, network?: string): Promise<Result<ChangeComparison>> {
    return this.guard(async () => {
      const change = this.require(reference);
      const target = revision ?? change.revision;
      if (since >= target) throw new HttpError(400, 'Compare with an earlier revision.');
      if (publicViewer && (this.withheld(change, target) || this.withheld(change, since))) return { revision: target, since, files: [], withheld: true };
      const earlier = this.patchOf(change, since), later = this.patchOf(change, target);
      return this.readSnapshot(key, publicViewer, async snapshot => {
        const files: ChangeComparison['files'] = [];
        for (const path of [...new Set([...Object.keys(earlier.files), ...Object.keys(later.files)])].sort()) {
          const before = await this.fileAt(earlier, path, snapshot), after = await this.fileAt(later, path, snapshot);
          if (before.hash === after.hash && before.mode === after.mode) continue;
          files.push({ path, ...textDiffStats(before.text ?? '', after.text ?? ''), ...(!before.hash ? { added: true as const } : {}), ...(!after.hash ? { deleted: true as const } : {}) });
        }
        return { revision: target, since, files };
      }, network);
    }, publicViewer);
  }
  private async readSnapshot<T>(key: string, cacheOnly: boolean, read: (snapshot: TreeSnapshot) => Promise<T>, network?: string): Promise<T> {
    if (cacheOnly) {
      try { return await read(new TreeSnapshot(this.cache.cachedReader())); }
      catch (error) { if (!(error instanceof CacheMiss)) throw error; }
      const budget = await trunkOf(this.env, key).publicBuild(network);
      if (!budget.allowed) throw new HttpError(503, 'This repository is preparing public content. Retry shortly.', budget.retryAfter);
    }
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    return read(new TreeSnapshot(this.cache.reader(artifacts)));
  }
  /**
   * Whether a commit a push carried may be read publicly: the revision it arrived in is not withheld, and no commit
   * that push carried, which is every ancestor main lacked, added a secret. A head pushed before pushes recorded their
   * commits is `legacy`, and its reader scans the commits beneath it itself.
   */
  publicCommit(hash: string): { baseCommit: string; legacy: boolean } | null {
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec<{ change_id: string; revision: number }>('SELECT change_id, revision FROM pushed_commits WHERE commit_hash = ?', hash).toArray()) {
      const change = this.load(row.change_id);
      if (!change || this.withheld(change, row.revision)) continue;
      if (sql.exec('SELECT 1 FROM pushed_commits WHERE change_id = ? AND revision = ? AND secrets = 1 LIMIT 1', row.change_id, row.revision).toArray().length) continue;
      return { baseCommit: this.patchOf(change, row.revision).baseCommit, legacy: false };
    }
    for (const row of sql.exec<{ value: string }>("SELECT value FROM changes WHERE json_extract(value, '$.headCommit') = ?", hash).toArray()) {
      const change = this.records.read(row.value);
      if (sql.exec('SELECT 1 FROM pushed_commits WHERE change_id = ? AND revision = ? LIMIT 1', change.id, change.revision).toArray().length) continue;
      if (!this.withheld(change, change.revision)) return { baseCommit: change.baseCommit, legacy: true };
    }
    return null;
  }
  private withheld(change: Stored, revision: number): boolean {
    const patch = this.patchOf(change, revision);
    // Legacy negatives include the scanner that skipped long lines; rescan without changing immutable revisions.
    return patch.secrets === true || revision === change.revision && !!change.guards?.some(finding => finding.kind === 'secrets')
      || patch.secretScanVersion !== SECRET_SCAN_VERSION && (Object.values(patch.files).some(isBlobEdit) || secretFindings(Object.entries(patch.files).map(([path, edit]) => ({ path, before: null, after: editContent(edit) }))).length > 0);
  }
  private patchOf(change: Stored, revision: number) {
    const patch = this.content.get<Patch>(`patch:${change.id}:${revision}`);
    if (!patch) throw new HttpError(404, `This change has no revision ${revision}.`);
    return patch;
  }
  /** A file as a revision leaves it: its new content, or main's at that revision's base when the revision leaves it alone. */
  private async fileAt(patch: Patch, path: string, snapshot: TreeSnapshot) {
    const base = await snapshot.version(patch.baseCommit, path);
    const original = base.kind === 'file' ? await snapshot.text(base) : null;
    const binary = base.kind === 'file' && original === null;
    if (!Object.hasOwn(patch.files, path)) return { touched: false, base: original, text: original, binary, hash: base.kind === 'file' ? base.hash : null, mode: base.kind === 'file' ? base.mode : null };
    const edit = patch.files[path];
    const text = isBlobEdit(edit) ? await snapshot.text({ kind: 'file', hash: edit.blob, mode: edit.mode ?? '100644' }) : editContent(edit);
    const hash = isBlobEdit(edit) ? edit.blob : text === null ? null : await gitBlobHash(text);
    const mode = edit === null ? null : typeof edit === 'object' && edit.mode ? edit.mode : base.kind === 'file' ? base.mode : '100644';
    return { touched: true, base: original, text, binary: binary || edit !== null && text === null, hash, mode };
  }

  /** A page of changes, newest first, narrowed by status, author, task or roster agent; the counts cover every change. */
  list(query: { statuses?: ChangeStatus[]; before?: { updatedAt: string; id: string }; limit: number; author?: string; taskId?: string; agent?: string }): { items: ChangeSummary[]; counts: ChangeCounts } {
    const where: string[] = [], bindings: (string | number)[] = [];
    if (query.statuses?.length) { where.push(`status IN (${query.statuses.map(() => '?').join(',')})`); bindings.push(...query.statuses); }
    if (query.author) { where.push('author_id = ?'); bindings.push(query.author); }
    if (query.agent) { where.push('agent_key = ?'); bindings.push(query.agent); }
    if (query.taskId) { where.push('task_id = ?'); bindings.push(query.taskId); }
    if (query.before) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); bindings.push(query.before.updatedAt, query.before.updatedAt, query.before.id); }
    const rows = this.ctx.storage.sql.exec<{ id: string; summary: string | null; value: string | null }>(`SELECT id, summary, CASE WHEN summary IS NULL THEN value END AS value FROM changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...bindings, Math.min(100, query.limit)).toArray();
    const counts: ChangeCounts = { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 };
    for (const row of this.ctx.storage.sql.exec<{ status: ChangeStatus; count: number }>('SELECT status, COUNT(*) AS count FROM changes GROUP BY status')) counts[row.status] = row.count;
    return { items: rows.map(row => {
      if (row.summary !== null) return JSON.parse(row.summary) as ChangeSummary;
      const item = summary(this.records.read(row.value!));
      this.ctx.storage.sql.exec('UPDATE changes SET summary = ? WHERE id = ?', JSON.stringify(item), row.id);
      return item;
    }), counts };
  }

  /** Changes by authors under a prefix that were sent back for a new revision (used by the swarm simulator). */
  sentBack(prefix: string, limit: number): { changeId: string; shard: number; revision: number; authorId: string }[] {
    const shard = Number(this.meta.get('shard'));
    return this.ctx.storage.sql.exec<{ id: string; author_id: string; value: string }>("SELECT id, author_id, value FROM changes WHERE author_id >= ? AND author_id < ? AND status = 'revise' ORDER BY updated_at LIMIT ?", prefix, `${prefix}\uffff`, limit)
      .toArray().map(row => ({ changeId: row.id, shard, revision: (JSON.parse(row.value) as Stored).revision, authorId: row.author_id }));
  }

  /** Every agent's record in this shard, for the fleet roster, with the author ids each one groups. */
  agentStats(): AgentStats[] {
    const counts = new Map<string, Partial<ChangeCounts>>(), authors = new Map<string, string[]>();
    for (const row of this.ctx.storage.sql.exec<{ agent_key: string; status: ChangeStatus; count: number }>('SELECT agent_key, status, COUNT(*) AS count FROM changes WHERE agent_key IS NOT NULL GROUP BY agent_key, status'))
      counts.set(row.agent_key, { ...counts.get(row.agent_key), [row.status]: row.count });
    for (const row of this.ctx.storage.sql.exec<{ agent_key: string; author_id: string }>('SELECT agent_key, author_id FROM changes WHERE agent_key IS NOT NULL GROUP BY agent_key, author_id'))
      authors.set(row.agent_key, [...authors.get(row.agent_key) ?? [], row.author_id]);
    return this.ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM agent_stats').toArray()
      .map(row => ({ ...JSON.parse(row.value), counts: counts.get(row.key) ?? {}, authors: authors.get(row.key) ?? [] }));
  }

  authorCounts(prefix: string): Partial<ChangeCounts> {
    const counts: Partial<ChangeCounts> = {};
    for (const row of this.ctx.storage.sql.exec<{ status: ChangeStatus; count: number }>('SELECT status, COUNT(*) AS count FROM changes WHERE author_id >= ? AND author_id < ? GROUP BY status', prefix, `${prefix}\uffff`)) counts[row.status] = row.count;
    return counts;
  }

  /* ---------- trunk callbacks ---------- */

  async forLanding(key: string, id: string, revision: number, batchId: string): Promise<Result<LandingPatch>> {
    return this.serially(id, () => this.guard(async () => {
      const change = this.require(id);
      if (change.revision !== revision || !['queued', 'landing'].includes(change.status)) throw new HttpError(409, 'The change moved since it was queued.');
      if ((await trunkOf(this.env, key).stackViews([id]))[id].outdated?.length || (await trunkOf(this.env, key).dependencies(id)).some(item => item.status !== 'landed')) {
        await this.settle(key, change); this.write(change);
        throw new HttpError(409, change.next ?? 'Waiting on dependencies.');
      }
      const patch = this.content.get<Patch>(`patch:${id}:${revision}`);
      if (!patch) throw new HttpError(503, 'The change content is temporarily unavailable.');
      if (change.status !== 'landing' || change.batchId !== batchId) {
        change.status = 'landing'; change.batchId = batchId; change.next = 'Merging.';
        this.write(change);
        await this.indexStatus(key, change);
      }
      const approvals = [...(change.internal.approvedRevision === revision && change.internal.approver ? [change.internal.approver] : []),
        ...change.reviews.filter(review => review.revision === revision && review.verdict === 'approve').map(review => review.reviewer)];
      return { changeId: id, number: change.number, revision, title: change.title, summary: change.summary, baseCommit: patch.baseCommit, files: patch.files, author: change.author, autonomy: change.autonomy, approvals,
        ...(patch.fileAuthors ? { fileAuthors: patch.fileAuthors } : {}), ...(change.taskId ? { taskId: change.taskId } : {}), coAuthors: patch.coAuthors ?? [] };
    }));
  }

  /** `runs` are the commands Braid ran on the combined result this change landed in. */
  async landed(key: string, id: string, revision: number, info: { commit: string; parent?: string; batchId: string; strategies: Record<string, LandingStrategy>; checks?: ChangeCheck[]; reviews?: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[]; runs?: CommandRun[] }): Promise<Result<null>> {
    return this.guard(async () => {
      const change = this.require(id);
      if (change.revision !== revision || change.status === 'landed') return null;
      change.status = 'landed'; change.landedCommit = info.commit; change.landedAt = now(); change.batchId = info.batchId; change.strategies = info.strategies; delete change.label;
      if (info.parent) change.landedParent = info.parent;
      if (info.checks?.length) change.checks.push(...info.checks.map(check => ({ ...check, revision })));
      this.recordEvidence(change, info.runs ?? [], 'braid');
      for (const review of info.reviews ?? []) change.reviews.push({ ...review, id: reviewId(), revision, createdAt: now() });
      delete change.next;
      const merged = Object.values(info.strategies).filter(strategy => strategy !== 'fast-forward' && strategy !== 'already-applied').length;
      this.event(change, 'landed', `Merged as ${info.commit.slice(0, 7)}${merged ? `, combining ${plural(merged, 'file')} with concurrent work` : ''}.`);
      this.write(change);
      await this.indexStatus(key, change);
      await this.notifyTask(key, change);
      return null;
    });
  }

  async conflicted(key: string, id: string, revision: number, info: { conflicts: ChangeConflict[]; against: string }): Promise<Result<null>> {
    return this.guard(async () => {
      const change = this.require(id);
      if (change.revision !== revision || !['queued', 'landing'].includes(change.status)) return null;
      // Rebasing after others landed first is not the author's failure, so conflicts do not count toward revision rounds.
      change.conflicts = info.conflicts; change.conflictBase = info.against; change.internal.conflictRevision = revision; change.internal.enqueued = false;
      change.status = 'revise'; change.sentBack = 'conflicts';
      change.next = conflictNext(info.conflicts); change.label = 'Conflicts';
      this.event(change, 'conflict', change.next);
      this.write(change);
      await this.indexStatus(key, change);
      await this.notifyTask(key, change);
      return null;
    });
  }

  /** A batch failed for reasons unrelated to this change, or its checks failed; `runs` are the commands Braid ran when they did. */
  async requeue(key: string, id: string, revision: number, failed?: ChangeCheck[], reviews?: Omit<ChangeReview, 'id' | 'revision' | 'createdAt'>[], runs?: CommandRun[]): Promise<Result<null>> {
    return this.guard(async () => {
      const change = this.require(id);
      if (change.revision !== revision || change.status !== 'landing') return null;
      change.status = 'queued'; change.internal.enqueued = true; change.next = 'Queued to merge.';
      for (const review of reviews ?? []) this.addReview(change, review, review.reviewer.replace(/^github:/, ''));
      if (failed?.length || reviews?.length) {
        change.internal.sentBack = (change.internal.sentBack ?? 0) + 1;
        if (failed?.length) {
          change.checks.push(...failed.map(check => ({ ...check, revision })));
          this.recordEvidence(change, runs ?? [], 'braid');
          this.event(change, 'checks', `Checks failed on the combined result: ${failed.filter(check => check.status === 'failed').map(check => check.label).join(', ')}.`);
        }
        change.internal.enqueued = false;
        await this.settle(key, change);
      }
      this.write(change);
      await this.indexStatus(key, change);
      return null;
    });
  }

  /* ---------- alarm and reviews ---------- */

  async dependencyChanged(id: string) {
    await this.wakeBy(Date.now() + 1);
    this.ctx.waitUntil(this.refreshDependencies(id));
  }
  private async refreshDependencies(id: string) {
    const key = this.meta.get('repository');
    if (!key) return;
    await this.serially(id, () => this.guard(async () => {
      const change = this.load(id);
      if (!change || !REVISABLE.includes(change.status)) return;
      const before = JSON.stringify(change);
      await this.settle(key, change);
      if (JSON.stringify(change) !== before) { this.write(change); await this.indexStatus(key, change); await this.notifyTask(key, change); }
      await this.enqueue(key, change);
      this.ctx.storage.sql.exec('UPDATE stack_waiters SET checked_at = ? WHERE id = ?', Date.now(), id);
    }));
  }

  async alarm() {
    // Set a recovery alarm before external inference. A terminated isolate consumes its leased attempt.
    const guideDue = this.guides.nextDue();
    if (guideDue !== null) await this.wakeBy(Date.now() + 120_000);
    await this.publishStacks();
    await this.publishActivity();
    const due = this.ctx.storage.sql.exec<{ change_id: string; revision: number; attempts: number }>('SELECT change_id, revision, attempts FROM review_jobs WHERE due <= ? ORDER BY due LIMIT 6', Date.now()).toArray();
    const key = this.meta.get('repository');
    const guides = key ? this.guides.runDue(this.env.AI, (id, revision, description) => this.guideInput(key, id, revision, description)) : Promise.resolve();
    if (key) await this.deliverTaskNotices(key);
    await Promise.all(due.map(job => this.runReview(key, job.change_id, job.revision, job.attempts)));
    if (key) for (const row of this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM changes WHERE status = 'queued' LIMIT 50").toArray()) {
      const change = this.records.read(row.value);
      if (!change.internal.enqueued) await this.enqueue(key, change);
    }
    if (key) for (const { id } of this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM stack_waiters ORDER BY checked_at LIMIT 50').toArray()) {
      await this.refreshDependencies(id);
    }
    await this.publishStacks();
    if (this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM stack_waiters').one().count
      || this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM stack_notices').one().count) await this.wakeBy(Date.now() + 5_000);
    await this.publishActivity();
    await guides;
    const nextGuide = this.guides.nextDue();
    if (nextGuide !== null) await this.wakeBy(Math.max(Date.now() + 50, nextGuide));
    const next = this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM (SELECT due FROM review_jobs UNION ALL SELECT due FROM task_notices)').one().due;
    if (next) await this.wakeBy(Math.max(Date.now() + 50, next));
  }

  private async runReview(key: string | undefined, id: string, revision: number, attempts: number) {
    const remove = () => this.ctx.storage.sql.exec('DELETE FROM review_jobs WHERE change_id = ? AND revision = ?', id, revision);
    const change = this.load(id);
    if (!key || !change || change.revision !== revision || change.status !== 'open') { remove(); return; }
    const simulated = change.author.kind === 'simulated', model = this.env.REVIEW_MODEL || this.env.AI_MODEL;
    const reviewer = simulated ? 'simulated-reviewer' : `braid-reviewer:${model}`;
    if (change.reviews.some(review => review.revision === revision && review.reviewer === reviewer)) { remove(); return; }
    try {
      const input = await this.reviewInput(key, change);
      const verdict = simulated ? simulatedReview(input) : await hostedReview(this.env.AI, model, input);
      const current = this.load(id);
      if (!current || current.revision !== revision || current.status !== 'open') { remove(); return; }
      this.addReview(current, { reviewer, kind: 'agent', ...verdict, model: simulated ? 'simulated' : model }, simulated ? 'Simulated reviewer' : 'Braid reviewer');
      remove();
      await this.settle(key, current);
      this.write(current);
      await this.enqueue(key, current);
    } catch (error) {
      logFailure('review_failed', error, { changeId: id, attempts });
      if (attempts >= 4) {
        remove();
        const current = this.load(id);
        if (current?.revision === revision && current.status === 'open') {
          current.status = 'attention'; current.next = 'Automatic review was unavailable; a person or another reviewer must decide.';
          this.event(current, 'escalated', current.next);
          this.write(current);
        }
      } else this.ctx.storage.sql.exec('UPDATE review_jobs SET attempts = attempts + 1, due = ? WHERE change_id = ? AND revision = ?', Date.now() + 15_000 * 2 ** attempts, id, revision);
    }
  }

  private async reviewInput(key: string, change: Stored): Promise<ReviewInput> {
    const patch = this.patchOf(change, change.revision);
    const repository = await this.repository(key);
    using artifacts = await artifactsOf(this.env).get(repository.id);
    const snapshot = new TreeSnapshot(this.cache.reader(artifacts));
    const files: ReviewInput['files'] = [];
    let chars = 0, incomplete = false;
    for (const [path, edit] of Object.entries(patch.files)) {
      const file = await this.fileAt(patch, path, snapshot);
      chars += (file.base?.length ?? 0) + (file.text?.length ?? 0);
      if (file.binary || chars > REVIEW_INPUT_CHARS) { incomplete = true; break; }
      files.push({ path, before: file.base ?? '', after: file.text ?? '', deleted: edit === null });
    }
    // Instructions for the files this change touches, so the reviewer holds it to rules no string match can check.
    const instructions = (await this.policy(key)).instructions.filter(instruction => !instruction.paths || files.some(file => matchesAny(file.path, instruction.paths)));
    return { title: change.title, intent: change.intent, summary: change.summary, rationale: change.rationale, files, incomplete,
      notes: unresolvedComments(change.comments ?? []).map(comment => reviewCommentText([comment])), instructions };
  }

  /** Records which repository this shard serves, so alarms can act without a request. */
  private bind(key: string, shard: number) {
    if (this.meta.get('repository') !== key) this.meta.set('repository', key);
    if (this.meta.get('shard') !== String(shard)) this.meta.set('shard', String(shard));
  }
}
