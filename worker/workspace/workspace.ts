import { clientAddress, waitForPublicReads } from '../http/public-access';
import { secretFindings, SECRET_SCAN_VERSION, type SecretFinding } from '../../shared/secrets';
import { redactEmails } from '../../shared/privacy';
import { personName } from '../repositories/provenance';
import { recordedExample, type DemoDecision, type ExampleChange, type ExampleState } from '../changes/demo';
import { mergeFile } from '../../shared/merge';
import { textDiffStats } from '../../shared/diff';
import { DurableObject } from 'cloudflare:workers';
import type { Activity, Agent, AgentFailureStage, Capabilities, Change, ChangeComment, ChangeStatus, PullRequestContext, ContextItem, EvidenceInput, FileChange, Mission, Project, ProjectImport, ProvenanceOwner, WorkspaceSnapshot } from '../../shared/types';
import { artifactsOf, directoryOf, securityOf, type BraidEnv } from '../env';
import type { AgentSandbox } from '../agents/sandbox';
import type { HostedProvider } from '../agents/providers';
import { RequestJournal, type Receipt } from '../http/operations';
import { Timings } from '../http/timing';
import { matchesEtag } from '../http/read-cache';
import { assertOrigin, digest, hex, jsonBody } from '../http/auth';
import { agents, BASE_FILES, fillDemoAgent, seedWorkspace } from './seed';
/** Git writes load isomorphic-git, which most requests never need. */
const gitWrites = () => import('../git/push');
import { integrationAuthors, integrationPreview } from './integration';
import { AgentError, agentFailure } from '../agents/errors';
import { hostedLockfiles, hostedPreflight } from '../agents/hosted-preflight';
import { failure as hostedFailureOf, HostedFailureError, HOSTED_RETRIES, runtimeFailure } from '../agents/hosted-failures';
import { hostedFailure } from '../schemas';
import { hostedTiming } from '../agents/hosted-limits';
import { hostedOutput, redactHostedText } from '../agents/hosted-output';
import type { HostedEnvironment, HostedFacts, HostedFailure, HostedPreflight } from '../../shared/types';
import { ContentStore } from './content';
import { editContent, editedFiles, fileEdit, type GitFileEdit } from '../../shared/changes';
import { localProposal, type LocalSubmission } from './local';
import { assignedTask, taskNote } from './task-input';
import { finish as finishBody, LIMITS, LOCAL_MODEL, localSubmission, merge as mergeBody, ownerHeader, actorHeader, parse, progress, project as projectBody, projectImportRetry, resolution, SUBMISSION_BYTES, SUBMISSION_TOO_LARGE } from '../schemas';
import { modelName } from '../../shared/provenance';
import { canUseCompletedWork, includedAgents } from '../../shared/tasks';
import { repositoryUrlError } from '../../shared/repository-url';
import { githubImportSource, githubReadEndpoint, githubRepositoryForImport, previewDirectory, previewFile, type ImportPreview } from '../github/routes';
import { mirrorEndpoint, refreshedMirrorSource, mirrorTransfer, mirrorImportSource, mirrorTooLarge, MIRROR_LARGE, MIRROR_LARGE_CODE, MIRROR_SYNC_MS, type MirrorRecord } from '../github/mirrors';
import type { HistoryCopy } from '../repositories/branches';
import { GitError, type GitEndpoint } from '../git/transport';
import type { GitHubRepositorySelection } from '../../shared/github';
import { demoEntries, directoryCommits, directoryEntries, fileAt, ObjectMemory, readingNames, recordedDirectoryCommits, repositoryEntry, repositoryPath, treePage } from '../repositories/repository';
import type { ComposeReader } from '../repositories/compose';
import { PublicRevisions, type RevisionScope } from '../repositories/public-revisions';
import { change, composeChanges, detectCollisions, id, mergeBlocker, now, proposalChecks } from './domain';
import { artifactsCode, artifactsFailed, errorAnswer, HttpError, logFailure, shown, unwrap } from '../errors';
import { changeShardOf, repositoryParts, shardOf, submissionShard, trunkOf } from '../changes/names';
import { unresolvedComments } from '../changes/comments';
import { checkAuthorization, type Authorization } from '../http/authorization';
import { plural } from '../../shared/labels';

/**
 * `owner` is the person who started the task, who owns the work of Braid's hosted agents on it. `provider` names whose
 * own key a hosted task runs on: the person who started it, never anyone else. It holds no key.
 */
type MissionInput = { files: Record<string, string>; context: ContextItem[]; authorization?: Authorization; owner?: ProvenanceOwner; provider?: HostedProvider };
type Job = { id: string; missionId: string; action: 'run' | 'merge'; attempts: number; started: number; restarts?: number; restartPending?: boolean; nextAttempt?: number };
type StagedProposal = { files: Record<string, GitFileEdit>; summary: string; rationale: string; checks: Agent['checks']; changes: Agent['changes']; preparedCommit?: string; submissionSignature?: string; expectedHead?: string;
  dependsOn?: (number | string)[]; baseCommit?: string; previousCommit?: string | null; publishedCommit?: string; repo?: string; remote?: string; model?: string; revision?: number;
  /** The local run that submitted it, the person whose connection that was, and the co-author lines its commits carried. */
  run?: { tool?: string; session?: string; parentSession?: string }; owner?: ProvenanceOwner; coAuthors?: string[] };
type StagedMerge = { files: Record<string, GitFileEdit>; fingerprint: string; preparedCommit?: string };
type MirrorJob = { workspaceId: string; fullName: string; userId?: string };
/** An import on its way. `replaces` names a full mirror copy that keeps serving until this one lands, then goes. */
type PendingProject = { name: string; displayName: string; description: string; sourceUrl?: string; github?: GitHubRepositorySelection; sourcePublic?: boolean; remote?: string; branch?: string; attempted?: boolean; mirror?: MirrorJob;
  authorization?: Authorization; initialToken?: string; startedAt?: string; error?: string; replaces?: string;
  /**
   * A mirror snapshot copied in parts (github/mirror-parts.ts) into its own repository, the failed import it took over
   * (whose name Artifacts still holds), and when its last part was stored.
   */
  parts?: true; partsOf?: string; progressAt?: string };
/** How long an import may keep its request waiting before Braid answers and follows the copy in the background. */
const IMPORT_ANSWER_MS = 1_500;
/** Whether a promise settles, either way, within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), ms); })]).finally(() => clearTimeout(timer));
}
const IMPORT_ERRORS: Partial<Record<ArtifactsErrorCode, string>> = {
  INVALID_URL: 'That URL does not point to a Git repository. Use its main repository URL.',
  INVALID_INPUT: 'That repository URL could not be imported. Check the URL and try again.',
  NOT_FOUND: 'That repository was not found. Check the URL and that the repository is public.',
  REMOTE_AUTH_REQUIRED: 'That repository requires authentication. Use the GitHub option to authorize access, or enter a public repository URL.',
};
/**
 * An import's history and other branches, still to copy from its source. `shallow` is the tip Artifacts imported
 * without parents; `history` is where copying beneath it stands, null once done.
 */
type BranchJob = { sourceUrl: string; github?: GitHubRepositorySelection; authorization?: Authorization; mirror?: MirrorJob; shallow: string; history?: HistoryCopy | null; failed: string[]; attempts: number; nextAttempt?: number };
/**
 * How copying history beneath an import ended: complete; stopped by its limit, a commit too large to push or a full
 * repository; or failed and retried later.
 */
type HistoryState = 'complete' | 'too-large' | { failedAt: number };
export const HISTORY_RETRY_MS = 60 * 60_000;
/** A report replaces a hosted run's state; its facts stay until a report brings new ones. Each fact must be listed. */
const HOSTED_FACTS = Object.keys({ preflight: true, recovered: true, prepared: true } satisfies Record<keyof HostedFacts, true>) as (keyof HostedFacts)[];
/**
 * Artifacts refuses every push into a repository at its storage limit, so a mirror whose copy filled is replaced by
 * one whose history reaches this share of the depth the full copy reached, leaving the rest for later syncs.
 */
const HISTORY_SHARE = 0.6;

/** Context is named for the model, never the internal task slot. Live runs can report the same model independently. */
function agentContextPath(mission: Mission, agent: Agent, model = agent.model): string {
  const slug = (model ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'agent';
  const numbered = mission.source === 'live' && mission.agents.length > 1 || slug === 'agent' || slug === 'handoff';
  const name = numbered ? `${slug}-${mission.agents.indexOf(agent) + 1}` : slug;
  return `.braid/missions/${mission.id}/${name}.md`;
}
/** The last `length` letters and digits of an id, for the names and request keys built from it. */
const idTail = (id: string, length: number) => id.replace(/[^a-zA-Z0-9]/g, '').slice(-length);
/** A multi-agent task's result as one change: its author, named for the agents, its summary and its rationale. `chosenBy` made the version choices. */
function combinedResult(mission: Mission, owner: ProvenanceOwner | undefined, chosenBy?: string) {
  const agents = includedAgents(mission), names = agents.map(agent => agent.name), choices = mission.collisions.length;
  const name = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'Task agents';
  owner ??= agents.find(agent => agent.owner)?.owner;
  return {
    author: { kind: 'agent' as const, id: `task:${mission.id}`, name, ...(owner ? { owner } : {}) },
    summary: `The combined work of ${name}${choices ? `, with ${plural(choices, 'version choice')}${chosenBy ? ` by ${chosenBy}` : ''}` : ''}.`,
    rationale: agents.map(agent => `${agent.name}: ${agent.rationale}`).join('\n').slice(0, 4000),
  };
}

export class Workspace extends DurableObject<BraidEnv> {
  private data!: WorkspaceSnapshot;
  private creating = false;
  private mirrorWork?: Promise<void>;
  private mirrorStopped = false;
  private mirrorPauseUntil = 0;
  private copyingBranches = false;
  private copyingParts = false;
  private importRead?: Promise<void>;
  private saved = new Map<string, string>();
  private journal!: RequestJournal;
  private runningAgents = new Set<string>();
  private agentStages = new Map<string, AgentFailureStage>();
  private revision = 0;
  private content!: ContentStore;
  /** Commits, trees and blobs read for browsing, kept by hash while this object lives: they never change, so a directory or file is read from Artifacts once. */
  private objects = new ObjectMemory();
  /** Which commits public readers may open, walked once while this object lives. */
  private revisions = new PublicRevisions();
  private repositoryKey?: string;
  /** Tasks whose reviewed result is being submitted to the landing queue right now. */
  private submitting = new Set<string>();
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    this.openStorage();
    ctx.blockConcurrencyWhile(async () => {
      this.repositoryKey = await ctx.storage.get<string>('repository-key');
      this.mirrorStopped = await ctx.storage.get<boolean>('mirror-stopped') ?? false;
      this.mirrorPauseUntil = await ctx.storage.get<number>('mirror-pause-until') ?? 0;
      const rows = ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM records').toArray();
      this.saved = new Map(rows.map(row => [row.key, row.value]));
      this.revision = Number(this.saved.get('revision')) || 0;
      const currentLineStats = this.saved.get('line-stats-version') === '1';
      if (this.saved.has('project')) {
        const read = (key: string) => JSON.parse(this.saved.get(key)!);
        this.data = {
          project: read('project'), context: read('context'), activity: read('activity'), capabilities: read('capabilities'),
          missions: read('mission-order').map((key: string) => read(`mission:${key}`)),
          files: Object.fromEntries(rows.filter(row => row.key.startsWith('file:')).map(row => [row.key.slice(5), JSON.parse(row.value)])),
        };
      } else {
        const legacy = await ctx.storage.get<WorkspaceSnapshot>('workspace');
        if (legacy) { this.data = legacy; await this.save(undefined, 200, undefined, false); await ctx.storage.delete('workspace'); }
      }
      let migrated = false;
      if (this.data) for (const mission of this.data.missions) if (mission.source === 'demo') for (const agent of mission.agents) {
        if (!agent.owner) { agent.owner = { name: 'Maya Chen', github: 'maya-chen' }; migrated = true; }
      }
      // Tasks from before local execution existed ran in the cloud.
      if (this.data) for (const mission of this.data.missions) if (!mission.execution) { mission.execution = 'cloud'; migrated = true; }
      if (this.data) for (const mission of this.data.missions) for (const agent of mission.agents)
        agent.changes = await Promise.all(agent.changes.map(async file => {
          if (file.contentRef) {
            const key = `proposal-scan:${file.contentRef}`;
            if (this.content.get<{ version: number }>(key)?.version !== SECRET_SCAN_VERSION) {
              const full = this.loadChange(file);
              this.content.put(key, { version: SECRET_SCAN_VERSION, findings: secretFindings([full]) });
              migrated = true;
            }
            return file;
          }
          migrated = true;
          return this.storeChange({ ...file, ...(!currentLineStats ? change(file.path, file.before, file.after) : {}) });
        }));
      // Every file now has stored content, its line stats recomputed on the way in; only the version marker is new.
      if (this.data && !currentLineStats) migrated = true;
      if (migrated) await this.save(undefined, 200, undefined, false);
    });
  }
  private openStorage() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS inputs (mission TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS git_plans (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.journal = new RequestJournal(sql);
    this.content = new ContentStore(this.ctx.storage);
  }
  private capabilities(mode: 'demo' | 'live'): Capabilities {
    // canWrite depends on who is asking; the gateway sets it on each snapshot it returns.
    return { mode, artifacts: this.env.LIVE_ENABLED !== 'false' && !!this.env.ARTIFACTS, ai: this.env.LIVE_ENABLED !== 'false' && !!this.env.AI && !!this.ctx.exports?.AgentSandbox, storage: 'durable-object', authenticated: mode === 'live', model: this.env.AI_MODEL, namespace: this.env.ARTIFACTS_NAMESPACE, canWrite: false };
  }
  private async save(receipt?: Receipt, status = 200, body?: unknown, activity = true) {
    for (const mission of this.data.missions) for (const agent of mission.agents)
      if (agent.changes.some(file => !file.contentRef)) agent.changes = await Promise.all(agent.changes.map(file => file.contentRef ? file : this.storeChange(file)));
    const records = new Map<string, string>();
    records.set('line-stats-version', '1');
    for (const key of ['project', 'context', 'activity', 'capabilities'] as const) records.set(key, JSON.stringify(this.data[key]));
    records.set('mission-order', JSON.stringify(this.data.missions.map(m => m.id)));
    for (const mission of this.data.missions) records.set(`mission:${mission.id}`, JSON.stringify(mission));
    for (const [path, content] of Object.entries(this.data.files)) records.set(`file:${path}`, JSON.stringify(content));
    records.set('revision', String(this.revision));
    const changed = records.size !== this.saved.size || [...records].some(([key, value]) => this.saved.get(key) !== value);
    if (changed) {
      this.revision++;
      records.set('revision', String(this.revision));
    }
    // Each file and mission has its own row; history cannot exceed the per-value limit of one large JSON blob.
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of records) if (value !== this.saved.get(key))
        this.ctx.storage.sql.exec('INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      for (const key of this.saved.keys()) if (!records.has(key)) this.ctx.storage.sql.exec('DELETE FROM records WHERE key = ?', key);
      this.journal.save(receipt, status, body);
    });
    this.saved = records;
    const workspaceId = repositoryParts(this.repositoryKey)?.workspaceId;
    if (activity && changed && workspaceId && this.data.project.id && this.env.DIRECTORY) {
      await this.ctx.storage.put('directory-activity', { workspaceId, updatedAt: now(), description: this.data.project.description });
      await this.publishActivity();
    }
  }
  private async publishActivity() {
    const pending = await this.ctx.storage.get<{ workspaceId: string; updatedAt: string; description: string }>('directory-activity');
    if (!pending || !this.env.DIRECTORY) return;
    try {
      await directoryOf(this.env).repositoryActivity(pending.workspaceId, pending.updatedAt, pending.description);
      const current = await this.ctx.storage.get<typeof pending>('directory-activity');
      if (current?.updatedAt === pending.updatedAt) await this.ctx.storage.delete('directory-activity');
    } catch (error) {
      logFailure('directory_activity_failed', error, { workspaceId: pending.workspaceId });
      await this.scheduleAlarm(Date.now() + 5_000);
    }
  }
  /** Imports, workflow delivery and activity publication share one alarm. */
  private async scheduleAlarm(at: number) {
    const due = await this.ctx.storage.getAlarm();
    if (due === null || at < due) await this.ctx.storage.setAlarm(at);
  }
  private event(type: Activity['type'], message: string, detail?: string, missionId?: string, agentId?: string) {
    this.data.activity.unshift({ id: id('event'), type, message, detail, timestamp: now(), missionId, agentId });
    this.data.activity = this.data.activity.slice(0, 160);
  }
  private mission(missionId: string) {
    const mission = this.data.missions.find(m => m.id === missionId);
    if (!mission) throw new HttpError(404, 'Task not found.'); return mission;
  }
  private busy() { return this.creating || this.data.missions.some(m => m.status === 'running' || m.status === 'merging'); }
  private trunkBusy() { return this.creating || this.data.missions.some(m => m.status === 'merging'); }
  private pendingLocalResult(mission: Mission) {
    return mission.execution === 'local' && mission.agents.some(agent => {
      if (agent.status === 'skipped') return false;
      const plan = this.content.get<StagedProposal>(`plan:proposal:${mission.id}:${agent.id}`);
      return plan?.baseCommit && (!plan.publishedCommit || plan.publishedCommit !== agent.commit);
    });
  }
  private async enqueue(missionId: string, action: Job['action']) {
    // Schedule first so a crash after writing the outbox cannot strand a task.
    await this.scheduleAlarm(Date.now() + 1000);
    const job: Job = { id: `${missionId}-${action}-${crypto.randomUUID().slice(0, 8)}`, missionId, action, attempts: 0, started: 0 };
    await this.ctx.storage.put(`${action}-operation:${missionId}`, job.id);
    this.ctx.storage.sql.exec('INSERT INTO jobs (id, value) VALUES (?, ?)', job.id, JSON.stringify(job));
  }
  private async currentOperation(missionId: string, action: Job['action'], operationId?: string) {
    const expected = await this.ctx.storage.get<string>(`${action}-operation:${missionId}`);
    return !expected || expected === operationId;
  }
  private async deliverJobs() {
    const jobs = this.ctx.storage.sql.exec<{ id: string; value: string }>('SELECT id, value FROM jobs').toArray();
    for (const row of jobs) {
      const job = JSON.parse(row.value) as Job;
      const mission = this.data.missions.find(m => m.id === job.missionId);
      const remove = () => this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id = ?', job.id);
      const update = () => this.ctx.storage.sql.exec('UPDATE jobs SET value = ? WHERE id = ?', JSON.stringify(job), job.id);
      if (!mission || !['running', 'merging'].includes(mission.status) || !await this.currentOperation(job.missionId, job.action, job.id)) { remove(); continue; }
      if (job.nextAttempt && Date.now() < job.nextAttempt) { await this.scheduleAlarm(job.nextAttempt); continue; }
      try {
        let instance;
        if (!job.started) {
          try {
            instance = await this.env.MISSIONS.create({ id: job.id, params: { workspaceId: this.ctx.id.toString(), missionId: job.missionId, action: job.action, operationId: job.id, agentIds: job.action === 'run' ? mission.agents.map(a => a.id) : [] } });
          } catch {
            // Creation may have succeeded before a transport error. Reuse its stable ID.
            instance = await this.env.MISSIONS.get(job.id);
            await instance.status();
          }
          job.started = Date.now();
          update();
        } else instance = await this.env.MISSIONS.get(job.id);
        const status = await instance.status();
        job.attempts = 0;
        if (['errored', 'terminated'].includes(status.status)) {
          if (job.action === 'merge') await this.failMerge(mission.id, 'The integration workflow stopped. Review the task and try again.', job.id);
          else {
            const pending = mission.agents.filter(agent => !['review', 'merged', 'skipped'].includes(agent.status));
            const reason = hostedFailureOf('workflow_step', 'workflow', { source: 'workflow', operation: 'Workflow instance status', code: status.status });
            // Restart the same Workflow ID. Agent checkpoints and publication receipts retain their identity.
            if (status.status === 'errored' && pending.some(agent => agent.environment?.status !== 'failed') && (job.restartPending || (job.restarts ?? 0) < HOSTED_RETRIES)) {
              if (!job.restartPending) {
                job.restarts = (job.restarts ?? 0) + 1;
                job.restartPending = true; job.nextAttempt = Date.now() + 1000 * 2 ** (job.restarts - 1);
                update();
                for (const agent of pending) await this.hostedWorkflowFailure(mission.id, agent.id, reason, job.restarts, job.id);
                await this.scheduleAlarm(job.nextAttempt);
              } else {
                await checkAuthorization(this.env, (await this.input(mission.id))?.authorization);
                delete job.restartPending; delete job.nextAttempt;
                update();
                await instance.restart();
              }
              continue;
            }
            for (const agent of pending) {
              if (agent.environment?.status !== 'failed') this.hostedProgress(agent, reason.message, { status: 'failed', failure: reason });
              await this.failAgent(mission.id, agent.id, reason.message, job.id);
            }
            await this.finishMission(mission.id, job.id);
          }
          remove();
        } else {
          delete job.nextAttempt; delete job.restartPending;
          update();
          if (status.status === 'complete') {
            if (job.action === 'run') await this.finishMission(mission.id, job.id);
            remove();
          }
        }
      } catch (error) {
        job.attempts++;
        logFailure('workflow_unreachable', error, { operationId: job.id, attempts: job.attempts });
        update();
        if (job.action === 'run') {
          const reason = runtimeFailure(error, 'workflow', 'Workflow delivery or status');
          for (const agent of mission.agents) if (!['review', 'merged', 'skipped'].includes(agent.status)) {
            await this.hostedWorkflowFailure(mission.id, agent.id, reason, job.attempts <= HOSTED_RETRIES ? job.attempts : 0, job.id);
            if (job.attempts > HOSTED_RETRIES) await this.failAgent(mission.id, agent.id, reason.message, job.id);
          }
          if (job.attempts > HOSTED_RETRIES) { await this.finishMission(mission.id, job.id); remove(); continue; }
          job.nextAttempt = Date.now() + 1000 * 2 ** (job.attempts - 1);
          update();
          await this.scheduleAlarm(job.nextAttempt);
        }
      }
    }
    if (this.ctx.storage.sql.exec('SELECT id FROM jobs LIMIT 1').toArray().length) await this.scheduleAlarm(Date.now() + 30_000);
  }
  private async input(missionId: string): Promise<MissionInput | undefined> {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM inputs WHERE mission = ?', missionId).toArray()[0];
    return row ? JSON.parse(row.value) : this.ctx.storage.get<MissionInput>(`input:${missionId}`);
  }
  private async gitPlan<Plan>(key: string): Promise<Plan | undefined> {
    const content = this.content.get<Plan>(`plan:${key}`);
    if (content) return content;
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM git_plans WHERE id = ?', key).toArray()[0];
    if (!row) return this.ctx.storage.get<Plan>(key);
    const legacy = JSON.parse(row.value);
    if (legacy.stored === true) throw new HttpError(503, 'The saved publication is temporarily unavailable. Retain the original submission and retry.');
    return legacy;
  }
  private saveGitPlan(key: string, plan: StagedProposal | StagedMerge) {
    this.content.put(`plan:${key}`, plan);
    if ('submissionSignature' in plan && plan.submissionSignature)
      this.content.put(`plan:${key}:request:${plan.submissionSignature}`, plan);
    this.ctx.storage.sql.exec('INSERT INTO git_plans (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', key, JSON.stringify({ stored: true }));
  }
  private async storeChange(file: FileChange): Promise<FileChange> {
    const full = { ...file, beforeHash: await digest(file.before), afterHash: await digest(file.after) };
    const contentRef = await digest(JSON.stringify(full));
    this.content.put(`diff:${contentRef}`, full);
    this.content.put(`proposal-scan:${contentRef}`, { version: SECRET_SCAN_VERSION, findings: secretFindings([full]) });
    return { ...full, before: '', after: '', contentRef };
  }
  private loadChange(file: FileChange): FileChange {
    if (!file.contentRef) return file;
    const full = this.content.get<FileChange>(`diff:${file.contentRef}`);
    if (!full) throw new HttpError(503, 'The proposal content is temporarily unavailable. Retry the same request.');
    return full;
  }
  private hydrateMission(mission: Mission): Mission {
    return { ...mission, agents: mission.agents.map(agent => ({ ...agent, changes: agent.changes.map(file => this.loadChange(file)) })) };
  }
  /** Proposal findings are written with content (legacy proposals migrate at startup), never scanned on public reads. */
  private async publicMission(mission: Mission): Promise<Mission> {
    mission = { ...mission, agents: mission.agents.map(({ connection: _connection, ...agent }) => agent) };
    const scanned = mission.agents.some(agent => agent.changes.some(file => this.content.get<{ findings: SecretFinding[] }>(`proposal-scan:${file.contentRef}`)!.findings.length > 0));
    // The linked pull requests' guards are read together, and only when the stored scans found nothing.
    const links = scanned ? [] : [...new Set(mission.agents.flatMap(agent => agent.change ? [agent.change.id] : []))];
    const changes = await Promise.all(links.map(reference => changeShardOf(this.env, this.repositoryKey!, shardOf(reference)!).get(reference, true)));
    const secrets = scanned || changes.some(change => change.ok && change.data.guards?.some(finding => finding.kind === 'secrets'));
    return secrets ? { ...mission, withheld: true, agents: mission.agents.map(agent => ({ ...agent, checks: [], changes: agent.changes.map(({ contentRef: _ref, ...file }) => ({ ...file, before: '', after: '', withheld: true })) })) } : mission;
  }
  private resultHistory(missionId: string, agent: Agent) {
    const history = [], seen = new Set<string>();
    let commit = agent.previousCommit;
    while (commit && !seen.has(commit)) {
      seen.add(commit);
      const prior = this.content.get<{ baseCommit: string; agent: Agent }>(`result:${missionId}:${agent.id}:${commit}`);
      if (!prior) throw new HttpError(503, 'Earlier result context is temporarily unavailable. Retry before merging.');
      history.push({ commit, baseCommit: prior.baseCommit, repo: prior.agent.repo, summary: prior.agent.summary, rationale: prior.agent.rationale, checks: prior.agent.checks, completedAt: prior.agent.completedAt });
      commit = prior.agent.previousCommit;
    }
    return history;
  }
  private async initialize(mode: 'demo' | 'live', persist = true) {
    if (this.data) return;
    this.data = seedWorkspace(mode, this.capabilities(mode));
    if (persist) { this.seedDemoInputs(); await this.save(); }
  }
  private seedDemoInputs() {
    for (const mission of this.data.missions) if (mission.source === 'demo')
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO inputs (mission, value) VALUES (?, ?)', mission.id, JSON.stringify({ files: BASE_FILES, context: this.data.context }));
  }
  async fetch(request: Request): Promise<Response> {
    const timings = new Timings();
    // How long the request took to get here from the gateway, apart from the work below.
    const sent = Number(request.headers.get('x-braid-sent'));
    if (sent) timings.record('transit', Date.now() - sent);
    const started = performance.now();
    const response = await this.answer(request, timings);
    timings.record('handle', performance.now() - started);
    // The gateway folds these into the request's own Server-Timing.
    if (timings.header()) response.headers.set('server-timing', timings.header());
    return response;
  }
  private async answer(request: Request, timings: Timings): Promise<Response> {
    try {
      const mode = request.headers.get('x-braid-mode') === 'live' ? 'live' : 'demo';
      const publicViewer = request.headers.get('x-braid-public') === 'true';
      await timings.wait('initialize', this.initialize(mode, !publicViewer));
      const repositoryKey = request.headers.get('x-braid-repository');
      if (repositoryKey && repositoryKey !== this.repositoryKey) { this.repositoryKey = repositoryKey; if (!publicViewer) await this.ctx.storage.put('repository-key', repositoryKey); }
      if (this.data.capabilities.mode !== mode) throw new HttpError(403, 'Workspace access does not match this session.');
      if (mode === 'demo') await timings.wait('example', this.settleExample());
      const url = new URL(request.url), path = url.pathname;
      if (mode === 'live' && request.method === 'GET' && path === '/api/state') this.ctx.waitUntil(this.resumeImportedHistory().catch(error => logFailure('import_history_resume_failed', error, { repository: this.data.project.id })));
      // A mirror has no source-token preview. Tell readers that bytes are still copying, never show seed/example files.
      const mirrorImport = !this.data.project.id ? await this.ctx.storage.get<PendingProject>('pending-project') : undefined;
      if (mirrorImport?.mirror && path.startsWith('/api/repository')) {
        const importing = await this.readImport(url, mirrorImport);
        if (importing) return importing;
      }
      // A public reader's revisions are pinned to published commits and full ref names before any reader sees them.
      if (publicViewer && mode === 'live' && request.method === 'GET' && this.repositoryKey) {
        const scope = this.revisionScope(this.repositoryKey, request.headers.get('x-braid-public-network') ?? undefined);
        if (scope) await timings.wait('revisions', this.revisions.pin(url, scope, request.headers.get('x-braid-authorized')));
      }
      if (request.method === 'GET' && path === '/api/state') {
        this.data.capabilities = this.capabilities(this.data.capabilities.mode);
        const pending = publicViewer ? mirrorImport?.mirror ? mirrorImport : undefined : await this.ctx.storage.get<PendingProject>('pending-project');
        // An import accepted before imports finished in the background has its copy but no start time: follow it from now.
        if (pending?.sourceUrl && pending.remote && !pending.startedAt && !this.creating && !this.data.project.id) {
          pending.startedAt = now();
          await this.ctx.storage.put('pending-project', pending);
          await this.scheduleAlarm(Date.now() + 500);
        }
        const importing = pending?.sourceUrl && pending.startedAt ? this.projectImport(pending) : undefined;
        // Include recorded refs on every snapshot, including existing copies, without changing their files or history.
        const project = mode === 'demo' ? { ...this.data.project, branches: [this.data.project.branch, ...(await recordedExample()).branches(await this.exampleState()).map(branch => branch.name)] } : this.data.project;
        const viewer = request.headers.get('x-braid-viewer') || `${encodeURIComponent(request.headers.get('x-braid-actor') || '')}:${request.headers.get('x-braid-role')}`;
        const etag = `"${this.ctx.id.toString()}:${this.revision}:${viewer}:${encodeURIComponent(JSON.stringify(this.data.capabilities))}:${encodeURIComponent(JSON.stringify(importing) ?? '')}:${encodeURIComponent(JSON.stringify(project.branches) ?? '')}"`;
        // Cloudflare compression can weaken the outgoing validator. GET uses weak comparison.
        if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers: { etag } });
        return Response.json(publicViewer ? { ...this.data, project, ...(pending?.mirror && importing ? { importing } : {}), missions: await Promise.all(this.data.missions.map(mission => this.publicMission(mission))) } : { ...this.data, project, ...(importing ? { importing } : {}) }, { headers: { etag } });
      }
      if (request.method === 'GET' && path === '/api/export') {
        if (mode !== 'live' || request.headers.get('x-braid-role') !== 'owner') throw new HttpError(403, 'Only an owner can export a live repository workspace.');
        const prefix = JSON.stringify({ schema: 2, exportedAt: now(), workspace: this.data }).slice(0, -1);
        const inputs = this.ctx.storage.sql.exec<{ mission: string; value: string }>('SELECT mission, value FROM inputs').toArray();
        const chunks = this.content.chunks();
        function* json() {
          yield `${prefix},"inputs":[`;
          let separator = '';
          for (const row of inputs) {
            const { files, context } = JSON.parse(row.value) as MissionInput;
            yield separator + JSON.stringify({ missionId: row.mission, files, context }); separator = ',';
          }
          yield '],"contentChunks":['; separator = '';
          for (const chunk of chunks) { yield separator + JSON.stringify(chunk); separator = ','; }
          yield ']}';
        }
        const iterator = json(), encoder = new TextEncoder();
        return new Response(new ReadableStream({ pull(controller) {
          const next = iterator.next();
          if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value));
        }, cancel() { iterator.return(); } }), { headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="braid-workspace.json"' } });
      }
      if (request.method === 'GET' && ['/api/missions', '/api/tasks'].includes(path)) return Response.json(publicViewer ? await Promise.all(this.data.missions.map(mission => this.publicMission(mission))) : this.data.missions);
      const taskMatch = path.match(/^\/api\/(?:missions|tasks)\/([^/]+)$/);
      if (request.method === 'GET' && taskMatch) return Response.json(publicViewer ? await this.publicMission(this.mission(taskMatch[1])) : this.mission(taskMatch[1]));
      const diffMatch = path.match(/^\/api\/(?:missions|tasks)\/([^/]+)\/diff$/);
      if (request.method === 'GET' && diffMatch) {
        const mission = this.mission(diffMatch[1]);
        const file = mission.agents.find(agent => agent.id === url.searchParams.get('agent'))?.changes.find(file => file.path === url.searchParams.get('path'));
        if (!file) throw new HttpError(404, 'Proposal file not found.');
        if (publicViewer && (await this.publicMission(mission)).withheld) return Response.json({ path: file.path, before: '', after: '', additions: file.additions, deletions: file.deletions, withheld: true });
        if (url.searchParams.get('ref') !== (file.contentRef ?? null)) throw new HttpError(409, 'The proposal changed. Refresh the task before reviewing this file.');
        return Response.json(this.loadChange(file));
      }
      const integrationMatch = path.match(/^\/api\/(?:missions|tasks)\/([^/]+)\/integration$/);
      if (request.method === 'GET' && integrationMatch) {
        const original = this.mission(integrationMatch[1]);
        const mission = publicViewer ? await this.publicMission(original) : original;
        const input = await this.input(mission.id);
        const preview = await integrationPreview(mission, this.data.project.head, input?.context ?? null, { queue: mission.status === 'review' && !publicViewer && (mode === 'demo' || await this.landsThroughQueue()) });
        return Response.json(mission.withheld ? { ...preview, withheld: true, ready: false, blocker: 'Content withheld because this revision contains a secret.' } : preview);
      }
      const read = request.method === 'GET' && await this.readRepository(request, url, mode, publicViewer, timings);
      if (read) return read;
      if (request.method !== 'POST') throw new HttpError(404, 'Endpoint not found.');
      if (mode === 'live' && request.headers.get('x-braid-role') !== 'owner') throw new HttpError(403, 'Only an owner can change this repository.');
      assertOrigin(request);
      const localRoute = path.match(/^\/api\/missions\/([^/]+)\/agents\/([^/]+)\/(checkout|submit|progress|update)$/);
      const body = localRoute?.[3] === 'submit' ? await jsonBody(request, SUBMISSION_BYTES, SUBMISSION_TOO_LARGE) : await jsonBody(request);
      const actor = personName(parse(actorHeader, request.headers.get('x-braid-actor') || 'You'));
      const ownerValue = request.headers.get('x-braid-owner'), owner = ownerValue ? parse(ownerHeader, ownerValue) : undefined;
      const authorization = request.headers.get('x-braid-team') ? { user: { id: request.headers.get('x-braid-user-id')!, email: actor, name: actor }, workspaceId: request.headers.get('x-braid-workspace')!, teamId: request.headers.get('x-braid-team')!, connectionDigest: request.headers.get('x-braid-connection-digest') || undefined } : undefined;
      if (localRoute) await this.checkTaskConnection(localRoute[1], localRoute[2], request.headers.get('x-braid-connection'), authorization);
      if (path === '/api/context' && body.missionId && request.headers.has('x-braid-connection')) throw new HttpError(403, 'Only an owner can send task instructions.');
      const journaled = path === '/api/missions' || path === '/api/project' || path === '/api/project/import/retry' || /^\/api\/missions\/[^/]+\/merge$/.test(path) || localRoute?.[3] === 'submit' || localRoute?.[3] === 'progress' || (path === '/api/context' && !!body.missionId);
      const receipt = journaled ? await this.journal.read(request, body, mode === 'live') : undefined;
      if (receipt?.body !== undefined) {
        const pending = receipt.status === 202 && ['/api/project', '/api/project/import/retry'].includes(path) ? await this.ctx.storage.get<PendingProject>('pending-project') : undefined;
        return new Response(pending?.sourceUrl && pending.startedAt ? JSON.stringify({ importing: this.projectImport(pending) }) : receipt.body, { status: receipt.status, headers: { 'content-type': 'application/json', 'idempotency-replayed': 'true' } });
      }
      if (path === '/api/missions') return Response.json({ missionId: await this.createMission(body, receipt, authorization, owner) }, { status: 202 });
      if (localRoute) {
        if (mode !== 'live') throw new HttpError(403, 'Local agents require a live repository.');
        const claimant = request.headers.get('x-braid-connection') || `owner:${request.headers.get('x-braid-user-id') || actor}`;
        if (localRoute[3] === 'checkout' || localRoute[3] === 'update') return Response.json(await this.checkoutLocal(localRoute[1], localRoute[2], claimant, authorization, Number(request.headers.get('x-braid-connection-expires')) || Date.now() + 3_600_000, localRoute[3] === 'update'));
        if (localRoute[3] === 'progress') return Response.json(await this.recordProgress(localRoute[1], localRoute[2], claimant, body, receipt!, authorization));
        return Response.json(await this.submitLocal(localRoute[1], localRoute[2], claimant, body, receipt!, authorization, owner));
      }
      const finish = path.match(/^\/api\/missions\/([^/]+)\/finish$/);
      if (finish) {
        if (request.headers.has('x-braid-connection')) throw new HttpError(403, 'Only an owner can continue with completed work.');
        const mission = this.mission(finish[1]);
        await checkAuthorization(this.env, authorization);
        // Check after authorization yields: a submission may have started or finished meanwhile.
        if (mission.agents.some(agent => this.runningAgents.has(`${mission.id}:${agent.id}`))) throw new HttpError(409, 'Wait for the current Git operation before continuing.');
        const completed = mission.agents.filter(agent => agent.status === 'review').map(agent => agent.id).sort();
        if (JSON.stringify(parse(finishBody, body).agentIds.sort()) !== JSON.stringify(completed))
          throw new HttpError(409, 'The completed proposals changed. Review the task again before continuing.');
        // A repeated confirmation after a lost response is harmless.
        if (mission.status === 'review' && mission.agents.some(agent => agent.status === 'skipped')) return Response.json(mission);
        if (!canUseCompletedWork(mission)) throw new HttpError(409, 'This task has no completed work to continue with, or hosted agents are still running.');
        for (const agent of mission.agents) if (agent.status !== 'review') { agent.status = 'skipped'; agent.completedAt ??= now(); }
        mission.reviewSelection = { agentIds: completed, actor, selectedAt: now() };
        mission.status = 'review'; delete mission.error;
        const previous = mission.collisions;
        mission.collisions = detectCollisions(mission.agents).map(collision => ({ ...collision, resolution: previous.find(item => item.id === collision.id)?.resolution }));
        this.event('change', 'Continued with completed work', `${actor} kept ${plural(completed.length, 'proposal')} and closed the remaining agents.`, mission.id);
        await this.save(); return Response.json(mission);
      }
      const cancel = path.match(/^\/api\/missions\/([^/]+)\/cancel$/);
      if (cancel) {
        const mission = this.mission(cancel[1]);
        if (mission.execution !== 'local' || mission.status !== 'running') throw new HttpError(409, 'Only an unfinished local task can be cancelled.');
        if (mission.agents.some(agent => this.runningAgents.has(`${mission.id}:${agent.id}`))) throw new HttpError(409, 'Wait for the current Git operation before cancelling.');
        await checkAuthorization(this.env, authorization);
        if (mission.agents.some(agent => this.runningAgents.has(`${mission.id}:${agent.id}`))) throw new HttpError(409, 'Wait for the current Git operation before cancelling.');
        mission.status = 'failed'; mission.cancelled = true; mission.error = 'This local task was cancelled by its owner.';
        for (const agent of mission.agents) if (agent.status !== 'review') { agent.status = 'failed'; agent.error = mission.error; agent.completedAt = now(); }
        this.event('error', 'Local task cancelled', mission.error, mission.id);
        await this.save(); return Response.json({ ok: true });
      }
      if (path === '/api/context') {
        const parsed = parse(taskNote, body);
        const mission = parsed.missionId ? this.mission(parsed.missionId) : undefined;
        if (mission) {
          if (mission.source !== 'live' || mission.status !== 'running') throw new HttpError(409, 'Instructions can be sent only to a running task.');
          await checkAuthorization(this.env, authorization);
        }
        if (this.data.context.length >= 100) throw new HttpError(409, 'This workspace has reached its 100-note context limit.');
        const note: ContextItem = { id: id('ctx'), ...parsed, author: actor, createdAt: now() };
        if (mission) {
          const input = await this.input(mission.id);
          if (!input) throw new HttpError(409, 'The task context is unavailable.');
          if (mission.status !== 'running') throw new HttpError(409, 'The task finished before the instruction was sent.');
          // Read again after the awaits so simultaneous instructions cannot overwrite each other.
          this.ctx.storage.transactionSync(() => {
            const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM inputs WHERE mission = ?', mission.id).toArray()[0];
            const latest: MissionInput = row ? JSON.parse(row.value) : input;
            latest.context.push(note);
            this.ctx.storage.sql.exec('INSERT OR REPLACE INTO inputs (mission, value) VALUES (?, ?)', mission.id, JSON.stringify(latest));
          });
        }
        this.data.context.unshift(note);
        this.event('context', mission ? `Instruction from ${actor}` : `Added context: ${note.title}`, mission ? note.body : undefined, mission?.id);
        await this.save(receipt, 201, note); return Response.json(note, { status: 201 });
      }
      if (path === '/api/project') return await this.createProject(body, receipt, authorization);
      if (path === '/api/project/import/retry') return await this.retryImport(body, receipt, authorization);
      if (path === '/api/reset') {
        if (mode !== 'demo') throw new HttpError(403, 'Only recorded demo workspaces can be reset.');
        if (this.busy()) throw new HttpError(409, 'Wait for the active task to finish before resetting.');
        // The copy's review conversations live in its comments shard, overlaid on the recording.
        if (this.repositoryKey?.startsWith('demo:')) await changeShardOf(this.env, this.repositoryKey, 0).resetExample(this.repositoryKey);
        await this.ctx.storage.deleteAll(); this.saved.clear(); this.openStorage();
        this.data = seedWorkspace('demo', this.capabilities('demo')); this.seedDemoInputs(); await this.save(); return Response.json({ ok: true });
      }
      const match = path.match(/^\/api\/missions\/([^/]+)\/(resolve|merge)$/);
      if (match) {
        const mission = this.mission(match[1]);
        if (mission.agents.some(agent => this.runningAgents.has(`${mission.id}:${agent.id}`))) throw new HttpError(409, 'Wait for the agent to finish publishing before reviewing this result.');
        if (this.pendingLocalResult(mission)) throw new HttpError(409, 'Retry the pending submission before reviewing or merging this task.');
        if (match[2] === 'resolve') {
          if (mission.status !== 'review' || this.submitting.has(mission.id) || includedAgents(mission).some(agent => agent.change && mission.agents.length > 1)) throw new HttpError(409, 'Decisions can be changed only while a task is in review.');
          const choice = parse(resolution, body);
          const collision = mission.collisions.find(c => c.id === choice.collisionId);
          if (!collision || !collision.agentIds.includes(choice.agentId)) throw new HttpError(400, 'Choose a valid proposal for this overlap.');
          const agent = mission.agents.find(a => a.id === choice.agentId)!;
          // A reason is worth keeping when given, but choosing should not require typing one.
          const note = choice.reason ?? `Chose ${agent.name}'s version.`;
          collision.resolution = { agentId: choice.agentId, ...(choice.reason ? { reason: choice.reason } : {}), resolvedAt: now() };
          this.data.context.unshift({ id: id('decision'), title: `${agent.name} · ${collision.path}`, body: note, kind: 'decision', author: actor, createdAt: now(), missionId: mission.id });
          this.data.context = this.data.context.slice(0, 100);
          this.event('resolution', `Selected ${agent.name}'s version`, `${collision.path} · ${note}`, mission.id, agent.id);
          await this.save(); return Response.json(mission);
        }
        const { integrationFingerprint: reviewed } = parse(mergeBody, body);
        if (mode === 'demo' || await this.landsThroughQueue()) {
          const submitted = includedAgents(mission).find(agent => agent.change)?.change;
          if (submitted) return Response.json({ missionId: mission.id, change: submitted }, { status: 202 });
          const blocker = mergeBlocker(mission, mission.baseCommit);
          if (blocker) throw new HttpError(409, blocker);
          const change = mode === 'demo' ? await this.landExample(mission, reviewed) : await this.landThroughQueue(mission, reviewed, actor);
          await this.save(receipt, 202, { missionId: mission.id, change });
          return Response.json({ missionId: mission.id, change }, { status: 202 });
        }
        const blocker = mergeBlocker(mission, this.data.project.head);
        if (blocker) throw new HttpError(409, blocker);
        if (this.trunkBusy()) throw new HttpError(409, 'Another operation is updating main. Retry when it finishes.');
        if (!reviewed) throw new HttpError(400, 'Open the integration preview before merging.');
        // Freeze decisions before hashing the preview: a concurrent resolve must not slip past review.
        mission.status = 'merging';
        try {
          const input = await this.input(mission.id);
          const preview = await integrationPreview({ ...mission, status: 'review' }, this.data.project.head, input?.context ?? null);
          if (preview.fingerprint !== reviewed)
            throw new HttpError(409, 'The integration changed after you reviewed it. Open the preview again before merging.');
          if (authorization) await this.ctx.storage.put(`merge-authorization:${mission.id}`, authorization);
          await this.enqueue(mission.id, 'merge');
          await this.save(receipt, 202, { missionId: mission.id });
        } catch (error) { mission.status = 'review'; await this.save(); throw error; }
        return Response.json({ missionId: mission.id }, { status: 202 });
      }
      throw new HttpError(404, 'Endpoint not found.');
    } catch (error) {
      const { status, retryAfter, ...answer } = errorAnswer(error, 'The operation could not complete. Retry using the same request key.');
      if (status >= 500) logFailure('workspace_request_failed', error, { status });
      return Response.json(answer, { status, ...(retryAfter ? { headers: { 'retry-after': String(retryAfter) } } : {}) });
    }
  }
  private async readObjects<T>(ref: string, timings: Timings, read: (reader: ComposeReader, ref: string, open: () => Promise<ArtifactsRepo>) => Promise<T>): Promise<T> {
    let repo: ArtifactsRepo | undefined, opening: Promise<ArtifactsRepo> | undefined;
    const open = () => opening ??= timings.wait('artifacts', artifactsOf(this.env).get(this.data.project.id))
      .then(value => repo = readingNames(value, this.names()));
    try { return await read(this.objects.lazyReader(open), await timings.wait('head', this.objects.pinnedRef(open, ref)), open); }
    finally { repo?.[Symbol.dispose](); }
  }
  private async readRepository(request: Request, url: URL, mode: 'demo' | 'live', publicViewer: boolean, timings: Timings): Promise<Response | undefined> {
    const path = url.pathname, repositoryKey = request.headers.get('x-braid-repository');
    if (['/api/repository/search', '/api/search/repository'].includes(path)) {
      const { searchRequest, repositorySearch, recordedSearch } = await import('../repositories/search');
      const query = searchRequest(url.searchParams, this.data.project.branch);
      if (mode === 'demo') {
        if (![this.data.project.branch, `refs/heads/${this.data.project.branch}`, this.data.project.head].includes(query.ref)) throw new HttpError(404, 'Repository revision not found.');
        return Response.json(recordedSearch(this.data.files, this.data.project.head, query.q));
      }
      if (!this.data.project.id || !this.data.project.head) return Response.json({ ref: '', files: [], results: [], matchCount: 0, truncated: false });
      using repo = readingNames(await timings.wait('search-artifacts', artifactsOf(this.env).get(this.data.project.id)), this.names());
      const beforeBuild = publicViewer ? async () => {
        if (!repositoryKey) throw new HttpError(503, 'Repository search is temporarily unavailable.');
        const budget = await trunkOf(this.env, repositoryKey).publicBuild(request.headers.get('x-braid-public-network') ?? 'unattributed');
        if (!budget.allowed) throw new HttpError(503, 'This repository is preparing public content. Retry shortly.', budget.retryAfter);
      } : undefined;
      const result = await repositorySearch(this, repo, query, { storage: this.ctx.storage, timings, beforeBuild });
      return Response.json(result, { headers: { 'x-braid-ref': result.ref } });
    }
    if (path === '/api/repository/commits') {
      const { historyRequest, repositoryHistory, recordedHistory } = await import('../repositories/history');
      const query = historyRequest(url.searchParams, this.data.project.branch);
      if (mode === 'demo') return Response.json(recordedHistory(await recordedExample(), await this.exampleState(), query));
      if (!this.data.project.id || !this.data.project.head) return Response.json({ ref: '', path: query.path, items: [], nextCursor: null });
      using repo = readingNames(await artifactsOf(this.env).get(this.data.project.id), this.names());
      const key = this.repositoryKey!;
      return Response.json(await repositoryHistory(repo, query, commits => trunkOf(this.env, key).provenance(key, commits, true)));
    }
    if (['/api/repository/commit', '/api/repository/commit/diff'].includes(path)) {
      const { commitRequest, commitDiffRequest, repositoryCommit, repositoryCommitDiff, recordedCommit, recordedCommitDiff } = await import('../repositories/commit');
      const { resolveRepositoryCommit } = await import('../repositories/history');
      const query = path.endsWith('/diff') ? { ...commitDiffRequest(url.searchParams), diff: true as const } : { ...commitRequest(url.searchParams), diff: false as const };
      if (mode === 'demo') {
        const example = await recordedExample(), state = await this.exampleState();
        return Response.json(query.diff ? recordedCommitDiff(example, state, query.sha, query.path) : recordedCommit(example, state, query.sha));
      }
      if (!this.data.project.id || !this.data.project.head) throw new HttpError(404, 'Commit not found.');
      using repo = readingNames(await artifactsOf(this.env).get(this.data.project.id), this.names());
      const sha = await resolveRepositoryCommit(repo, query.sha, this.data.project.branch, this.data.project.branches);
      if (query.diff) return Response.json(await repositoryCommitDiff(repo, sha, query.path));
      const key = this.repositoryKey!;
      return Response.json(await repositoryCommit(repo, sha, commits => trunkOf(this.env, key).provenance(key, commits, true)));
    }
    if (path === '/api/repository/tree' || path === '/api/repository/tree/commits') {
      const { repositoryTreeQuery } = await import('../schemas');
      const query = parse(repositoryTreeQuery, Object.fromEntries(url.searchParams));
      const directory = query.path, cursor = query.cursor ?? null, commits = path.endsWith('/commits');
      const ref = query.ref || (mode === 'live' && this.data.project.id ? this.data.project.branch : this.data.project.head);
      if (mode === 'demo') {
        const { recordedTree } = await import('../repositories/compare');
        const example = await recordedExample(), state = await this.exampleState();
        const tree = recordedTree(example, state, this.data.project, this.data.files, ref);
        const history = commits ? await this.objects.directoryCommits(tree.ref, directory, () => recordedDirectoryCommits(example, state, tree.ref, demoEntries(tree.files, directory))) : undefined;
        return Response.json({ ...treePage(tree.ref, directory, history?.entries ?? demoEntries(tree.files, directory), cursor),
          ...(history ? { historyComplete: history.historyComplete } : {}) }, { headers: { 'x-braid-ref': tree.ref } });
      }
      if (this.data.project.id) return this.readObjects(ref, timings, async (reader, ref, open) => {
        if (commits) {
          const result = await timings.wait('tree-commits', this.objects.directoryCommits(ref, directory, () => directoryCommits(this.objects.historyReader(open), ref, directory)));
          return Response.json({ ...treePage(ref, directory, result.entries, cursor), historyComplete: result.historyComplete }, { headers: { 'x-braid-ref': ref, ...(!result.cacheable ? { 'cache-control': 'no-store' } : {}) } });
        }
        const entries = await timings.wait('tree', directoryEntries(reader, ref, directory));
        // A member's first view prebuilds search; a visitor's read never writes to this repository's storage.
        if (!publicViewer && !directory && !url.searchParams.has('cursor') && this.repositoryKey) this.warmSearch({ repository: this.repositoryKey, address: clientAddress(request) });
        // The commit the answer describes, so the gateway can keep it under that commit.
        return Response.json(treePage(ref, directory, entries, cursor), { headers: { 'x-braid-ref': ref } });
      });
      const preview = publicViewer ? null : await this.importPreview();
      const entries = preview ? await previewDirectory(this.env, preview, directory) : demoEntries(this.data.files, directory);
      return Response.json({ ...treePage(preview?.branch ?? ref, directory, entries, cursor), ...(commits ? { historyComplete: entries.length === 0 } : {}) });
    }
    if (['/api/repository/branches', '/api/repository/compare', '/api/repository/compare/diff'].includes(path)) {
      const { repositoryBranches, compareRepository, repositoryDiff, exampleBranches, recordedComparison, recordedComparisonDiff } = await import('../repositories/compare');
      const { repositoryCompareQuery, repositoryDiffQuery } = await import('../schemas');
      const diff = path.endsWith('/diff');
      const comparing = path !== '/api/repository/branches';
      const input = comparing ? (diff ? { ...parse(repositoryDiffQuery, Object.fromEntries(url.searchParams)), diff: true as const } : { ...parse(repositoryCompareQuery, Object.fromEntries(url.searchParams)), diff: false as const }) : null;
      if (mode === 'demo') {
        const example = await recordedExample(), state = await this.exampleState();
        if (!input) return Response.json(exampleBranches(this.data.project, example, state));
        return Response.json(input.diff
          ? recordedComparisonDiff(example, state, this.data.project, this.data.files, input.base, input.head, input.path)
          : recordedComparison(example, state, this.data.project, this.data.files, input.base, input.head));
      }
      if (!this.data.project.id) {
        if (!input) return Response.json({ defaultBranch: this.data.project.branch, branches: [] });
        throw new HttpError(404, 'Repository not found.');
      }
      using repo = readingNames(await artifactsOf(this.env).get(this.data.project.id), this.names());
      const key = this.repositoryKey;
      const authors = key ? (commits: string[]) => trunkOf(this.env, key).provenance(key, commits, true) : undefined;
      if (!input) return Response.json(await repositoryBranches(repo, this.data.project, authors));
      if (input.diff) return Response.json(await repositoryDiff(repo, input.base, input.head, input.path));
      return Response.json(await compareRepository(repo, input.base, input.head, authors, [this.data.project.branch, ...(this.data.project.branches ?? [])]));
    }
    if (path === '/api/repository') {
      const filepath = repositoryPath(url.searchParams.get('path') || 'README.md');
      const ref = url.searchParams.get('ref') || (mode === 'live' && this.data.project.id ? this.data.project.branch : this.data.project.head);
      let content: string | undefined = Object.hasOwn(this.data.files, filepath) ? this.data.files[filepath] : undefined;
      if (mode === 'demo') {
        const { recordedTree } = await import('../repositories/compare');
        const tree = recordedTree(await recordedExample(), await this.exampleState(), this.data.project, this.data.files, ref);
        const content = Object.hasOwn(tree.files, filepath) ? tree.files[filepath] : undefined, headers = { 'x-braid-ref': tree.ref };
        if (content === undefined && demoEntries(tree.files, filepath).length) return Response.json({ content: '', path: filepath, ref: tree.ref, kind: 'dir' }, { headers });
        if (content === undefined) throw new HttpError(404, 'File not found.');
        if (url.searchParams.get('download') === '1') return new Response(content, { headers: { ...headers, 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filepath.split('/').at(-1)!)}`, 'x-content-type-options': 'nosniff' } });
        return Response.json({ content, path: filepath, ref: tree.ref }, { headers });
      }
      if (this.data.project.id) return this.readObjects(ref, timings, async (reader, ref, open) => {
        if (url.searchParams.get('download') !== '1') return Response.json(await timings.wait('file', fileAt(reader, ref, filepath)), { headers: { 'x-braid-ref': ref } });
        // A download streams the blob from Artifacts whole, however large, instead of keeping a copy.
        const entry = await repositoryEntry(reader, ref, filepath);
        if (entry.kind === 'dir' || entry.kind === 'submodule') return Response.json({ content: '', path: filepath, ref, kind: entry.kind, hash: entry.hash });
        let blob: Blob | null;
        try { blob = await (await open()).readBlob(entry.hash); }
        catch (error) {
          if (!artifactsFailed(error, 'MEMORY_LIMIT')) throw error;
          throw new HttpError(413, 'This file exceeds the browser download limit. Open it in the full Git checkout.');
        }
        if (!blob) throw new HttpError(404, 'File not found.');
        return new Response(blob.stream(), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`, 'x-content-type-options': 'nosniff' } });
      });
      const preview = !publicViewer && url.searchParams.get('download') !== '1' ? await this.importPreview() : null;
      if (preview) return Response.json({ ...await previewFile(this.env, preview, filepath), ref: preview.branch });
      if (content === undefined && demoEntries(this.data.files, filepath).length) return Response.json({ content: '', path: filepath, ref, kind: 'dir' });
      if (content === undefined) throw new HttpError(404, 'File not found.');
      if (url.searchParams.get('download') === '1') return new Response(content, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filepath.split('/').at(-1)!)}` } });
      return Response.json({ content, path: filepath, ref });
    }
  }
  private async createMission(body: unknown, receipt?: Receipt, authorization?: Authorization, owner?: ProvenanceOwner): Promise<string> {
    if (this.trunkBusy()) throw new HttpError(409, 'Another operation is updating main. Retry when it finishes.');
    if (!this.data.project.id) throw new HttpError(409, 'Create or import a repository first.');
    if (this.data.missions.length >= 30) throw new HttpError(409, 'This repository has reached the early-access limit of 30 tasks. Export its history from Settings.');
    const { title, intent, execution, ...input } = parse(assignedTask, body);
    if (execution === 'cloud' && this.data.capabilities.mode === 'live' && !this.ctx.exports?.AgentSandbox) throw new HttpError(503, 'Cloudflare sandbox execution is not configured. Connect a local agent.');
    if (execution === 'cloud' && this.data.capabilities.mode === 'live' && (!input.provider || input.provider === 'workers-ai') && !this.env.AI) throw new HttpError(503, 'Workers AI is not configured. Connect a provider in Settings → Providers or connect a local agent.');
    if (execution === 'local' && this.data.capabilities.mode !== 'live') throw new HttpError(400, 'The recorded example cannot run local agents.');
    const connections: { id: string; label: string }[] = [];
    if (input.connectionIds) {
      if (!authorization || authorization.connectionDigest) throw new HttpError(403, 'Only a signed-in owner can assign connected agents.');
      await checkAuthorization(this.env, authorization);
      const available = await securityOf(this.env).agents(authorization.user.id);
      for (const connectionId of input.connectionIds) {
        const connection = available.find(candidate => candidate.id === connectionId && candidate.workspaceId === authorization.workspaceId && candidate.scope === 'work' && candidate.expires > Date.now());
        if (!connection) throw new HttpError(403, 'Choose an active work connection you approved for this repository.');
        connections.push({ id: connection.id, label: connection.label });
      }
    }
    const agentCount = connections.length || input.agentCount || (execution === 'local' ? 1 : 3);
    this.creating = true;
    try {
    // Resolve the person's key before reserving task capacity or reading the repository.
    let provider: HostedProvider | undefined, providerModel: string | undefined;
    if (input.provider && input.provider !== 'workers-ai') {
      if (this.data.capabilities.mode !== 'live') throw new HttpError(400, 'The recorded example runs simulated agents.');
      if (!authorization || authorization.connectionDigest) throw new HttpError(403, 'Only a signed-in person can run tasks on their own provider.');
      await checkAuthorization(this.env, authorization);
      const choice = await securityOf(this.env).providerChoice(authorization.user.id, input.provider);
      if (!choice.ok) throw new HttpError(409, choice.error);
      provider = { id: input.provider, owner: authorization.user.id, version: choice.version };
      providerModel = choice.model;
    }
    let preflight: HostedPreflight | undefined;
    if (this.data.capabilities.mode === 'live') {
      await checkAuthorization(this.env, authorization);
      using repo = await artifactsOf(this.env).get(this.data.project.id);
      const head = (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
      if (!head) throw new HttpError(409, 'The repository is still preparing. Retry this task shortly.');
      this.data.project.head = head;
      if (execution === 'cloud') preflight = await this.readHostedPreflight(head);
      if (!preflight?.missing.length) {
        const security = securityOf(this.env);
        const limit = Math.max(1, Math.min(100, Number(this.env.DAILY_TASK_LIMIT) || 20));
        const budget = await security.consume(`tasks:${authorization?.teamId ?? 'owner-v1'}`, limit, 86_400_000);
        if (!budget.allowed) throw new HttpError(429, 'This team has reached its daily agent task limit.');
        const global = await security.consume('tasks:global', Math.max(1, Math.min(10_000, Number(this.env.GLOBAL_DAILY_TASK_LIMIT) || 100)), 86_400_000);
        if (!global.allowed) throw new HttpError(429, 'Agent capacity is reached for today. Existing tasks and reviews remain available.');
      }
    }
    // Hosted lanes go by the model that runs them, and by their focus when several share it.
    const hostedModel = providerModel ?? this.env.AI_MODEL, hosted = modelName(hostedModel);
    const lanes = execution === 'local' ? agents().slice(0, agentCount).map((agent, index) => ({ ...agent, name: 'Connected agent', ...(connections[index] ? { connection: connections[index] } : {}), model: undefined, role: 'Local coding agent', task: intent, scope: ['*'], summary: '' })) : this.data.capabilities.mode === 'live'
      ? agentCount === 1
        ? [{ ...agents()[0], name: hosted, model: hostedModel, ...(provider ? { provider: provider.id } : {}), role: 'Coding agent', scope: ['*'], task: 'Complete the requested change, including relevant implementation, tests and documentation. Preserve existing behavior outside the task. Run relevant project checks and report their results.' }]
        : agents().slice(0, agentCount).map(agent => ({ ...agent, name: `${hosted} (${agent.role})`, model: hostedModel, ...(provider ? { provider: provider.id } : {}), scope: ['*'], task: `Complete the requested task with attention to ${agent.role.toLowerCase()}. Run relevant checks.` }))
      : agents();
    const mission: Mission = { id: id('mission'), title, intent, status: 'running', createdAt: now(), source: this.data.capabilities.mode, execution, baseCommit: this.data.project.head, agents: lanes.map(agent => ({ ...agent, ...(owner ? { owner } : {}) })), collisions: [] };
    if (input.timeBudgetMinutes && execution === 'cloud') mission.timeBudgetMinutes = input.timeBudgetMinutes;
    if (preflight) {
      this.content.put(`hosted-preflight:${mission.id}`, preflight);
      for (const agent of mission.agents) this.hostedProgress(agent, 'Repository setup checked', { status: 'preflight', preflight });
      if (preflight.missing.length) {
        const reason = hostedFailureOf('preflight', 'preflight', { source: 'repository', operation: 'repository setup', reason: 'missing_configuration' }, '', preflight.missing[0]);
        mission.status = 'failed'; mission.error = reason.message;
        for (const agent of mission.agents) {
          agent.status = 'failed'; agent.error = reason.message; agent.completedAt = now();
          this.hostedProgress(agent, reason.message, { status: 'failed', failure: reason });
        }
      }
    }
    this.data.missions.unshift(mission);
    // Store one immutable input snapshot so concurrent lanes see exactly the same code and constraints.
    const inputFiles = this.data.capabilities.mode === 'live' ? {} : Object.fromEntries(Object.entries(this.data.files).filter(([path]) => !path.startsWith('.braid/')));
    this.ctx.storage.sql.exec('INSERT INTO inputs (mission, value) VALUES (?, ?)', mission.id, JSON.stringify({ files: inputFiles, context: this.data.context.filter(note => !note.missionId), authorization, ...(owner ? { owner } : {}), ...(provider ? { provider } : {}) } satisfies MissionInput));
    if (mission.status === 'failed') this.event('error', 'Repository setup incomplete', mission.error, mission.id);
    else this.event('fork', execution === 'local' ? `Waiting for ${mission.agents.length} local agent${mission.agents.length === 1 ? '' : 's'}` : `Started ${mission.agents.length} agent${mission.agents.length === 1 ? '' : 's'}`, title, mission.id);
    try {
      if (mission.source === 'demo') await this.scheduleAlarm(Date.now() + 900);
      else if (execution === 'cloud' && mission.status === 'running') await this.enqueue(mission.id, 'run');
      await this.save(receipt, 202, { missionId: mission.id });
    } catch (error) {
      mission.status = 'failed';
      if (mission.source === 'live' && mission.execution === 'cloud') {
        const reason = hostedFailureOf('workflow_step', 'workflow', { source: 'workflow', operation: 'launch hosted workflow', reason: 'launch' }, '', 'The task workflow could not start. Retry the task.');
        mission.error = reason.message;
        for (const agent of mission.agents) { agent.status = 'failed'; agent.error = reason.message; agent.completedAt = now(); this.hostedProgress(agent, reason.message, { status: 'failed', failure: reason }); }
        logFailure('hosted_launch_failed', error, { missionId: mission.id });
      } else mission.error = shown(error, 'Unable to launch the workflow.');
      await this.save(); throw error;
    }
    return mission.id;
    } finally { this.creating = false; }
  }
  private async releaseMissingProject(pending: PendingProject): Promise<boolean> {
    if (pending.remote) return false;
    try {
      using repo = await artifactsOf(this.env).get(pending.name);
      await repo.info();
      return false;
    } catch (error) {
      // A rejected import may have created a target before its response was lost.
      // Forget its reservation only when Artifacts confirms the target is absent.
      if (!artifactsFailed(error, 'NOT_FOUND')) { logFailure('import_reservation_check_failed', error, { repository: pending.name }); return false; }
      await this.ctx.storage.delete('pending-project');
      return true;
    }
  }
  /** Directory reserves the mirror; private reads and pinned namespaces also need its initiating viewer's proof. */
  private async authorizeMirror(job: MirrorJob) {
    if (this.mirrorStopped && this.mirrorPauseUntil <= Date.now()) await this.resumeMirror();
    const mirror = await directoryOf(this.env).mirrorRecord(job.workspaceId);
    if (this.mirrorStopped) throw new HttpError(409, 'This mirror is being claimed.');
    if (!mirror || mirror.enabled || mirror.error || mirror.fullName !== job.fullName) throw new HttpError(403, 'This repository is no longer an automatic GitHub mirror.');
    await mirrorEndpoint(this.env, mirror, job.userId);
    return mirror;
  }
  /**
   * The operator's seeding asks for a failed copy again. Only an import that ended with its error starts over; one
   * still running, a copy in parts included, is left to finish. A failed replacement is dropped instead.
   */
  async retryMirror(mirror: MirrorRecord, userId?: string): Promise<void> {
    if (this.creating || this.copyingParts) return;
    const pending = await this.ctx.storage.get<PendingProject>('pending-project');
    const directory = directoryOf(this.env);
    // Cleanup may finish before the Directory's error is cleared. Recover only a confirmed serving copy.
    if (!pending && mirror.syncedAt && this.data?.project.id) {
      using repo = await artifactsOf(this.env).get(this.data.project.id);
      await repo.info();
      await directory.mirrorUpdated(mirror.workspaceId, { importing: false, error: null });
      return;
    }
    if (!pending?.error || !pending.mirror) return;
    // A failed replacement left behind goes, so the full copy serves and syncs again; a later sync replaces it.
    if (pending.replaces) {
      await this.abandonReplacement(pending);
      await directory.mirrorUpdated(mirror.workspaceId, { error: null });
      return;
    }
    // A first copy tried again starts with the whole transfer budget, as a replacement copy does.
    await directory.mirrorReplacing(mirror.workspaceId);
    await directory.mirrorUpdated(mirror.workspaceId, { importing: true, error: null });
    await this.readMirror({ ...mirror, importing: 1, error: null }, userId);
  }
  /** Coalesce maintenance in memory; repeated importing reads merely observe the durable reservation. */
  async readMirror(mirror: MirrorRecord, userId?: string): Promise<void> {
    if (this.mirrorStopped && this.mirrorPauseUntil <= Date.now()) await this.resumeMirror();
    if (this.mirrorWork || this.mirrorStopped || this.creating || this.copyingBranches) return;
    const work = this.maintainMirror(mirror, userId);
    this.mirrorWork = work;
    try { await work; } finally { this.mirrorWork = undefined; }
  }
  private async maintainMirror(input: MirrorRecord, userId?: string) {
    const mirror = await directoryOf(this.env).mirrorRecord(input.workspaceId);
    if (!mirror || mirror.enabled || mirror.error) return;
    const job: MirrorJob = { workspaceId: mirror.workspaceId, fullName: mirror.fullName, ...(mirror.private || mirror.repositoryId ? { userId } : {}) };
    await this.authorizeMirror(job);
    await this.initialize('live');
    if (!this.repositoryKey) {
      this.repositoryKey = `team:${mirror.teamId}:repository:${mirror.workspaceId}`;
      await this.ctx.storage.put('repository-key', this.repositoryKey);
    }
    if (!this.data.project.id) {
      const pending = await this.ctx.storage.get<PendingProject>('pending-project');
      // The Directory cleared the error of a failed first copy to try again: the copy starts over under a new name,
      // since Artifacts holds a deleted name for a while, and the failed repository goes.
      if (pending?.error && pending.mirror) {
        await this.ctx.storage.delete('pending-project');
        this.ctx.waitUntil(artifactsOf(this.env).delete(pending.name).catch(error => { if (!artifactsFailed(error, 'NOT_FOUND')) logFailure('mirror_retry_cleanup_failed', error, { repository: pending.name }); }));
        await this.importMirror(mirror, job, userId, undefined, true);
      } else if (!pending) await this.importMirror(mirror, job, userId);
      return;
    }
    // A copy in progress owns the repository; a visit only makes sure its next run is scheduled.
    if (this.data.branchCopy) { await this.scheduleAlarm(Date.now() + 1_000); return; }
    // So does a replacement on its way: the full copy it replaces takes no pushes.
    if (await this.ctx.storage.get<PendingProject>('pending-project')) return;
    if (mirror.importing || mirror.syncedAt && Date.now() - Date.parse(mirror.syncedAt) < MIRROR_SYNC_MS) return;
    const source = await refreshedMirrorSource(this.env, mirror, userId);
    this.creating = true;
    try {
      using repo = await artifactsOf(this.env).get(this.data.project.id);
      const project = this.data.project;
      if (project.branch !== source.branch || project.head !== source.head) {
        const token = (await repo.createToken('write', 900)).plaintext;
        try {
          const { advertisement, relay, ZERO } = await import('../git/transport');
          const target = { remote: project.remote!, token }, ref = `refs/heads/${source.branch}`;
          const expected = (await advertisement(target, 'git-receive-pack')).refs.get(ref) ?? ZERO;
          // An unexpected default-branch write is never overwritten by automatic refresh.
          if (source.branch === project.branch && expected !== project.head) throw new HttpError(409, 'The mirror branch changed.');
          await this.authorizeMirror(job);
          await relay({ source: await mirrorEndpoint(this.env, mirror, userId), target, want: source.head, ref, expected, transfer: () => mirrorTransfer(this.env, mirror.workspaceId) });
          project.branch = source.branch; project.head = source.head;
          project.branches = [...new Set([source.branch, ...(project.branches ?? [])])];
          await this.save();
        } catch (error) {
          if (!(error instanceof GitError && error.code === 'full')) throw error;
          // Filled by later syncs, the copy keeps its limit; one never limited is measured now.
          const limit = await this.ctx.storage.get<number>('history-limit') ?? Math.floor(await this.firstParentDepth(project.head!) * HISTORY_SHARE);
          await this.replaceFullMirror(mirror, job, userId, limit);
          return;
        } finally { await repo.revokeToken(token).catch(() => { /* The sync token expires after fifteen minutes. */ }); }
      }
      await directoryOf(this.env).mirrorUpdated(mirror.workspaceId, { syncedAt: now(), branch: source.branch, head: source.head });
      // A mirror imported before history was copied in parts copies the rest once; a copy left waiting resumes.
      const copying = await this.ctx.storage.get<BranchJob>('branch-copy');
      const history = await this.ctx.storage.get<HistoryState>('history-copy');
      const retry = typeof history === 'object' ? Date.now() - history.failedAt >= HISTORY_RETRY_MS : history !== 'complete' && history !== 'too-large';
      if (copying || retry) {
        if (!copying) await this.ctx.storage.put('branch-copy', { sourceUrl: `https://github.com/${mirror.fullName}.git`, mirror: job, shallow: project.head!, failed: [], attempts: 0 } satisfies BranchJob);
        await this.scheduleAlarm(Date.now() + 1_000);
        console.log(JSON.stringify({ mirrorHistory: copying ? 'resumed' : 'queued', workspace: mirror.workspaceId }));
      }
    } finally { this.creating = false; }
  }
  /**
   * A mirror's copy starts as a depth-one import, completed by the same durable path as an owner-authorized import.
   * One that `replaces` a full copy, or `retry`s a failed one, is imported under a new name: Artifacts holds a deleted
   * name for a while.
   */
  private async importMirror(mirror: MirrorRecord, job: MirrorJob, userId?: string, replaces?: string, retry = false) {
    // Admission just checked this source; reuse its short lease while issuing the bridge grant.
    const [source, importUrl] = await Promise.all([refreshedMirrorSource(this.env, mirror, userId, false), mirrorImportSource(this.env, mirror, userId)]);
    const name = `mirror-${mirror.workspaceId.replaceAll('-', '')}`;
    const pending: PendingProject = { name: replaces || retry ? `${name}-${Date.now().toString(36)}` : name, displayName: mirror.fullName.split('/')[1], description: '',
      sourceUrl: `https://github.com/${mirror.fullName}.git`, sourcePublic: !mirror.private, branch: source.branch, startedAt: now(), attempted: true,
      mirror: job, ...(replaces ? { replaces } : {}) };
    await this.ctx.storage.put('pending-project', pending);
    if (!replaces) {
      this.data.project = { ...this.data.project, name: pending.displayName, branch: source.branch, description: '' };
      this.data.files = {};
      await this.save(undefined, 200, undefined, false);
    }
    const started = artifactsOf(this.env).import({ source: { url: importUrl, branch: source.branch, depth: 1 }, target: { name: pending.name } })
      // A snapshot larger than one import carries arrives in parts: the bridge marked the mirror when it stopped the
      // transfer at Artifacts' import limit, or Artifacts ran out of memory. Every other refusal ends the import.
      .catch(async (error: unknown) => {
        const directory = directoryOf(this.env);
        if (!artifactsFailed(error, 'MEMORY_LIMIT') && (await directory.mirrorRecord(job.workspaceId))?.error !== MIRROR_LARGE) throw error;
        await directory.mirrorUpdated(job.workspaceId, { importing: true, error: null });
        return this.importInParts(pending.name, job, source.branch);
      });
    this.ctx.waitUntil(this.followImport(pending.name, started));
    await this.scheduleAlarm(Date.now() + 2_000);
  }
  /**
   * Creates the mirror's repository and copies its snapshot in parts. The failed import still holds its own name, so
   * the copy takes `<name>-parts`, and the reservation follows it; a repository left by a stopped copy is reused.
   */
  private async importInParts(failed: string, job: MirrorJob, branch: string): Promise<ArtifactsCreateRepoResult> {
    if (this.copyingParts) throw new HttpError(409, 'This mirror is already copying.');
    // Held from before the reservation names the copy, so the alarm never resumes a copy that is starting.
    this.copyingParts = true;
    try {
      const artifacts = artifactsOf(this.env), name = `${failed}-parts`;
      const pending = await this.ctx.storage.get<PendingProject>('pending-project');
      if (pending?.name !== failed) throw new HttpError(409, 'This import ended.');
      await this.ctx.storage.put('pending-project', { ...pending, name, partsOf: failed, parts: true, progressAt: now() });
      this.ctx.waitUntil(artifacts.delete(failed).catch(error => { if (!artifactsFailed(error, 'NOT_FOUND')) logFailure('import_cleanup_failed', error, { repository: failed }); }));
      const created = await artifacts.create(name, { setDefaultBranch: branch }).catch(async (error: unknown) => {
        if (!artifactsFailed(error, 'ALREADY_EXISTS')) throw error;
        using repo = await artifacts.get(name);
        const [{ remote }, { plaintext: token }] = await Promise.all([repo.info(), repo.createToken('write', 14_400)]);
        return { id: '', name, description: null, defaultBranch: branch, remote, token };
      });
      // The new repository's own token writes the parts: Artifacts may not open it by name for a moment after creation.
      await this.copyParts(name, job, { remote: created.remote, token: created.token });
      return created;
    } finally { this.copyingParts = false; }
  }
  /**
   * Pushes the mirror's snapshot in parts that Artifacts accepts. Each stored part moves the import's deadline, and
   * the alarm resumes a copy that stopped with this object: the stored parts are not sent again.
   */
  private async copyParts(name: string, job: MirrorJob, created?: GitEndpoint) {
    const progress = async () => {
      const pending = await this.ctx.storage.get<PendingProject>('pending-project');
      if (pending?.name !== name) throw new HttpError(409, 'This import ended.');
      pending.parts = true; pending.progressAt = now();
      await this.ctx.storage.put('pending-project', pending);
    };
    await progress();
    const mirror = await this.authorizeMirror(job);
    const [source, endpoint] = await Promise.all([refreshedMirrorSource(this.env, mirror, job.userId, false), mirrorEndpoint(this.env, mirror, job.userId)]);
    const { copyInParts } = await import('../github/mirror-parts');
    const copy = (target: GitEndpoint) => copyInParts({ source: endpoint, target, commit: source.head, branch: source.branch, progress,
      transfer: () => mirrorTransfer(this.env, mirror.workspaceId, { recordOversize: false }) });
    if (created) { await copy(created); return; }
    using repo = await artifactsOf(this.env).get(name);
    const [{ remote }, { plaintext: token }] = await Promise.all([repo.info(), repo.createToken('write', 14_400)]);
    try { await copy({ remote, token }); }
    finally { await repo.revokeToken(token).catch(() => { /* The copy token expires after four hours. */ }); }
  }
  /** A copy in parts that stopped with this object, resumed by the alarm; a refusal ends the import as followImport does. */
  private async resumeParts(pending: PendingProject) {
    if (this.copyingParts) return;
    this.copyingParts = true;
    try { await this.copyParts(pending.name, pending.mirror!); }
    catch (error) {
      // A repository Artifacts is still creating is resumed by a later alarm.
      if (artifactsFailed(error, 'CREATE_IN_PROGRESS')) return;
      logFailure('repository_import_failed', error, { repository: pending.name });
      const current = await this.ctx.storage.get<PendingProject>('pending-project');
      if (current?.name !== pending.name || current.error) return;
      current.error = await this.importError(current, error);
      // A replacement that fails leaves the full copy serving, as followImport leaves it.
      if (current.replaces) { await this.abandonReplacement(current); return; }
      await this.ctx.storage.put('pending-project', current);
      await directoryOf(this.env).mirrorUpdated(current.mirror!.workspaceId, { importing: false, error: current.error });
    } finally { this.copyingParts = false; }
  }
  /** A snapshot too large for any copy reads as too large wherever it is read; other refusals keep their reason. */
  private async importError(pending: PendingProject, failure: unknown): Promise<string> {
    const code = artifactsCode(failure);
    const large = failure instanceof GitError && (failure.code === 'too_large' || failure.code === 'full') || code === 'MEMORY_LIMIT'
      || (pending.mirror && (await directoryOf(this.env).mirrorRecord(pending.mirror.workspaceId))?.error === MIRROR_LARGE);
    return pending.mirror && large ? MIRROR_LARGE : code && IMPORT_ERRORS[code] || 'The import did not finish. Try again.';
  }
  /**
   * Artifacts refuses every push into a repository at its storage limit, a sync's included, so a full copy is
   * replaced by a fresh import whose history is copied `limit` commits deep. The full copy serves until then.
   */
  private async replaceFullMirror(mirror: MirrorRecord, job: MirrorJob, userId: string | undefined, limit: number) {
    console.log(JSON.stringify({ mirror: 'replacing a full copy', workspace: mirror.workspaceId, limit }));
    await this.ctx.storage.put('history-limit', limit);
    await directoryOf(this.env).mirrorReplacing(mirror.workspaceId);
    await this.importMirror(mirror, job, userId, this.data.project.id);
  }
  /** Stop before the Directory grants any writer. An in-flight Git transfer must finish before a claim succeeds. */
  async stopMirror(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.creating || this.copyingBranches || this.mirrorWork || !this.data?.project.id) return { ok: false, error: 'The mirror is importing or syncing. Try claiming again when it finishes.' };
    this.mirrorStopped = true;
    this.mirrorPauseUntil = Date.now() + 60_000;
    await this.ctx.storage.put('mirror-stopped', true);
    await this.ctx.storage.put('mirror-pause-until', this.mirrorPauseUntil);
    return { ok: true };
  }
  async resumeMirror() {
    this.mirrorStopped = false; this.mirrorPauseUntil = 0;
    await this.ctx.storage.delete('mirror-stopped');
    await this.ctx.storage.delete('mirror-pause-until');
  }
  private async createProject(body: unknown, receipt?: Receipt, authorization?: Authorization): Promise<Response> {
    if (this.data.capabilities.mode !== 'live') throw new HttpError(403, 'Unlock the live workspace before creating a repository.');
    if (this.busy()) throw new HttpError(409, 'Wait for the active operation to finish.');
    if (this.data.project.id) throw new HttpError(409, 'This workspace already has a repository.');
    const { name: displayName, description, github, ...input } = parse(projectBody, body);
    const name = authorization ? `r-${authorization.workspaceId.replaceAll('-', '')}-${displayName.slice(0, 24)}` : displayName;
    if (github && (!authorization || authorization.connectionDigest)) throw new HttpError(403, 'Choose and authorize GitHub repositories in Braid.');
    let sourceUrl = input.sourceUrl;
    const urlError = sourceUrl && repositoryUrlError(sourceUrl);
    if (urlError) throw new HttpError(400, urlError);
    this.creating = true;
    try {
      await checkAuthorization(this.env, authorization);
      const githubRepo = github ? await githubRepositoryForImport(this.env, authorization!.user, github) : undefined;
      if (githubRepo?.private) await waitForPublicReads(await directoryOf(this.env).repositoryImported(authorization!.workspaceId, false, description));
      if (githubRepo) sourceUrl = `https://github.com/${githubRepo.fullName}.git`;
      const pendingKey = 'pending-project';
      let pending = await this.ctx.storage.get<PendingProject>(pendingKey);
      if (pending?.sourceUrl && repositoryUrlError(pending.sourceUrl) && await this.releaseMissingProject(pending)) pending = undefined;
      const same = pending && pending.name === name && pending.sourceUrl === sourceUrl && pending.description === description && JSON.stringify(pending.github) === JSON.stringify(github);
      // A stopped import gives way to another choice once Artifacts confirms it left nothing behind.
      if (pending?.error && !same && await this.releaseMissingProject(pending)) pending = undefined;
      if (pending && (pending.name !== name || pending.sourceUrl !== sourceUrl || pending.description !== description || JSON.stringify(pending.github) !== JSON.stringify(github)))
        throw new HttpError(409, 'A repository is already being prepared in this workspace. Retry the original request with the same name and source.');
      // Choosing the same source again restarts a stopped import, as Try again does.
      if (pending?.error) { this.creating = false; return await this.retryImport({}, receipt, authorization); }
      if (!pending) {
        const security = securityOf(this.env);
        const teamBudget = await security.consume(`repositories:${authorization?.teamId ?? 'owner-v1'}`, 10, 86_400_000);
        if (!teamBudget.allowed) throw new HttpError(429, 'This team has reached its daily repository creation limit.');
        const globalBudget = await security.consume('repositories:global', 100, 86_400_000);
        if (!globalBudget.allowed) throw new HttpError(429, 'Repository creation capacity is reached for today.');
        // Reserve before contacting Artifacts, so a lost response cannot create a second repository.
        pending = { name, displayName, description, sourceUrl, authorization, ...(github ? { github } : {}), ...(githubRepo ? { branch: githubRepo.defaultBranch } : {}), ...(sourceUrl ? { sourcePublic: githubRepo ? !githubRepo.private : true } : {}) };
        await this.ctx.storage.put(pendingKey, pending);
      }
      if (pending.sourceUrl && pending.startedAt) return this.importAccepted(pending, receipt);
      pending.authorization = authorization;
      if (!pending.remote) {
        const recovering = pending.attempted === true;
        let importUrl = sourceUrl;
        if (github && githubRepo) {
          try { importUrl = await githubImportSource(this.env, authorization!.user, authorization!.workspaceId, github, githubRepo); }
          catch (error) { if (!recovering) await this.ctx.storage.delete(pendingKey); throw error; }
        }
        pending.attempted = true;
        await this.ctx.storage.put(pendingKey, pending);
        const started = sourceUrl
          ? artifactsOf(this.env).import({ source: { url: importUrl!, depth: 1, ...(githubRepo ? { branch: githubRepo.defaultBranch } : {}) }, target: { name, opts: { description } } })
          : artifactsOf(this.env).create(name, { description, setDefaultBranch: 'main' });
        // Artifacts answers an import once it has copied it, which takes a large repository a while: past a moment,
        // Braid answers, the copy is followed in the background, and the source is shown meanwhile.
        if (sourceUrl && !await settlesWithin(started, IMPORT_ANSWER_MS)) {
          pending.startedAt = now();
          await this.ctx.storage.put(pendingKey, pending);
          this.ctx.waitUntil(this.followImport(name, started));
          await this.scheduleAlarm(Date.now() + 2_000);
          return this.importAccepted(pending, receipt);
        }
        try {
          const created = await started;
          pending.initialToken = created.token;
          pending.remote = created.remote; pending.branch = githubRepo?.defaultBranch || created.defaultBranch || 'main';
        } catch (error) {
          const code = artifactsCode(error), importError = sourceUrl && code && IMPORT_ERRORS[code];
          if (importError && await this.releaseMissingProject(pending)) throw new HttpError(400, importError);
          if (!artifactsFailed(error, 'ALREADY_EXISTS')) throw error;
          if (!recovering) {
            await this.ctx.storage.delete(pendingKey);
            throw new HttpError(409, 'A repository with this name already exists. Choose another name.');
          }
          using existing = await artifactsOf(this.env).get(name);
          const info = await existing.info();
          pending.remote = info.remote; pending.branch = githubRepo?.defaultBranch || info.defaultBranch || 'main';
        }
        await this.ctx.storage.put(pendingKey, pending);
      }
      const remote = pending.remote, branch = pending.branch || 'main';
      let head: string | undefined;
      if (sourceUrl) head = await this.importHead(pending);
      else {
        using repo = await artifactsOf(this.env).get(name);
        const history = await repo.log({ ref: branch, limit: 1 });
        head = history[0]?.hash;
        if (!head) {
          await checkAuthorization(this.env, authorization);
          const token = await repo.createToken('write', 900);
          try { head = await (await gitWrites()).commitFiles({ remote, token: token.plaintext, branch, files: { ...BASE_FILES }, message: 'Initialize Relay webhook project in Braid', initialize: true }); }
          finally { await repo.revokeToken(token.plaintext).catch(() => { /* The initialization token expires after fifteen minutes. */ }); }
        }
      }
      if (!head) {
        pending.startedAt = now();
        await this.scheduleAlarm(Date.now() + 2_000);
        await this.ctx.storage.put(pendingKey, pending);
        return this.importAccepted(pending, receipt);
      }
      return Response.json(await this.finalizeProject(pending, head, receipt), { status: 201 });
    } finally { this.creating = false; }
  }
  private projectImport(pending: PendingProject): ProjectImport {
    const url = new URL(pending.sourceUrl!);
    const source = url.hostname === 'github.com' ? url.pathname.slice(1).replace(/\/$/, '').replace(/\.git$/, '') : pending.sourceUrl!;
    return { name: pending.displayName, source, startedAt: pending.startedAt!, ...(pending.branch ? { branch: pending.branch } : {}), ...(pending.github && pending.branch ? { preview: true } : {}), ...(pending.error ? { error: pending.error } : {}), ...(pending.error === MIRROR_LARGE ? { code: MIRROR_LARGE_CODE } : {}) };
  }
  /**
   * Publishes an acknowledged import as soon as Artifacts answers; the alarm recovers interrupted publication.
   * A refusal stops the import with the reason, so the person can retry or choose another source.
   */
  private async followImport(name: string, started: Promise<ArtifactsCreateRepoResult>) {
    let created: ArtifactsCreateRepoResult | undefined, failure: unknown;
    try { created = await started; } catch (error) { failure = error; }
    const pending = await this.ctx.storage.get<PendingProject>('pending-project');
    // A copy in parts took this import over under its own name.
    if (pending?.name !== name && pending?.partsOf !== name || this.data.project.id && this.data.project.id !== pending.replaces) {
      // The reservation ended meanwhile, so its initial token must not outlive it.
      if (created) { try { using repo = await artifactsOf(this.env).get(created.name); await repo.revokeToken(created.token); } catch (error) { logFailure('import_abandoned_token_cleanup_failed', error, { repository: name }); } }
      return;
    }
    if (created) { pending.initialToken = created.token; pending.remote = created.remote; pending.branch ??= created.defaultBranch || 'main'; }
    else if (!artifactsFailed(failure, 'ALREADY_EXISTS')) {
      logFailure('repository_import_failed', failure, { repository: name });
      pending.error = await this.importError(pending, failure);
    }
    if (pending.replaces && pending.error) { await this.abandonReplacement(pending); return; }
    await this.ctx.storage.put('pending-project', pending);
    if (pending.mirror && pending.error) await directoryOf(this.env).mirrorUpdated(pending.mirror.workspaceId, { importing: false, error: pending.error });
    if (!pending.error) {
      await this.scheduleAlarm(Date.now() + 100);
      if (!pending.replaces) await this.finishPendingImport();
    }
  }
  /** A replacement that failed leaves the full copy serving; the next sync it can't land tries again. */
  private async abandonReplacement(pending: PendingProject) {
    logFailure('mirror_replacement_failed', new HttpError(502, pending.error ?? 'The replacement import did not finish.'), { repository: pending.name });
    await this.ctx.storage.delete('pending-project');
    await artifactsOf(this.env).delete(pending.name).catch(error => { logFailure('mirror_replacement_cleanup_failed', error, { repository: pending.name }); return false; });
  }
  /** Where a GitHub import's files can be read while Artifacts copies them, for the repository's members. */
  private async importPreview(): Promise<ImportPreview | null> {
    if (this.data.project.id) return null;
    const pending = await this.ctx.storage.get<PendingProject>('pending-project');
    if (!pending?.github || !pending.branch || !pending.startedAt || pending.error || !pending.sourceUrl) return null;
    return { github: pending.github, fullName: new URL(pending.sourceUrl).pathname.slice(1).replace(/\.git$/, ''), branch: pending.branch, authorization: pending.authorization };
  }
  /** Early Code reads share a brief publication wait; a longer import answers pending without caching empty files. */
  private async readImport(url: URL, pending: PendingProject): Promise<Response | undefined> {
    if (!pending.error) {
      this.importRead ??= (async () => {
        const until = performance.now() + IMPORT_ANSWER_MS;
        do {
          const follow = this.finishPendingImport();
          if (!await settlesWithin(follow, Math.max(0, until - performance.now()))) {
            this.ctx.waitUntil(follow.catch(error => logFailure('import_read_follow_failed', error, { repository: pending.name })));
            return;
          }
          await follow;
          if (this.data.project.id || (await this.ctx.storage.get<PendingProject>('pending-project'))?.error) return;
          const left = until - performance.now();
          if (left <= 0) return;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, left)));
        } while (performance.now() < until);
      })().finally(() => { this.importRead = undefined; });
      await this.importRead;
    }
    if (this.data.project.id) return;
    pending = await this.ctx.storage.get<PendingProject>('pending-project') ?? pending;
    if (pending.error) throw pending.error === MIRROR_LARGE ? mirrorTooLarge() : new HttpError(502, pending.error);
    if (!['/api/repository', '/api/repository/tree', '/api/repository/tree/commits'].includes(url.pathname)) throw new HttpError(503, 'This GitHub mirror is still importing. Try again shortly.', 2);
    const importing = this.projectImport(pending);
    const path = repositoryPath(url.searchParams.get('path') || (url.pathname === '/api/repository' ? 'README.md' : ''));
    const body = url.pathname === '/api/repository' ? { ref: '', path, content: '' } : treePage('', path, [], null);
    return Response.json({ ...body, importing }, { status: 202, headers: { 'cache-control': 'no-store', 'retry-after': '2' } });
  }
  private importAccepted(pending: PendingProject, receipt?: Receipt): Response {
    const body = { importing: this.projectImport(pending) };
    this.ctx.storage.transactionSync(() => this.journal.save(receipt, 202, body));
    return Response.json(body, { status: 202 });
  }
  private async importHead(pending: PendingProject): Promise<string | undefined> {
    try {
      using repo = await artifactsOf(this.env).get(pending.name);
      // These imports explicitly selected the source branch. Artifacts may not resolve its name until history arrives.
      if (pending.branch && (pending.mirror || pending.github)) return (await repo.log({ limit: 1 }))[0]?.hash;
      const head = (await repo.log({ ref: pending.branch || 'main', limit: 1 }))[0]?.hash;
      if (head) return head;
      // Artifacts can report main for a copy whose only branch is the source's own default, such as stable:
      // once HEAD has a commit, the copy is complete and its HEAD names the branch.
      const landed = (await repo.log({ limit: 1 }))[0]?.hash;
      const branch = landed && await this.importedBranch(repo);
      if (!branch) return undefined;
      pending.branch = branch;
      await this.ctx.storage.put('pending-project', pending);
      return landed;
    } catch (error) {
      // A reserved target can be absent or still copying; the durable alarm will read it again.
      if (!artifactsFailed(error, 'NOT_FOUND', 'CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS')) logFailure('import_head_failed', error, { repository: pending.name });
      return undefined;
    }
  }
  /** The branch a copy's HEAD names, from its own advertisement, read with a one-minute token. */
  private async importedBranch(repo: ArtifactsRepo): Promise<string | undefined> {
    const [{ remote }, { plaintext: token }] = await Promise.all([repo.info(), repo.createToken('read', 60)]);
    try {
      const { refs, capabilities } = await (await import('../git/transport')).advertisement({ remote, token }, 'git-upload-pack', 1024 * 1024);
      const named = [...capabilities].find(capability => capability.startsWith('symref=HEAD:refs/heads/'))?.slice('symref=HEAD:refs/heads/'.length);
      const branches = [...refs.keys()].filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice('refs/heads/'.length));
      return named ?? (branches.length === 1 ? branches[0] : undefined);
    } finally { await repo.revokeToken(token).catch(() => { /* The branch-discovery token expires after one minute. */ }); }
  }
  /** The same publication and cleanup path serves immediate and background completion. */
  private async finalizeProject(pending: PendingProject, head: string, receipt?: Receipt): Promise<Project> {
    const { name, displayName, description, sourceUrl, github, authorization } = pending;
    if (pending.mirror) await this.authorizeMirror(pending.mirror);
    else await checkAuthorization(this.env, authorization);
    if (github) {
      const source = await githubRepositoryForImport(this.env, authorization!.user, github);
      pending.sourcePublic = pending.sourcePublic !== false && !source.private;
      await this.ctx.storage.put('pending-project', pending);
    }
    // Prime the immutable objects Code reads first. Its requests share these in-flight reads without waiting for history.
    if (sourceUrl) this.ctx.waitUntil((async () => {
      using repo = await artifactsOf(this.env).get(name);
      const reader = this.objects.reader(repo);
      const entries = await directoryEntries(reader, head, '');
      const readme = entries.find(entry => entry.kind === 'file' && ['readme', 'readme.md', 'readme.markdown', 'readme.txt'].includes(entry.name.toLowerCase()));
      if (readme) await fileAt(reader, head, readme.path);
    })().catch(error => logFailure('import_code_warm_failed', error, { repository: name })));
    if (sourceUrl) await this.ctx.storage.put('repository-source', { public: pending.sourcePublic ?? (!github && !!sourceUrl) });
    if (authorization) await directoryOf(this.env).repositoryImported(authorization.workspaceId, sourceUrl ? pending.sourcePublic ?? (!github && !!sourceUrl) : undefined, description, true);
    if (!this.data.project.id || this.data.project.id === pending.replaces) {
      const branch = pending.branch || 'main';
      this.data.project = { id: name, name: displayName, description, remote: pending.remote, branch, head, stack: sourceUrl ? [] : ['TypeScript', 'Workers', 'Artifacts'], ...(sourceUrl ? { branches: [branch] } : {}) };
      this.data.files = sourceUrl ? {} : { ...BASE_FILES };
      this.event('fork', sourceUrl ? 'Imported a repository into Artifacts' : 'Created a Git repository in Artifacts', name);
      if (sourceUrl) {
        // The default branch opens now; the others follow from the alarm.
        this.data.branchCopy = { remaining: null };
        const job: BranchJob = { sourceUrl, ...(github ? { github } : {}), ...(authorization ? { authorization } : {}), ...(pending.mirror ? { mirror: pending.mirror } : {}), shallow: head, failed: [], attempts: 0 };
        await this.ctx.storage.put('repository-import', { repository: name, job });
        await this.ctx.storage.put('branch-copy', job);
        await this.scheduleAlarm(Date.now() + 1_000);
      }
    }
    await this.save(receipt, 201, this.data.project);
    // Cleanup runs after publication so revocation latency cannot hold the finished snapshot open.
    if (github || pending.mirror) this.ctx.waitUntil(Promise.resolve().then(() => securityOf(this.env).finishGitHubImports(pending.mirror?.workspaceId ?? authorization!.workspaceId))
      .catch(error => logFailure('import_grant_cleanup_failed', error, { repository: name })));
    const initialToken = pending.initialToken;
    if (initialToken) this.ctx.waitUntil((async () => {
      try { using repo = await artifactsOf(this.env).get(name); await repo.revokeToken(initialToken); }
      catch (error) { logFailure('import_token_cleanup_failed', error, { repository: name }); }
    })());
    await this.ctx.storage.delete('pending-project');
    if (pending.mirror) await directoryOf(this.env).mirrorUpdated(pending.mirror.workspaceId, { importing: false, syncedAt: now(), branch: this.data.project.branch, head });
    if (pending.replaces) {
      await this.ctx.storage.delete('history-copy');
      await artifactsOf(this.env).delete(pending.replaces).catch(error => logFailure('mirror_old_copy_cleanup_failed', error, { repository: pending.replaces }));
    }
    this.warmSearch();
    return this.data.project;
  }
  private async finishPendingImport() {
    if (this.creating) { await this.scheduleAlarm(Date.now() + 2_000); return; }
    if (this.data.project.id) await this.resumeImportedHistory();
    this.creating = true;
    try {
      const pending = await this.ctx.storage.get<PendingProject>('pending-project');
      if (!pending?.sourceUrl || !pending.startedAt || pending.error) return;
      // A copy in parts has a deadline from its last stored part, not from its start.
      const elapsed = Date.now() - Date.parse(pending.progressAt ?? pending.startedAt);
      if (elapsed >= 15 * 60_000) {
        pending.error = 'The import did not finish. Try again.';
        if (pending.replaces) { await this.abandonReplacement(pending); return; }
        await this.ctx.storage.put('pending-project', pending);
        if (pending.mirror) await directoryOf(this.env).mirrorUpdated(pending.mirror.workspaceId, { importing: false, error: pending.error });
        return;
      }
      const next = Date.now() + Math.min(5_000, 2_000 + Math.floor(elapsed / 10_000) * 1_000);
      // A copy in parts that stopped with this object resumes; one already on its branch only removes its part refs.
      if (pending.parts && pending.mirror && !this.copyingParts) this.ctx.waitUntil(this.resumeParts(pending));
      try {
        const head = await this.importHead(pending);
        if (head && !pending.remote) { using repo = await artifactsOf(this.env).get(pending.name); pending.remote = (await repo.info()).remote; }
        if (head) { await this.finalizeProject(pending, head); return; }
      } catch (error) {
        // A failed publication call must not strand an acknowledged import.
        await this.scheduleAlarm(next);
        throw error;
      }
      await this.scheduleAlarm(next);
    } finally { this.creating = false; }
  }
  /** A read or alarm can wake a retired copy only from its retained source and original authority. */
  private async resumeImportedHistory() {
    const project = this.data?.project;
    if (!project?.id || !project.remote || this.copyingBranches) return;
    const active = await this.ctx.storage.get<BranchJob>('branch-copy');
    if (active) { await this.scheduleAlarm(Math.max(Date.now() + 1_000, active.nextAttempt ?? 0)); return; }
    const state = await this.ctx.storage.get<HistoryState>('history-copy');
    if (state === 'complete' || state === 'too-large') return;
    const pending = await this.ctx.storage.get<PendingProject>('pending-project');
    if (pending?.replaces) return;
    let origin = await this.ctx.storage.get<{ repository: string; job: BranchJob }>('repository-import');
    // Older interrupted finalizations still hold their exact source and authorization in the reservation.
    if (!origin && pending?.name === project.id && pending.attempted && pending.sourceUrl) {
      origin = { repository: project.id, job: { sourceUrl: pending.sourceUrl, github: pending.github, authorization: pending.authorization, mirror: pending.mirror, shallow: project.head!, failed: [], attempts: 0 } };
      await this.ctx.storage.put('repository-import', origin);
    }
    if (!origin || origin.repository !== project.id) return;
    const due = typeof state === 'object' ? state.failedAt + HISTORY_RETRY_MS : Date.now();
    await this.scheduleAlarm(Math.max(Date.now() + 1_000, due));
    if (due > Date.now()) return;
    await this.ctx.storage.put('branch-copy', { ...origin.job, attempts: 0 } satisfies BranchJob);
    this.data.branchCopy = { remaining: null };
    console.log(JSON.stringify({ importHistory: 'resumed', repository: project.id }));
  }
  /**
   * An import's other branches, copied from its source in runs of about a minute after the default branch opened.
   * The owner who imported is rechecked before each run; a branch the source or the copy refuses is skipped.
   */
  private async copyImportedBranches() {
    const job = await this.ctx.storage.get<BranchJob>('branch-copy');
    const project = this.data?.project;
    if (!job || !project?.id || !project.remote) return;
    if (job.nextAttempt && job.nextAttempt > Date.now()) { await this.scheduleAlarm(job.nextAttempt); return; }
    // A sync or another run holds the repository; this run follows it instead of leaving the job without an alarm.
    if (this.creating || this.copyingBranches) { await this.scheduleAlarm(Date.now() + 2_000); return; }
    this.copyingBranches = true;
    try {
      if (job.mirror) await this.authorizeMirror(job.mirror);
      else await checkAuthorization(this.env, job.authorization);
      using repo = await artifactsOf(this.env).get(project.id);
      const token = (await repo.createToken('write', 900)).plaintext;
      try {
        const source = job.mirror ? await mirrorEndpoint(this.env, await this.authorizeMirror(job.mirror), job.mirror.userId) : job.github ? await githubReadEndpoint(this.env, job.authorization!.user, job.authorization!.workspaceId, job.github) : { remote: job.sourceUrl, token: '' };
        // A mirror that once filled its repository copies history to its limit and keeps its default branch alone.
        const limit = await this.ctx.storage.get<number>('history-limit');
        const history = job.history === undefined ? { boundary: [job.shallow], ...(limit === undefined ? {} : { limit }) } : job.history ?? undefined;
        const result = await (await import('../repositories/branches')).copyBranches({ source, target: { remote: project.remote, token }, defaultBranch: project.branch, until: Date.now() + 60_000, skip: new Set(job.failed),
          ...(limit === undefined ? {} : { defaultOnly: true as const }),
          ...(history ? { history: { copy: history, missing: (boundary: string[]) => this.missingParents(repo, project.head!, boundary),
            saved: async (copy: HistoryCopy | undefined) => { job.history = copy ?? null; await this.ctx.storage.put('branch-copy', job); } } } : {}),
          ...(job.mirror ? { transfer: async () => { await this.authorizeMirror(job.mirror!); return mirrorTransfer(this.env, job.mirror!.workspaceId); } } : {}) });
        job.failed = [...new Set([...job.failed, ...result.failed])];
        job.history = result.history ?? null;
        job.attempts = 0; delete job.nextAttempt;
        console.log(JSON.stringify({ branchCopy: 'ran', workspace: project.id, history: result.history ?? 'complete', remaining: result.remaining }));
        project.branches = result.branches;
        if (result.remaining || result.history && !result.history.stopped) {
          if (result.remaining) this.data.branchCopy = { remaining: result.remaining };
          await this.ctx.storage.put('branch-copy', job);
          await this.scheduleAlarm(Date.now() + 500);
        } else {
          delete this.data.branchCopy;
          await this.ctx.storage.delete('branch-copy');
          await this.ctx.storage.put('history-copy', (result.history ? 'too-large' : 'complete') satisfies HistoryState);
          const copied = result.branches.length - 1;
          if (copied > 0) this.event('fork', `Copied ${copied} ${copied === 1 ? 'branch' : 'branches'} from the source`, project.id);
          this.warmSearch();
        }
        await this.save();
      } finally { await repo.revokeToken(token).catch(() => { /* The branch-copy token expires after fifteen minutes. */ }); }
    } catch (error) {
      job.attempts++;
      const refused = error instanceof HttpError && [401, 403, 404, 503].includes(error.status);
      // A repository at its storage limit takes nothing more, now or later.
      const full = error instanceof GitError && error.code === 'full';
      logFailure('branch_copy_failed', error, { repository: project.id, attempts: job.attempts, refused, full });
      if (full && job.mirror) {
        // How deep the copy got before it filled measures what the repository holds.
        const copied = job.history?.copied ?? await this.firstParentDepth(project.head!);
        delete this.data.branchCopy;
        await this.ctx.storage.delete('branch-copy');
        await this.save();
        await this.replaceFullMirror(await this.authorizeMirror(job.mirror), job.mirror, job.mirror.userId, Math.floor(copied * HISTORY_SHARE));
        return;
      }
      if (full) {
        delete this.data.branchCopy;
        await this.ctx.storage.delete('branch-copy');
        await this.ctx.storage.put('history-copy', 'too-large' satisfies HistoryState);
        await this.save();
        return;
      }
      // Keep the source, original authority and landed boundary through outages. Other alarms and reads cannot
      // bypass the cooldown, and the next run rechecks that same authority before issuing a write token.
      job.nextAttempt = Date.now() + (refused || job.attempts >= 5 ? HISTORY_RETRY_MS : 10_000 * job.attempts);
      await this.ctx.storage.put('branch-copy', job);
      await this.ctx.storage.put('history-copy', { failedAt: Date.now() } satisfies HistoryState);
      await this.scheduleAlarm(job.nextAttempt);
    } finally { this.copyingBranches = false; }
  }
  /** How many commits the copy's default branch reaches along first parents, read a thousand at a time. */
  private async firstParentDepth(head: string) {
    using repo = await artifactsOf(this.env).get(this.data.project.id);
    let depth = 0;
    // Each page after the first starts at the last commit of the one before.
    for (let ref = head; ;) {
      const line = await repo.log({ ref, limit: 1000 });
      depth += depth ? line.length - 1 : line.length;
      if (line.length < 1000) return depth;
      ref = line.at(-1)!.hash;
    }
  }
  /**
   * The boundary commits whose parents the copy lacks, and those parents. A boundary whose parents all arrived, as when
   * a part landed before it was saved, is found again at the end of the default branch's first-parent line.
   */
  private async missingParents(repo: ArtifactsRepo, head: string, boundary: string[]) {
    const read = async (hash: string) => {
      try { return await repo.readCommit(hash); }
      catch (error) { if (artifactsFailed(error, 'NOT_FOUND')) return null; throw error; }
    };
    const lacking = async (hashes: string[]) => {
      const found = { boundary: [] as string[], parents: [] as string[] };
      for (const commit of await Promise.all(hashes.map(read))) {
        if (!commit) continue;
        const parents = (await Promise.all(commit.parents.map(async parent => await read(parent) ? null : parent))).filter((parent): parent is string => parent !== null);
        if (parents.length) { found.boundary.push(commit.hash); found.parents.push(...parents); }
      }
      return found;
    };
    const found = await lacking(boundary);
    if (found.parents.length) return found;
    // Each page starts at the last commit of the one before, so the walk reads every commit once.
    for (let ref = head; ;) {
      const line = await repo.log({ ref, limit: 1000 });
      const last = line.at(-1);
      if (!last) return found;
      if (line.length < 1000) return last.parents.length ? lacking([last.hash]) : found;
      ref = last.hash;
    }
  }
  private async retryImport(body: unknown, receipt?: Receipt, authorization?: Authorization): Promise<Response> {
    parse(projectImportRetry, body);
    if (this.data.capabilities.mode !== 'live') throw new HttpError(403, 'Unlock the live workspace before importing a repository.');
    if (this.busy()) throw new HttpError(409, 'Wait for the active operation to finish.');
    this.creating = true;
    try {
      await checkAuthorization(this.env, authorization);
      const pending = await this.ctx.storage.get<PendingProject>('pending-project');
      if (!pending?.sourceUrl) throw new HttpError(404, 'There is no repository import to retry.');
      if (pending.github && (!authorization || authorization.connectionDigest)) throw new HttpError(403, 'Choose and authorize GitHub repositories in Braid.');
      pending.authorization = authorization; pending.startedAt = now(); delete pending.error;
      await this.scheduleAlarm(Date.now() + 2_000);
      await this.ctx.storage.put('pending-project', pending);
      try {
        using repo = await artifactsOf(this.env).get(pending.name);
        const info = await repo.info();
        pending.remote = info.remote; pending.branch ??= info.defaultBranch || 'main';
      } catch (error) {
        // A target still preparing (or temporarily unreachable) remains pending.
        if (artifactsFailed(error, 'NOT_FOUND')) {
          const source = pending.github ? await githubRepositoryForImport(this.env, authorization!.user, pending.github) : undefined;
          if (source?.private) await waitForPublicReads(await directoryOf(this.env).repositoryImported(authorization!.workspaceId, false, pending.description));
          const url = source ? await githubImportSource(this.env, authorization!.user, authorization!.workspaceId, pending.github!, source) : pending.sourceUrl;
          if (source) { pending.branch = source.defaultBranch; pending.sourcePublic = pending.sourcePublic !== false && !source.private; }
          const started = artifactsOf(this.env).import({ source: { url, depth: 1, ...(source ? { branch: source.defaultBranch } : {}) }, target: { name: pending.name, opts: { description: pending.description } } });
          // As at creation: a copy that takes a while is followed in the background.
          if (!await settlesWithin(started, IMPORT_ANSWER_MS)) {
            await this.ctx.storage.put('pending-project', pending);
            this.ctx.waitUntil(this.followImport(pending.name, started));
            return this.importAccepted(pending, receipt);
          }
          const created = await started;
          pending.remote = created.remote; pending.branch ??= created.defaultBranch || 'main'; pending.initialToken = created.token;
        } else if (!artifactsFailed(error, 'CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS')) logFailure('import_retry_check_failed', error, { repository: pending.name });
      }
      await this.ctx.storage.put('pending-project', pending);
      return this.importAccepted(pending, receipt);
    } finally { this.creating = false; }
  }
  async alarm() {
    if (this.data?.capabilities.mode === 'live') {
      try { await this.finishPendingImport(); }
      finally { await this.copyImportedBranches(); await this.publishActivity(); await this.deliverJobs(); }
      return;
    }
    await this.publishActivity();
    const missions = this.data?.missions.filter(m => m.source === 'demo' && (m.status === 'running' || m.status === 'merging')) ?? [];
    for (const mission of missions) {
      if (mission.status === 'merging') { await this.integrateMission(mission.id); continue; }
      const input = await this.input(mission.id);
      if (mission.agents.every(a => a.status === 'queued')) {
        for (const agent of mission.agents) { agent.status = 'forking'; agent.startedAt = now(); agent.repo = `relay-${mission.id}-${agent.id}`; }
        this.event('fork', 'Agents are ready', 'Recorded example · every agent starts from the same commit', mission.id);
      } else if (mission.agents.some(a => a.status === 'forking')) {
        for (const agent of mission.agents) { agent.status = 'working'; agent.summary = `${agent.name} is exploring the ${agent.role.toLowerCase()} approach.`; }
        this.event('thinking', 'Agents are working in parallel', 'Recorded demo · shared constraints, independent proposals', mission.id);
      } else {
        const next = mission.agents.find(a => a.status === 'working');
        if (next) {
          Object.assign(next, fillDemoAgent(next, input?.files ?? BASE_FILES));
          this.event('change', `${next.name} submitted a proposal`, next.summary, mission.id, next.id);
          const previous = mission.collisions.length; mission.collisions = detectCollisions(mission.agents);
          if (mission.collisions.length > previous) this.event('conflict', 'An overlapping edit needs your decision', 'src/delivery.ts', mission.id);
        }
      }
      if (mission.agents.every(a => a.status === 'review')) mission.status = 'review';
    }
    if (missions.length) await this.save();
    if (missions.some(mission => mission.status === 'running')) await this.scheduleAlarm(Date.now() + 1800);
  }
  async runAgent(missionId: string, agentId: string, operationId?: string) {
    if (!await this.currentOperation(missionId, 'run', operationId)) throw new Error('This workflow has been superseded.');
    const key = `${missionId}:${agentId}`;
    if (this.runningAgents.has(key)) throw new Error('This agent is already running.');
    this.runningAgents.add(key);
    try { return await this.executeAgent(missionId, agentId); }
    catch (error) {
      const stage = this.agentStages.get(key) ?? 'authorization';
      const agent = this.mission(missionId).agents.find(candidate => candidate.id === agentId);
      const typed = error instanceof HostedFailureError ? error.failure : agent?.environment?.status === 'failed' ? agent.environment.failure
        : error instanceof HttpError && error.status < 500 ? hostedFailureOf('command', 'workflow', { source: 'repository', operation: stage, reason: stage, status: error.status, ...(error.code ? { code: error.code } : {}) }, '', agentFailure(error, stage)) : undefined;
      if (typed && agent) {
        agent.error = typed.message; agent.failureStage = stage;
        this.hostedProgress(agent, typed.message, { status: 'failed', failure: typed });
        await this.save(); return { commit: null, failure: typed };
      }
      const message = agentFailure(error, stage);
      if (agent && this.mission(missionId).status === 'running') { agent.error = message; agent.failureStage = stage; await this.save(); }
      logFailure('agent_attempt_failed', error, { missionId, agentId, stage });
      throw new Error(message);
    }
    finally { this.runningAgents.delete(key); this.agentStages.delete(key); }
  }
  private localLane(missionId: string, agentId: string) {
    const mission = this.mission(missionId);
    if (mission.source !== 'live' || mission.execution !== 'local') throw new HttpError(409, 'Choose a task created for local agents.');
    if (!['running', 'review'].includes(mission.status)) throw new HttpError(409, 'This local task is no longer accepting proposals.');
    const agent = mission.agents.find(candidate => candidate.id === agentId);
    if (!agent) throw new HttpError(404, 'Local agent lane not found.');
    if (agent.status === 'skipped') throw new HttpError(409, 'The owner closed this lane to review completed work.');
    return { mission, agent };
  }
  /** Assignment is permanent; expiry or a replayed key never makes a selected slot public. */
  private async checkTaskConnection(missionId: string, agentId: string, claimant: string | null, authorization?: Authorization) {
    const agent = this.mission(missionId).agents.find(candidate => candidate.id === agentId);
    if (!agent?.connection) return;
    if (agent.connection.id !== claimant || !authorization?.connectionDigest) throw new HttpError(403, 'This task is assigned to a different connection.');
    // With a connection digest the check returns the live grant, already matched to this owner and repository.
    const grant = await checkAuthorization(this.env, authorization);
    if (grant?.id !== claimant || grant.scope !== 'work') throw new HttpError(403, 'Use the assigned work connection for this repository.');
  }
  /** Feedback on the pull request this agent is revising, read with its task context. */
  private async reviewComments(agent: Agent): Promise<{ reviewComments: ChangeComment[]; pullRequest?: PullRequestContext }> {
    if (!agent.change || !this.repositoryKey) return { reviewComments: [] };
    const shard = shardOf(agent.change.id);
    if (shard === null) throw new HttpError(409, 'The task pull request could not be located.');
    const { id, number, status, next, dependsOn, waitingOn, outdated, comments } = unwrap(await changeShardOf(this.env, this.repositoryKey, shard).get(agent.change.id));
    return { reviewComments: unresolvedComments(comments ?? []), pullRequest: { id, number, status, next, dependsOn, waitingOn, outdated } };
  }
  private async checkoutLocal(missionId: string, agentId: string, claimant: string, authorization: Authorization | undefined, expires: number, update = false) {
    const { mission, agent } = this.localLane(missionId, agentId);
    if (update && mission.agents.length !== 1) throw new HttpError(409, 'Updating the base requires a task with one coordinating agent.');
    const key = `${missionId}:${agentId}`;
    if (this.runningAgents.has(key)) throw new HttpError(409, 'This lane is preparing or publishing. Retry shortly.');
    this.runningAgents.add(key);
    try {
      await checkAuthorization(this.env, authorization);
      const claim = await this.ctx.storage.get<{ claimant: string; expires: number }>(`local-claim:${key}`);
      if (claim && claim.claimant !== claimant && claim.expires > Date.now()) throw new HttpError(409, 'Another local agent has claimed this lane. Choose another lane or wait for its connection to expire.');
      const plan = await this.gitPlan<StagedProposal>(`proposal:${key}`);
      if (update && (this.pendingLocalResult(mission) || (plan && !plan.publishedCommit && !(agent.status === 'review' && agent.commit && !plan.baseCommit))))
        throw new HttpError(409, 'Retry the pending submission before updating its base.');
      const reviewed = agent.status === 'review';
      if (!update) await this.prepareAgentFork(mission, agent);
      await checkAuthorization(this.env, authorization);
      const observedHead = this.data.project.head;
      using repo = await artifactsOf(this.env).get(update ? this.data.project.id : agent.repo!);
      const baseCommit = update ? (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash : mission.baseCommit;
      if (!baseCommit) throw new HttpError(409, 'Main is still preparing. Retry the update shortly.');
      if (update && this.data.project.head === observedHead) this.data.project.head = baseCommit;
      const token = await repo.createToken('read', 600);
      await this.ctx.storage.put(`local-claim:${key}`, { claimant, expires: Math.min(expires, Date.now() + 3_600_000) });
      if (!update && !reviewed) { agent.status = 'working'; agent.startedAt ??= now(); agent.summary = ''; delete agent.error; delete agent.failureStage; }
      if (!claim) this.event('thinking', `${agent.name} connected`, undefined, missionId, agentId);
      await this.save();
      const input = await this.input(missionId);
      return { missionId, agentId, title: mission.title, intent: mission.intent, baseCommit, previousCommit: agent.commit ?? null, branch: this.data.project.branch, remote: update ? this.data.project.remote : agent.remote, token: token.plaintext.split('?expires=')[0], scope: agent.scope, context: input?.context ?? [], ...await this.reviewComments(agent) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      agent.failureStage = 'fork'; agent.error = agentFailure(error, 'fork'); await this.save();
      throw new HttpError(502, agent.error);
    } finally { this.runningAgents.delete(key); }
  }
  private async submitLocal(missionId: string, agentId: string, claimant: string, body: unknown, receipt: Receipt, authorization?: Authorization, owner?: ProvenanceOwner) {
    const { mission, agent } = this.localLane(missionId, agentId);
    const key = `${missionId}:${agentId}`;
    if (this.runningAgents.has(key)) throw new HttpError(409, 'This lane is already publishing. Retry the same submission shortly.');
    this.runningAgents.add(key);
    try {
      await checkAuthorization(this.env, authorization);
      const current = await this.gitPlan<StagedProposal>(`proposal:${key}`);
      let plan = await this.gitPlan<StagedProposal>(`proposal:${key}:request:${receipt.signature}`)
        ?? (current?.submissionSignature === receipt.signature ? current : undefined);
      if (plan && (plan.publishedCommit || (agent.status === 'review' && agent.commit && !plan.baseCommit))) {
        const response = { commit: plan.publishedCommit ?? agent.commit! };
        // A crash can leave the prepared plan ahead of the public snapshot. In
        // that case resume publication below so the result remains reviewable.
        if (current?.submissionSignature !== receipt.signature || response.commit === agent.commit) {
          if (current?.submissionSignature === receipt.signature && agent.status === 'review') { delete agent.error; delete agent.failureStage; }
          if (mission.status === 'review') await this.submitTaskChange(mission);
          await this.finishMission(missionId); await this.save(receipt, 200, response); return response;
        }
      }
      if (!plan && current && (!current.publishedCommit || (current.baseCommit && current.publishedCommit !== agent.commit))
        && !(agent.status === 'review' && agent.commit && !current.baseCommit))
        throw new HttpError(409, 'This lane has a saved submission. Retry its original request and key.');
      const claim = await this.ctx.storage.get<{ claimant: string; expires: number }>(`local-claim:${key}`);
      if (!claim || claim.claimant !== claimant || claim.expires <= Date.now()) throw new HttpError(403, 'Check out this lane with the current local connection before submitting.');
      if (!agent.repo || !agent.remote) throw new HttpError(409, 'Check out the local task before submitting.');
      if (!plan) {
        const submission = parse(localSubmission, body);
        if (submission.dependsOn !== undefined && this.repositoryKey) unwrap(await trunkOf(this.env, this.repositoryKey).checkDependencies(this.repositoryKey, submission.dependsOn, agent.change?.id));
        if ((submission.previousCommit ?? null) !== (agent.commit ?? null)) throw new HttpError(409, 'The proposal changed. Resume this task before submitting a revision.');
        const { baseCommit } = submission;
        if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new HttpError(409, 'This proposal uses a different base commit. Update this task before submitting.');
        const updating = baseCommit !== mission.baseCommit;
        if (updating) {
          // Only an update names the commit it replaces, even when that is null.
          if (mission.agents.length !== 1 || !('previousCommit' in submission)) throw new HttpError(409, 'Update this task before submitting against a different base commit.');
          const observedHead = this.data.project.head;
          using source = await artifactsOf(this.env).get(this.data.project.id);
          const main = (await source.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
          if (baseCommit !== main) throw new HttpError(409, 'Main changed again. Update the task, integrate the new commits, and rerun checks.');
          if (this.data.project.head === observedHead) this.data.project.head = main;
        }
        const { proposal, model, checks, evidence } = localProposal(submission, baseCommit);
        const fork = updating ? await this.updatedLocalFork(mission, agent, baseCommit) : { name: agent.repo, remote: agent.remote };
        using repo = await artifactsOf(this.env).get(fork.name);
        const expectedHead = (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
        if (!expectedHead) throw new HttpError(409, 'The proposal repository is still preparing. Retry this submission.');
        const forkHead = updating ? baseCommit : agent.commit ?? await this.ctx.storage.get<string>(`local-fork-head:${key}`) ?? mission.baseCommit;
        if (expectedHead !== forkHead) throw new HttpError(409, 'The proposal repository changed outside this task. No files were published.');
        const revision = (agent.revision ?? (agent.commit ? 1 : 0)) + 1;
        const capsule = redactEmails(`# ${agent.name}\n\n## Intent\n${mission.intent}\n\n## Outcome\n${proposal.summary}\n\n## Rationale\n${proposal.rationale}\n\n## Provenance\nExecution: local\nAgent-reported model: ${model}\nBase: ${baseCommit}\nRevision: ${revision}\nPrevious result: ${agent.commit ?? 'none'}\n\nProject commands were not executed by Braid. Local test reports are not independently verified.\n`);
        plan = { ...await this.stageProposal(repo, baseCommit, proposal.files, { path: agentContextPath(mission, agent, model), content: capsule }, true), summary: proposal.summary, rationale: proposal.rationale, checks, submissionSignature: receipt.signature, expectedHead, baseCommit, previousCommit: agent.commit ?? null, repo: fork.name, remote: fork.remote, model, revision,
          ...(submission.dependsOn !== undefined ? { dependsOn: submission.dependsOn } : {}), ...(Object.keys(submission.agent).length ? { run: submission.agent } : {}), ...(owner ? { owner } : {}), ...(submission.coAuthors.length ? { coAuthors: submission.coAuthors } : {}) };
        // Screenshots stay out of the plan, which is rewritten as it publishes. Only the latest result's are kept, until the task's change takes them.
        this.content.delete(`evidence:${missionId}:${agentId}:${revision - 1}`);
        if (evidence.length) this.content.put(`evidence:${missionId}:${agentId}:${revision}`, evidence);
        if (agent.commit) this.content.put(`result:${missionId}:${agentId}:${agent.commit}`, { baseCommit: mission.baseCommit, agent });
        this.saveGitPlan(`proposal:${key}`, plan);
      }
      // A revision becomes active only after its complete immutable plan is
      // durable. Retrying recovers this transition even after eviction.
      mission.status = 'running';
      if (plan.baseCommit) mission.baseCommit = plan.baseCommit;
      if (plan.repo) agent.repo = plan.repo;
      if (plan.remote) agent.remote = plan.remote;
      if (plan.model) agent.model = plan.model;
      if (plan.owner) agent.owner = plan.owner;
      if (plan.run?.tool) agent.tool = plan.run.tool;
      // A local lane goes by the model that worked it, once it says which; lanes sharing one keep their place.
      if (plan.model && plan.model !== LOCAL_MODEL) {
        const name = modelName(plan.model), taken = mission.agents.some(other => other !== agent && other.name === name);
        agent.name = taken ? `${name} ${mission.agents.indexOf(agent) + 1}` : name;
      }
      agent.status = 'working'; delete agent.error; delete agent.failureStage;
      agent.changes = []; agent.checks = [];
      mission.collisions = mission.collisions.filter(collision => !collision.agentIds.includes(agentId));
      await this.save();
      const response = await this.publishProposal(mission, agent, plan, authorization);
      await this.finishMission(missionId); await this.save(receipt, 200, response); return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      agent.failureStage = 'publish'; agent.error = agentFailure(error, 'publish'); await this.save();
      throw new HttpError(502, agent.error);
    } finally { this.runningAgents.delete(key); }
  }
  private updatedLocalFork(mission: Mission, agent: Agent, baseCommit: string) {
    return this.forkMain(`${this.data.project.id.slice(0, 8)}-${mission.id.replace('mission-', '').replaceAll('-', '')}-${agent.id}-u${baseCommit.slice(0, 8)}`, `${mission.title} · updated base`);
  }
  /** Forks main as `name`, or reopens the fork an earlier attempt made. The fork's own token is revoked; callers mint theirs. */
  private async forkMain(name: string, description: string) {
    using source = await artifactsOf(this.env).get(this.data.project.id);
    let initialToken: string | undefined;
    try {
      const fork = await source.fork(name, { description, defaultBranchOnly: true });
      initialToken = fork.token; return { name: fork.name, remote: fork.remote };
    } catch (error) {
      if (!artifactsFailed(error, 'ALREADY_EXISTS')) throw error;
      using existing = await artifactsOf(this.env).get(name);
      const fork = await existing.info(); return { name: fork.name, remote: fork.remote };
    } finally {
      if (initialToken) { using fork = await artifactsOf(this.env).get(name); await fork.revokeToken(initialToken); }
    }
  }
  private async recordProgress(missionId: string, agentId: string, claimant: string, body: unknown, receipt: Receipt, authorization?: Authorization) {
    const { mission, agent } = this.localLane(missionId, agentId);
    if (mission.status !== 'running' || agent.status !== 'working') throw new HttpError(409, 'Start this task before reporting progress.');
    const key = `${missionId}:${agentId}`;
    if (this.runningAgents.has(key)) throw new HttpError(409, 'The coordinator is publishing or updating. Retry shortly.');
    this.runningAgents.add(key);
    try {
      await checkAuthorization(this.env, authorization);
      const claim = await this.ctx.storage.get<{ claimant: string; expires: number }>(`local-claim:${key}`);
      if (!claim || claim.claimant !== claimant || claim.expires <= Date.now()) throw new HttpError(403, 'Only the connected agent can report progress for this task.');
      const { message } = parse(progress, body);
      agent.progress = { message, updatedAt: now() };
      this.event('thinking', message, undefined, missionId, agentId);
      await this.save(receipt, 200, agent.progress); return agent.progress;
    } finally { this.runningAgents.delete(key); }
  }
  private async prepareAgentFork(mission: Mission, agent: Agent) {
    if (agent.status !== 'review') agent.status = 'forking';
    agent.startedAt ??= now(); await this.save();
    if (!agent.repo) {
      const fork = await this.forkMain(`${this.data.project.id.slice(0, 12)}-${mission.id.replace('mission-', '').replaceAll('-', '')}-${agent.id}`, `${mission.title} · ${agent.name}`);
      agent.repo = fork.name; agent.remote = fork.remote;
      this.event('fork', `${agent.name} has an isolated Artifacts fork`, agent.repo, mission.id, agent.id); await this.save();
    }
    const prepared = await this.gitPlan<StagedProposal>(`proposal:${mission.id}:${agent.id}`);
    const headKey = `local-fork-head:${mission.id}:${agent.id}`;
    const knownHead = await this.ctx.storage.get<string>(headKey);
    for (let attempt = 0; attempt < 12; attempt++) {
      using repo = await artifactsOf(this.env).get(agent.repo);
      const head = (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
      if (head === (agent.commit ?? mission.baseCommit) || (prepared?.preparedCommit && head === prepared.preparedCommit)
        || (prepared?.repo === agent.repo && prepared?.baseCommit === mission.baseCommit && head === prepared.expectedHead)
        || (!agent.commit && knownHead && head === knownHead)) {
        if (!knownHead) await this.ctx.storage.put(headKey, head);
        return;
      }
      if (head && !knownHead && !prepared && await repo.readCommit(mission.baseCommit)) {
        await this.ctx.storage.put(headKey, head); return;
      }
      if (head) throw new AgentError('The fork no longer matches the task base revision.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new AgentError('The fork is still preparing. The workflow will retry.');
  }
  /** Internal sandbox RPC; rechecks the authorizing owner throughout execution. */
  async sandboxCheckpoint(missionId: string, agentId: string, message?: string, environment?: HostedEnvironment) {
    const mission = this.mission(missionId), agent = mission.agents.find(a => a.id === agentId);
    if (!agent || mission.status !== 'running' || mission.execution === 'local' || agent.status !== 'working') throw new Error('The hosted task is no longer running.');
    const input = await this.input(missionId);
    await checkAuthorization(this.env, input?.authorization);
    if (environment || message && agent.progress?.message !== message) {
      this.hostedProgress(agent, message, environment);
      await this.save();
    }
    return input?.context.filter(note => note.missionId === missionId) ?? [];
  }
  /** The key a hosted lane runs on: the provider its task was started with, and the person who started it. */
  private hostedProvider(agent: Agent, input: MissionInput): HostedProvider | undefined {
    if (!agent.provider && !input.provider) return undefined;
    if (!input.provider || input.provider.id !== agent.provider || !input.authorization || input.provider.owner !== input.authorization.user.id)
      throw new HostedFailureError(hostedFailureOf('provider', 'preflight', { source: 'provider', operation: 'provider connection', code: 'revoked' }, '', 'The task’s provider connection is missing. Connect it in Settings → Providers, then start again.'));
    return input.provider;
  }
  private async readHostedPreflight(commit: string) {
    using source = await artifactsOf(this.env).get(this.data.project.id);
    return hostedPreflight(commit, async path => {
      const file = await source.readFile({ ref: commit, path });
      if (!file) return null;
      if (hostedLockfiles.includes(path)) return '';
      if (file.size > 64 * 1024) {
        if (path === '.braid/policy.json') throw new HttpError(400, '.braid/policy.json exceeds the 64 KiB setup limit. Reduce it before retrying.');
        return null; // The checkout inspector reports oversized optional manifests for the model to inspect.
      }
      return new TextDecoder().decode(await file.arrayBuffer());
    });
  }
  private hostedProgress(agent: Agent, message?: string, environment?: HostedEnvironment) {
    const previous = agent.environment;
    if (environment) {
      const kept = Object.fromEntries(HOSTED_FACTS.map(key => [key, environment[key] ?? previous?.[key]])) as HostedFacts;
      agent.environment = { ...environment, ...kept };
      if (environment.failure) {
        agent.environment.failure = parse(hostedFailure, { ...environment.failure, output: hostedOutput(environment.failure.output) });
        Object.assign(agent.environment.failure.evidence, parse(hostedTiming, environment.failure.evidence));
      }
      if (agent.environment.preflight) agent.environment.preflight = { ...agent.environment.preflight,
        setup: agent.environment.preflight.setup ? redactHostedText(agent.environment.preflight.setup) : undefined,
        checks: agent.environment.preflight.checks.map(command => redactHostedText(command)) };

    }
    if (!message) return;
    message = redactHostedText(message).slice(0, 1200);
    if (agent.progress?.message === message) return;
    const at = now(), sequence = (agent.hostedActivity?.at(-1)?.sequence ?? 0) + 1;
    const reason = agent.environment?.failure;
    const event = { id: `hosted:${agent.id}:${sequence}`, sequence, at, source: 'hosted' as const,
      kind: environment?.status === 'failed' ? 'failed' as const : environment?.status === 'completed' ? 'finished' as const : 'working' as const,
      message, ...(reason ? { failure: { code: reason.cause, summary: reason.message, retryable: reason.retryable, evidence: reason.evidence, action: reason.action, lines: reason.output ? reason.output.split('\n').slice(-40) : [] },
        ...(reason.evidence.exitCode !== undefined ? { exitCode: reason.evidence.exitCode } : {}) } : {}) };
    agent.hostedActivity = [...(agent.hostedActivity ?? []), event].slice(-80);
    agent.progress = { message, updatedAt: at };
  }
  /** Workflow errors are delivered as data: no custom Error properties must survive RPC. */
  async hostedWorkflowFailure(missionId: string, agentId: string, problem: HostedFailure, attempt: number, operationId?: string) {
    if (!await this.currentOperation(missionId, 'run', operationId)) return;
    const mission = this.mission(missionId), agent = mission.agents.find(value => value.id === agentId);
    if (!agent || mission.status !== 'running' || ['review', 'merged', 'skipped'].includes(agent.status)) return;
    if (agent.environment?.status === 'failed') return;
    const reason = parse(hostedFailure, problem);
    Object.assign(reason.evidence, parse(hostedTiming, problem.evidence));
    if (!attempt && agent.failureStage) reason.evidence.reason = agent.failureStage;
    this.hostedProgress(agent, attempt ? `Retried ${attempt} of 3 · workflow step` : reason.message,
      { status: attempt ? 'retrying' : 'failed', failure: reason, ...(attempt ? { retry: { attempt, limit: 3, nextAt: new Date(Date.now() + 1000 * 2 ** (attempt - 1)).toISOString() } } : {}) });
    await this.save();
  }
  private async executeAgent(missionId: string, agentId: string) {
    const mission = this.mission(missionId), agent = mission.agents.find(a => a.id === agentId);
    const stageKey = `${missionId}:${agentId}`;
    this.agentStages.set(stageKey, 'authorization');
    if (!agent) throw new Error('Agent lane not found.');
    if (agent.status === 'review' || agent.status === 'merged') return { commit: agent.commit };
    if (agent.environment?.status === 'failed' && agent.environment.failure) throw new HostedFailureError(agent.environment.failure);
    if (mission.status !== 'running') throw new Error('This task is no longer running.');
    const input = await this.input(missionId);
    if (!input) throw new HostedFailureError(hostedFailureOf('preflight', 'preflight', { source: 'repository', operation: 'task context', reason: 'missing_context' }, '', 'The saved task context is missing. Start a new task.'));
    await checkAuthorization(this.env, input.authorization);
    if (mission.execution === 'local') throw new HttpError(409, 'This task waits for a local agent; it does not run a hosted model.');
    const provider = this.hostedProvider(agent, input);
    const staged = await this.gitPlan<StagedProposal>(`proposal:${missionId}:${agentId}`);
    if (staged) {
      delete agent.error; delete agent.failureStage;
      this.agentStages.set(stageKey, 'publish');
      return this.publishProposal(mission, agent, staged, input.authorization);
    }
    if (!agent.environment?.preflight) {
      const preflight = await this.readHostedPreflight(mission.baseCommit);
      this.content.put(`hosted-preflight:${mission.id}`, preflight);
      this.hostedProgress(agent, preflight.missing[0] ?? 'Repository setup checked', { status: 'preflight', preflight });
      await this.save();
      if (preflight.missing.length) throw new HostedFailureError(hostedFailureOf('preflight', 'preflight', { source: 'repository', operation: 'repository setup', reason: 'missing_configuration' }, '', preflight.missing[0]));
    }
    this.agentStages.set(stageKey, 'fork');
    await this.prepareAgentFork(mission, agent);
    agent.model ??= provider ? undefined : this.env.AI_MODEL;
    if (!agent.model) throw new HostedFailureError(hostedFailureOf('provider', 'preflight', { source: provider ? 'provider' : 'workers_ai', operation: provider?.id ?? 'model configuration', code: 'model' }, '', provider ? 'Choose a model in Settings → Providers and start again.' : 'Workers AI has no configured model. Choose a connected provider or connect a local agent.'));
    agent.status = 'working'; agent.summary = `Exploring the ${agent.role.toLowerCase()} approach.`; delete agent.error; delete agent.failureStage;
    this.event('thinking', `${agent.name} is working`, agent.task, missionId, agent.id); await this.save();
    this.agentStages.set(stageKey, 'generation');
    // cf's generated main-module type is broad; the sqlite export config
    // provisions this loopback as an actual Durable Object namespace.
    const sandboxes = this.ctx.exports.AgentSandbox as unknown as DurableObjectNamespace<AgentSandbox>;
    const sandbox = sandboxes.getByName(`${this.ctx.id}:${missionId}:${agentId}`);
    using result = await sandbox.run({
      workspaceId: this.ctx.id.toString(), missionId, agentId,
      repo: agent.repo!, remote: agent.remote!, baseCommit: mission.baseCommit, model: agent.model!,
      title: mission.title, intent: mission.intent, role: agent.role, task: agent.task, scope: agent.scope,
      preflight: this.content.get<HostedPreflight>(`hosted-preflight:${missionId}`) ?? agent.environment?.preflight, timeBudgetMinutes: mission.timeBudgetMinutes,
      context: input.context.map(note => `${note.kind.toUpperCase()} · ${note.title}: ${note.body}`),
      ...await this.reviewComments(agent),
      ...(provider ? { provider } : {}),
    });
    this.agentStages.set(stageKey, 'validation');
    await checkAuthorization(this.env, input.authorization);
    const submission = parse(localSubmission, { baseCommit: mission.baseCommit, summary: result.summary, rationale: result.rationale, files: result.files, dependsOn: result.dependsOn });
    if (submission.dependsOn !== undefined && this.repositoryKey) unwrap(await trunkOf(this.env, this.repositoryKey).checkDependencies(this.repositoryKey, submission.dependsOn, agent.change?.id));
    const { proposal } = localProposal(submission, mission.baseCommit);
    if (proposal.files.some(file => !agent.scope.some(scope => scope === '*' || (scope.endsWith('/') ? file.path.startsWith(scope) : file.path === scope))))
      throw new AgentError('The agent proposed files outside its authorized scope. No changes were pushed.');
    using repo = await artifactsOf(this.env).get(agent.repo!);
    const expectedHead = (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
    const knownHead = await this.ctx.storage.get<string>(`local-fork-head:${missionId}:${agentId}`) ?? mission.baseCommit;
    if (expectedHead !== knownHead) throw new AgentError('The fork no longer matches the task base revision.');
    const checks = [...proposalChecks(proposal, agent.scope), ...result.checks];
    const capsule = redactEmails(`# ${agent.name} · ${agent.role}\n\n## Intent\n${mission.intent}\n\n## Outcome\n${proposal.summary}\n\n## Rationale\n${proposal.rationale}\n\n## Provenance\nExecution: Cloudflare sandbox\nModel: ${agent.model}\nBase: ${mission.baseCommit}\nCreated: ${now()}\n\n## Executed checks\n${checks.map(check => `${check.label}: ${check.status} — ${check.detail}`).join('\n\n')}\n`);
    const plan: StagedProposal = { ...await this.stageProposal(repo, mission.baseCommit, proposal.files, { path: agentContextPath(mission, agent), content: capsule }, false),
      summary: proposal.summary, rationale: proposal.rationale, checks, expectedHead, ...(submission.dependsOn !== undefined ? { dependsOn: submission.dependsOn } : {}) };
    this.saveGitPlan(`proposal:${missionId}:${agentId}`, plan);
    this.agentStages.set(stageKey, 'publish');
    return this.publishProposal(mission, agent, plan, input.authorization);
  }
  /**
   * Checks a proposal's files as Git will write them beside the task's capsule, and stores each file that differs
   * from the base for review; files the proposal leaves as they were drop out. `local` words refusals for a local agent.
   */
  private async stageProposal(repo: ArtifactsRepo, baseCommit: string, files: LocalSubmission['files'], capsule: { path: string; content: string }, local: boolean) {
    const edits = Object.fromEntries(files.map(file => [file.path, file.mode && file.content !== null ? { content: file.content, mode: file.mode } : file.content]));
    const baseModes = await (await gitWrites()).validateGitChanges(repo, baseCommit, { ...edits, [capsule.path]: capsule.content });
    const changes: Agent['changes'] = [];
    let baseBytes = 0;
    for (const file of files) {
      const original = await repo.readFile({ ref: baseCommit, path: file.path });
      baseBytes += original?.size ?? 0;
      if (baseBytes > LIMITS.baseBytes) throw new HttpError(413, 'The combined base files exceed the 6 MiB text review limit.');
      let before = '';
      try { if (original) before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await original.arrayBuffer()); }
      catch { throw new HttpError(400, local ? 'Only UTF-8 base files can be replaced by local proposals.' : 'Only UTF-8 base files can be reviewed.'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(before)) throw new HttpError(400, local ? 'Binary files cannot be replaced by local proposals.' : 'Binary changes cannot be reviewed yet.');
      const mode = file.mode && file.mode !== baseModes[file.path] ? file.mode : undefined;
      if (file.content === null) { if (original) changes.push({ ...change(file.path, before, ''), deleted: true }); }
      else if (!original || before !== file.content || mode) changes.push({ ...change(file.path, before, file.content), ...(mode ? { mode } : {}) });
    }
    if (!changes.length) throw local ? new HttpError(400, 'This proposal has no changed files.') : new AgentError('The agent returned no changed files. No commit was created.');
    return { files: { ...Object.fromEntries(changes.map(file => [file.path, fileEdit(file)])), [capsule.path]: capsule.content }, changes: await Promise.all(changes.map(file => this.storeChange(file))) };
  }
  private async publishProposal(mission: Mission, agent: Agent, plan: StagedProposal, authorization?: Authorization) {
    if (mission.status !== 'running') throw new Error('This task is no longer running.');
    await checkAuthorization(this.env, authorization);
    using repo = await artifactsOf(this.env).get(agent.repo!);
    const token = await repo.createToken('write', 900);
    try {
      agent.commit = await (await gitWrites()).commitFiles({ repository: repo, remote: agent.remote!, token: token.plaintext, branch: this.data.project.branch, expectedHead: plan.expectedHead ?? mission.baseCommit, parentCommit: mission.baseCommit, files: plan.files, message: redactEmails(`${mission.title}\n\n${agent.name}: ${plan.summary}`), authorName: personName(`${agent.name} (Braid)`), preparedCommit: plan.preparedCommit,
        onPrepared: async commit => { await checkAuthorization(this.env, authorization); plan.preparedCommit = commit; this.saveGitPlan(`proposal:${mission.id}:${agent.id}`, plan); } });
    } finally { await repo.revokeToken(token.plaintext).catch(() => {}); } // A token left unrevoked expires in 15 minutes.
    agent.changes = plan.changes;
    agent.summary = plan.summary; agent.rationale = plan.rationale; agent.checks = plan.checks; agent.status = 'review'; agent.completedAt = now(); delete agent.error; delete agent.failureStage;
    if (mission.execution === 'local') {
      agent.revision = plan.revision ?? agent.revision ?? 1;
      agent.previousCommit = plan.previousCommit ?? undefined;
      plan.publishedCommit = agent.commit;
      this.saveGitPlan(`proposal:${mission.id}:${agent.id}`, plan);
      await this.ctx.storage.put(`local-fork-head:${mission.id}:${agent.id}`, agent.commit);
    }
    this.event('change', `${agent.name} pushed a proposal`, `${plural(agent.changes.length, 'file')} · ${agent.commit.slice(0, 7)}`, mission.id, agent.id);
    const existing = mission.collisions;
    mission.collisions = detectCollisions(mission.agents).map(c => ({ ...c, resolution: existing.find(e => e.id === c.id)?.resolution }));
    if (mission.collisions.length > existing.length) this.event('conflict', 'Independent proposals overlap', mission.collisions.map(c => c.path).join(', '), mission.id);
    await this.save(); return { commit: agent.commit };
  }
  async failAgent(missionId: string, agentId: string, message: string, operationId?: string) {
    if (!await this.currentOperation(missionId, 'run', operationId)) return;
    const mission = this.mission(missionId), agent = mission.agents.find(a => a.id === agentId);
    if (!agent || mission.status !== 'running' || agent.status === 'review') return;
    agent.status = 'failed'; agent.error = (agent.error || message).slice(0, 1000); agent.completedAt = now();
    this.event('error', `${agent.name} could not complete its lane`, agent.error, missionId, agentId); await this.save();
  }
  async finishMission(missionId: string, operationId?: string) {
    if (!await this.currentOperation(missionId, 'run', operationId)) return;
    const mission = this.mission(missionId);
    if (mission.status !== 'running') return;
    if (mission.agents.some(a => !['review', 'failed', 'skipped'].includes(a.status))) return;
    const failed = mission.agents.find(agent => agent.status === 'failed');
    mission.status = failed ? 'failed' : 'review';
    // Surface the first failure in the task banner; each lane retains its own reason in the details.
    if (failed) mission.error = failed.error ?? 'The hosted agent stopped before returning a proposal. Choose Start again to retry.';
    mission.collisions = detectCollisions(mission.agents);
    if (mission.status === 'review' && !await this.submitTaskChange(mission)) this.event('change', 'All lanes are ready for review', 'Compare the changes and decide what enters main.', missionId);
    await this.save();
  }

  /**
   * When the repository lands through the queue, a single-agent task's result
   * becomes a change (or a new revision of it) with its context capsule, so
   * policy, verification and the GitHub gate decide instead of a manual merge.
   */
  private async submitTaskChange(mission: Mission): Promise<boolean> {
    const key = this.repositoryKey, agents = includedAgents(mission);
    if (!key || mission.source !== 'live' || !agents.length || agents.some(agent => agent.status !== 'review')) return false;
    // Several agents whose work does not overlap combine without a person; overlaps wait for one.
    if (agents.length > 1 && (mission.collisions.length || agents.some(agent => agent.checks.some(check => check.status === 'failed')))) return false;
    // A queue that can't answer leaves the result for review, and landing it from there asks the queue again.
    const landing = await trunkOf(this.env, key).status(key).catch(error => { logFailure('landing_status_failed', error, { missionId: mission.id }); return null; });
    if (!landing?.enabled) return false;
    if (agents.length > 1) {
      if (agents.some(agent => agent.change)) return true;
      try {
        const link = await this.submitCombined(mission);
        this.event('change', `Opened pull request #${link.number}`, 'The agents changed different files, so their work was combined without a decision. Your rules decide when it lands.', mission.id);
        return true;
      } catch (error) {
        if (error instanceof HttpError) {
          const plans = await Promise.all(agents.map(agent => this.gitPlan<StagedProposal>(`proposal:${mission.id}:${agent.id}`)));
          if (plans.some(plan => plan?.dependsOn !== undefined)) throw error;
        }
        logFailure('task_change_failed', error, { missionId: mission.id });
        this.event('error', 'The task result could not enter the landing queue', error instanceof HttpError ? error.message : 'Review and land it here, or retry after the queue recovers.', mission.id);
        return false;
      }
    }
    const [agent] = agents;
    const plan = await this.gitPlan<StagedProposal>(`proposal:${mission.id}:${agent.id}`);
    if (!plan) return false;
    const files = editedFiles(plan.files);
    const claim = await this.ctx.storage.get<{ claimant: string }>(`local-claim:${mission.id}:${agent.id}`);
    // The result is the agent's: by its model, owned by the person whose connection submitted it or who started the task.
    const model = agent.model === LOCAL_MODEL ? undefined : agent.model, owner = plan.owner ?? (await this.input(mission.id))?.owner;
    const run = plan.run ?? (mission.execution === 'cloud' ? { tool: 'braid' } : undefined);
    const actor = { kind: 'agent' as const, id: claim?.claimant && !claim.claimant.startsWith('owner:') ? `agent:${claim.claimant}` : `task-agent:${agent.id}`, name: agent.name === 'Agent' ? 'Task agent' : agent.name,
      ...(model ? { model } : {}), ...(owner ? { owner } : {}) };
    // What the agent showed with this result goes with it; a combined result has none, since nothing ran on the combination.
    const evidenceKey = `evidence:${mission.id}:${agent.id}:${agent.revision ?? 1}`, evidence = this.content.get<EvidenceInput[]>(evidenceKey);
    const body = { title: redactEmails(mission.title), intent: mission.intent, summary: redactEmails(agent.summary || mission.title), rationale: agent.rationale, baseCommit: mission.baseCommit, taskId: mission.id, files,
      ...(plan.dependsOn !== undefined ? { dependsOn: plan.dependsOn } : {}), ...(model ? { model } : {}), ...(run ? { agent: run } : {}), ...(plan.coAuthors ? { coAuthors: plan.coAuthors } : {}), ...(evidence ? { evidence } : {}) };
    const requestKey = `task-${idTail(mission.id, 40)}-${agent.id}-r${agent.revision ?? 1}`;
    try {
      const savedKey = `task-change:${requestKey}`;
      let saved = this.content.get<{ body: typeof body; changeId?: string; previousRevision?: number }>(savedKey);
      if (!saved) {
        saved = agent.change ? { body, changeId: agent.change.id, previousRevision: unwrap(await changeShardOf(this.env, key, shardOf(agent.change.id)!).get(agent.change.id)).revision } : { body };
        this.content.put(savedKey, saved);
      }
      const shard = saved.changeId ? shardOf(saved.changeId)! : submissionShard(`${actor.id}:${requestKey}`);
      const store = changeShardOf(this.env, key, shard);
      const context = { repository: key, shard, actor, system: true, checks: agent.checks };
      const { id, number, status, next } = unwrap(saved.changeId
        ? await store.revise(context, saved.changeId, { ...saved.body, previousRevision: saved.previousRevision }, requestKey)
        : await store.submit(context, saved.body, requestKey));
      this.content.delete(evidenceKey);
      agent.change = { id, number, status };
      this.event('change', `Opened pull request #${number}`, next ?? 'The repository rules decide when it merges.', mission.id, agent.id);
      return true;
    } catch (error) {
      if (error instanceof HttpError && plan.dependsOn !== undefined) throw error;
      logFailure('task_change_failed', error, { missionId: mission.id });
      this.event('error', 'The task result could not enter the landing queue', 'Review and merge it here, or retry after the queue recovers.', mission.id);
      return false;
    }
  }

  /** RPC from the change store when a task's change lands, is sent back, or is closed. */
  async taskChange(missionId: string, update: { id: string; number: number; status: ChangeStatus; commit?: string; reason?: string }) {
    const mission = this.data?.missions.find(candidate => candidate.id === missionId);
    const agent = mission?.agents.find(candidate => candidate.change?.id === update.id);
    if (!mission || !agent) return;
    agent.change = { id: update.id, number: update.number, status: update.status };
    if (update.status === 'landed' && update.commit && mission.status !== 'merged') {
      mission.status = 'merged'; mission.mergeCommit = update.commit; mission.mergedAt = now();
      for (const lane of includedAgents(mission)) lane.status = 'merged';
      this.event('merge', `Merged pull request #${update.number}`, `${update.commit.slice(0, 7)} · code and context merged together through the queue`, mission.id);
    } else if (update.status === 'closed' && mission.status === 'review') {
      mission.status = 'failed'; mission.error = `Change #${update.number} was closed${update.reason ? ` (${update.reason})` : ''}.`;
      this.event('error', `Change #${update.number} was closed`, mission.error, mission.id);
    } else if (update.status === 'revise' && mission.status === 'review') {
      this.event('error', `Pull request #${update.number} needs revision`, update.reason ?? 'Review the pull request and submit a revision.', mission.id, agent.id);
    }
    await this.save();
  }
  async integrateMission(missionId: string, operationId?: string) {
    try { return await this.executeIntegration(missionId, operationId); }
    catch (error) { throw new Error(error instanceof HttpError ? error.message : 'Integration could not complete. Check the current branch before retrying.'); }
  }
  private async executeIntegration(missionId: string, operationId?: string) {
    if (!await this.currentOperation(missionId, 'merge', operationId)) throw new Error('This integration request has been superseded.');
    const mission = this.mission(missionId);
    if (mission.status === 'merged') return { commit: mission.mergeCommit };
    if (mission.status !== 'merging') throw new Error('This mission is not queued for integration.');
    const input = await this.input(missionId);
    const authorization = await this.ctx.storage.get<Authorization>(`merge-authorization:${missionId}`) ?? input?.authorization;
    if (mission.source === 'live') await checkAuthorization(this.env, authorization);
    let plan = mission.source === 'live' ? await this.gitPlan<StagedMerge>(`merge-plan:${missionId}`) : undefined;
    if (plan?.preparedCommit) {
      using repo = await artifactsOf(this.env).get(this.data.project.id);
      const head = (await repo.log({ ref: this.data.project.branch, limit: 1 }))[0]?.hash;
      // A migration can change the review fingerprint after this exact commit
      // landed. Recover its original files and provenance before rebuilding a plan.
      if (head === plan.preparedCommit) return this.completeIntegration(mission, head, plan.files);
    }
    const check = mergeBlocker({ ...mission, status: 'review' }, this.data.project.head);
    if (check) throw new Error(check);
    const { files, preview } = await this.integrationFiles(mission, input?.context ?? null);
    let commit: string;
    if (mission.source === 'demo') {
      commit = hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(files))));
    } else {
      if (!plan || plan.fingerprint !== preview.fingerprint) {
        plan = { files: { ...files }, fingerprint: preview.fingerprint };
        this.saveGitPlan(`merge-plan:${missionId}`, plan);
      }
      // A retry uses the exact same ledger timestamps and reviewed tree.
      for (const path of Object.keys(files)) delete files[path];
      Object.assign(files, plan.files);
      using repo = await artifactsOf(this.env).get(this.data.project.id);
      const token = await repo.createToken('write', 900);
      try {
        commit = await (await gitWrites()).commitFiles({ repository: repo, remote: this.data.project.remote!, token: token.plaintext, branch: this.data.project.branch, expectedHead: mission.baseCommit, files, message: redactEmails(`Braid: ${mission.title}\n\nIntegrate ${plural(includedAgents(mission).length, 'proposal')} with ${plural(mission.collisions.length, 'human decision')}.\nContext: .braid/missions/${missionId}/decision.json`), preparedCommit: plan.preparedCommit,
          onPrepared: async preparedCommit => { await checkAuthorization(this.env, authorization); plan!.preparedCommit = preparedCommit; this.saveGitPlan(`merge-plan:${missionId}`, plan!); } });
      } finally { await repo.revokeToken(token.plaintext).catch(() => {}); } // A token left unrevoked expires in 15 minutes.
    }
    return this.completeIntegration(mission, commit, files);
  }
  /** What a reviewed task lands: the selected code plus its decision ledger and handoff under `.braid/missions/`. */
  private async integrationFiles(mission: Mission, constraints: ContextItem[] | null, options: { queue?: boolean } = {}) {
    mission = structuredClone(mission);
    const files = composeChanges(this.hydrateMission(mission));
    const decisions = this.data.context.filter(c => c.missionId === mission.id);
    const preview = await integrationPreview({ ...mission, status: 'review' }, this.data.project.head, constraints, options);
    const ledger = {
      mission: { id: mission.id, title: mission.title, intent: mission.intent, baseCommit: mission.baseCommit, source: mission.source, execution: mission.execution ?? 'cloud' },
      lanes: mission.agents.map(a => ({ agent: a.name, status: a.status, error: a.error, model: a.model, repo: a.repo, commit: a.commit, revision: a.revision, previousCommit: a.previousCommit, history: this.resultHistory(mission.id, a), summary: a.summary, rationale: a.rationale, checks: a.checks, paths: a.changes.map(c => c.path) })),
      reviewSelection: mission.reviewSelection,
      resolutions: mission.collisions, decisions, integratedAt: now(),
      constraints: constraints ?? [],
      integration: { fingerprint: preview.fingerprint, contextAvailable: preview.contextAvailable, totals: preview.totals,
        files: preview.files.map(({ change: _change, ...file }) => file), checks: preview.checks },
    };
    files[`.braid/missions/${mission.id}/decision.json`] = redactEmails(JSON.stringify(ledger, null, 2)) + '\n';
    files[`.braid/missions/${mission.id}/handoff.md`] = preview.handoff;
    for (const agent of mission.agents) files[agentContextPath(mission, agent)] = redactEmails(`# ${agent.name}\n\nStatus: ${agent.status}\n\n${agent.summary}\n\n## Rationale\n${agent.rationale}\n\nSource commit: ${agent.commit ?? 'not available'}\n`);
    return { files, preview, fileAuthors: await this.taskFileAuthors(mission) };
  }
  /** Keep each proposal's recorded identity when several agents become one pull request. */
  private async taskFileAuthors(mission: Mission) {
    const owner = (await this.input(mission.id))?.owner;
    const authors = Object.fromEntries(await Promise.all(mission.agents.map(async agent => {
      const plan = await this.gitPlan<StagedProposal>(`proposal:${mission.id}:${agent.id}`);
      const model = agent.model === LOCAL_MODEL ? undefined : agent.model;
      return [agent.id, { kind: 'agent' as const, id: `task-agent:${mission.id}:${agent.id}`, name: agent.name,
        ...(model ? { model } : {}), owner: plan?.owner ?? agent.owner ?? owner,
        ...(agent.tool ? { tool: agent.tool } : mission.source === 'live' && mission.execution === 'cloud' ? { tool: 'braid' } : {}), ...plan?.run }];
    })));
    const files = integrationAuthors(mission, authors);
    for (const agent of mission.agents) files[agentContextPath(mission, agent)] = authors[agent.id];
    for (const name of ['decision.json', 'handoff.md']) files[`.braid/missions/${mission.id}/${name}`] = { kind: 'bot', id: 'braid', name: 'Braid', tool: 'braid' };
    return files;
  }
  /** Whether results land through the repository's landing queue instead of a direct merge. */
  private async landsThroughQueue(): Promise<boolean> {
    const key = this.repositoryKey;
    if (!key || this.data?.capabilities.mode !== 'live') return false;
    return (await trunkOf(this.env, key).status(key)).enabled;
  }
  /**
   * With landing on, a reviewed task enters the queue as one change approved by
   * the person who landed it. The queue composes it with whatever reached main
   * since the agents started, runs the repository's checks and lands it like
   * any other change, so main has a single writer.
   */
  private async landThroughQueue(mission: Mission, reviewed: string | undefined, actor: string) {
    if (!reviewed) throw new HttpError(400, 'Open the integration preview before landing.');
    const link = await this.submitCombined(mission, { approvedBy: actor, fingerprint: reviewed });
    this.event('change', `Opened pull request #${link.number}`, `${actor} approved the combined result. It merges once it combines cleanly with main and passes the repository's checks.`, mission.id);
    return link;
  }
  /**
   * Submits a multi-agent task's combined result, with its decision ledger, as
   * one change. `approvedBy` names the owner who reviewed exactly this
   * composition (its fingerprint) and chose to land it; without it, the
   * repository's rules decide like any other change.
   */
  private async submitCombined(mission: Mission, options: { approvedBy?: string; fingerprint?: string } = {}) {
    const key = this.repositoryKey!;
    // Decisions stay frozen while the result is submitted, without persisting a transient state.
    if (this.submitting.has(mission.id)) throw new HttpError(409, 'This result is already being submitted.');
    this.submitting.add(mission.id);
    try {
      const input = await this.input(mission.id);
      const { files, preview, fileAuthors } = await this.integrationFiles(mission, input?.context ?? null, { queue: true });
      if (options.fingerprint && preview.fingerprint !== options.fingerprint) throw new HttpError(409, 'The integration changed after you reviewed it. Open the preview again before landing.');
      const agents = includedAgents(mission), { author, summary, rationale } = combinedResult(mission, input?.owner, options.approvedBy && personName(options.approvedBy));
      // The lanes' commits keep their co-author lines in the combined commit, once each.
      const plans = await Promise.all(agents.map(agent => this.gitPlan<StagedProposal>(`proposal:${mission.id}:${agent.id}`)));
      const coAuthors = [...new Set(plans.flatMap(plan => plan?.coAuthors ?? []))].slice(0, 5);
      const dependencies = plans.some(plan => plan?.dependsOn !== undefined) ? [...new Set(plans.flatMap(plan => plan?.dependsOn ?? []))] : undefined;
      const change = { title: redactEmails(mission.title), intent: mission.intent, baseCommit: mission.baseCommit, taskId: mission.id, summary: redactEmails(summary), rationale,
        files: editedFiles(files), ...(dependencies !== undefined ? { dependsOn: dependencies } : {}), ...(coAuthors.length ? { coAuthors } : {}) };
      const requestKey = `task-${idTail(mission.id, 40)}-${preview.fingerprint.slice(0, 32)}`;
      const shard = submissionShard(`${author.id}:${requestKey}`);
      const { id, number, status } = unwrap(await changeShardOf(this.env, key, shard).submit({ repository: key, shard, actor: author, system: true, fileAuthors, ...(options.approvedBy ? { approvedBy: options.approvedBy } : {}) }, change, requestKey));
      const link = { id, number, status };
      for (const agent of agents) agent.change = link;
      return link;
    } finally { this.submitting.delete(mission.id); }
  }
  private async completeIntegration(mission: Mission, commit: string, files: Record<string, GitFileEdit>) {
    for (const [path, edit] of Object.entries(files)) {
      const content = editContent(edit);
      if (content === null || content.length > 40_000) delete this.data.files[path];
      else this.data.files[path] = content;
    }
    this.data.project.head = commit;
    mission.status = 'merged'; mission.mergeCommit = commit; mission.mergedAt = now();
    for (const agent of includedAgents(mission)) agent.status = 'merged';
    this.event('merge', 'Braided into main', `${commit.slice(0, 7)} · code, context, and decisions preserved together`, mission.id);
    await this.save();
    this.warmSearch();
    return { commit };
  }
  /** RPC for the recorded example: what this visitor answered and landed. */
  async exampleState(): Promise<ExampleState> {
    let since = await this.ctx.storage.get<number>('example-since');
    if (!since) { since = Date.now(); await this.ctx.storage.put('example-since', since); }
    return { decisions: await this.ctx.storage.get<ExampleState['decisions']>('example-decisions') ?? {}, changes: await this.ctx.storage.get<ExampleChange[]>('example-changes') ?? [], since };
  }
  async recordExampleDecision(changeId: string, decision: DemoDecision): Promise<ExampleState> {
    const state = await this.exampleState();
    delete state.decisions[changeId];
    state.decisions[changeId] = decision;
    state.decisions = Object.fromEntries(Object.entries(state.decisions).slice(-100));
    await this.ctx.storage.put('example-decisions', state.decisions);
    return state;
  }
  /**
   * The recorded example lands a task the way a repository with landing on
   * does: its combined result becomes one change, approved by the visitor, that
   * moves through the example's queue and lands within seconds. No checks run,
   * and the landed change says so.
   */
  private async landExample(mission: Mission, reviewed: string | undefined) {
    const input = await this.input(mission.id);
    const { files, preview, fileAuthors } = await this.integrationFiles(mission, input?.context ?? null, { queue: true });
    if (reviewed && reviewed !== preview.fingerprint) throw new HttpError(409, 'The integration changed after you reviewed it. Open the preview again before landing.');
    const state = await this.exampleState();
    const number = (await recordedExample()).nextNumber(state), at = Date.now(), iso = new Date(at).toISOString();
    const agents = includedAgents(mission), { author, summary, rationale } = combinedResult(mission, input?.owner, 'you');
    const diffs: ExampleChange['diffs'] = {};
    const changed: Change['files'] = [];
    for (const [path, edit] of Object.entries(files)) {
      const after = editContent(edit), before = this.data.files[path] ?? null;
      if (before === after) continue;
      diffs[path] = { before, after };
      changed.push({ path, ...textDiffStats(before ?? '', after ?? ''), ...(before === null ? { added: true as const } : {}), ...(after === null ? { deleted: true as const } : {}), beforeHash: null, afterHash: null });
    }
    const change: Change = {
      id: `ch_example_${idTail(mission.id, 24)}`, number, title: mission.title, status: 'queued', revision: 1, taskId: mission.id,
      author, intent: mission.intent, baseCommit: mission.baseCommit, summary, rationale,
      files: changed, additions: changed.reduce((sum, file) => sum + file.additions, 0), deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
      reviews: [], checks: [], conflicts: [], overlaps: [], createdAt: iso, updatedAt: iso,
      events: [
        { at: iso, type: 'submitted', message: `${author.name} submitted ${plural(changed.length, 'file')} through their task.`, actor: author.name },
        { at: iso, type: 'approved', message: 'You approved these changes in their agent task.', actor: 'You' },
      ],
    };
    state.changes = [...state.changes, { change, diffs, at, missionId: mission.id, fileAuthors }].slice(-20);
    await this.ctx.storage.put('example-changes', state.changes);
    const link = { id: change.id, number, status: 'queued' as const };
    for (const agent of agents) agent.change = link;
    this.event('change', `Opened pull request #${number}`, 'You approved the combined result. In the recorded example it merges within seconds, and no checks run.', mission.id);
    return link;
  }
  /**
   * Brings the example's main up to what the visitor's work has landed: each
   * landing's files are merged into main three-way, as the queue would, and
   * a landed task completes.
   */
  private async settleExample() {
    const applied = new Set(await this.ctx.storage.get<string[]>('example-applied') ?? []);
    const landings = (await recordedExample()).landings(await this.exampleState()).filter(landing => !applied.has(landing.id));
    if (!landings.length) return;
    for (const landing of landings) {
      for (const [path, diff] of Object.entries(landing.diffs)) {
        const current = this.data.files[path];
        if (diff.after === null) { if (current === undefined || current === diff.before) delete this.data.files[path]; continue; }
        if (current === undefined || current === diff.before) { this.data.files[path] = diff.after; continue; }
        const merged = mergeFile(path, diff.before ?? '', current, diff.after);
        if (merged.clean) this.data.files[path] = merged.text;
      }
      this.data.project.head = landing.commit;
      applied.add(landing.id);
      const mission = landing.missionId ? this.data.missions.find(item => item.id === landing.missionId) : undefined;
      if (mission && mission.status !== 'merged') {
        mission.status = 'merged'; mission.mergeCommit = landing.commit; mission.mergedAt = new Date(landing.landedAt).toISOString();
        for (const agent of includedAgents(mission)) { agent.status = 'merged'; if (agent.change) agent.change = { ...agent.change, status: 'landed' }; }
        this.event('merge', `Merged pull request #${landing.number}`, `${landing.commit.slice(0, 7)} · code and context merged together`, mission.id);
      } else this.event('merge', `Landed #${landing.number}`, landing.title, undefined);
    }
    await this.ctx.storage.put('example-applied', [...applied]);
    await this.save();
  }
  /** Internal migration/discovery metadata. Never includes credentials, URLs or account identities. */
  async publicationMetadata(): Promise<{ sourcePublic?: boolean; description: string; updatedAt?: string }> {
    const source = await this.ctx.storage.get<{ public: boolean }>('repository-source');
    const pending = await this.ctx.storage.get<PendingProject>('pending-project');
    const sourcePublic = source?.public ?? (this.data?.project.id && this.data.project.id === pending?.name && pending.sourceUrl
      ? pending.sourcePublic ?? (!pending.github && !!pending.sourceUrl) : undefined);
    const updatedAt = this.data?.activity.map(item => item.timestamp).sort().at(-1);
    return { ...(sourcePublic === undefined ? {} : { sourcePublic }), description: this.data?.project.description ?? '', ...(updatedAt ? { updatedAt } : {}) };
  }
  private warmSearch(view?: { repository: string; address: string }) {
    const { id, branch, head } = this.data.project;
    if (this.data.capabilities.mode !== 'live' || !id || !head) return;
    // Imports may still be copying the parents of their shallow tip. Warm once that copy finishes;
    // existing repositories also reach this hook on a member's first root-tree read.
    const key = this.repositoryKey;
    if (key && !this.data.branchCopy) this.ctx.waitUntil(Promise.resolve().then(() => trunkOf(this.env, key)
      .warmBlame(key, head)).catch(error => logFailure('blame_prebuild_failed', error, { repository: id })));
    this.ctx.waitUntil(import('../repositories/search-warm')
      .then(({ warmRepositorySearch }) => warmRepositorySearch(this, this.ctx.storage, this.env, { id, branch, head }, view))
      .catch(error => logFailure('search_prebuild_failed', error, { repository: id })));
  }
  /** What readers name that Artifacts cannot read: the default branch at its recorded head, and Braid's notes at the commit the trunk knows. */
  private names() {
    const key = this.repositoryKey;
    return { branch: this.data.project.branch, head: this.data.project.head, ...(key ? { notes: () => trunkOf(this.env, key).notesHead(key) } : {}) };
  }
  private revisionScope(key: string, network?: string): RevisionScope | null {
    const project = this.data?.capabilities.mode === 'live' ? this.data.project : undefined;
    return project?.id ? { env: this.env, key, project: { id: project.id, branch: project.branch, head: project.head, remote: project.remote, branches: project.branches }, network } : null;
  }
  /** RPC for public Git fetches: whether every commit a fetch wants is published. */
  async publicCommits(key: string, hashes: string[], network?: string): Promise<boolean> {
    const scope = this.revisionScope(key, network);
    return !!scope && this.revisions.published(hashes, scope);
  }
  /** RPC for the change store and landing queue: the live repository they serve, or null. */
  async repository(): Promise<{ id: string; branch: string; remote: string; head: string } | null> {
    if (!this.data || this.data.capabilities.mode !== 'live' || !this.data.project.id || !this.data.project.remote) return null;
    return { id: this.data.project.id, branch: this.data.project.branch, remote: this.data.project.remote, head: this.data.project.head };
  }
  /** RPC from the landing queue after a batch lands; consecutive landings share one activity entry. */
  async trunkAdvanced(head: string, batch: { batchId: string; landed: number; ejected: number; synced?: boolean }) {
    if (!this.data || this.data.capabilities.mode !== 'live') return;
    this.data.project.head = head;
    this.warmSearch();
    if (batch.synced) {
      this.event('merge', 'Synced from GitHub', `${head.slice(0, 7)} is the new head of ${this.data.project.branch}.`);
      await this.save();
      return;
    }
    const latest = this.data.activity[0];
    const recent = latest?.landed !== undefined && Date.now() - Date.parse(latest.timestamp) < 60_000 ? latest : undefined;
    const landed = batch.landed + (recent?.landed ?? 0);
    const message = `Landed ${plural(landed, 'change')} through the queue`;
    const detail = `${head.slice(0, 7)} is the new head of ${this.data.project.branch}.`;
    if (recent) Object.assign(recent, { message, detail, landed });
    else { this.event('merge', message, detail); this.data.activity[0].landed = landed; }
    await this.save();
  }
  async failMerge(missionId: string, message: string, operationId?: string) {
    if (!await this.currentOperation(missionId, 'merge', operationId)) return;
    const mission = this.mission(missionId); if (mission.status === 'merged') return;
    mission.status = 'review'; mission.error = message.slice(0, 1000);
    this.event('error', 'Integration needs attention', mission.error, missionId); await this.save();
  }
}
