import type { ProviderId } from './providers';
import type { AgentActivityEvent } from './agent-activity';
export type AgentStatus = 'queued' | 'forking' | 'working' | 'review' | 'merged' | 'failed' | 'skipped';
type MissionStatus = 'draft' | 'running' | 'review' | 'merging' | 'merged' | 'failed';
type CheckStatus = 'passed' | 'warning' | 'failed';
export type ExecutionMode = 'cloud' | 'local';
export type AgentFailureStage = 'authorization' | 'fork' | 'generation' | 'validation' | 'publish';
/** Evidence from the runtime, never a classification of command/provider prose. */
export type HostedFailureCause = 'container_start' | 'image_pull' | 'out_of_memory' | 'process_killed' | 'disk_full' | 'install_failed' | 'network' | 'timeout' | 'provider' | 'collection' | 'workflow_step' | 'preflight' | 'command' | 'interrupted';
export interface HostedFailure {
  cause: HostedFailureCause;
  phase: 'preflight' | 'start' | 'checkout' | 'setup' | 'model' | 'command' | 'collection' | 'workflow';
  message: string; action: 'retry' | 'more_time' | 'edit_setup'; retryable: boolean;
  evidence: { source: 'container' | 'process' | 'workers_ai' | 'provider' | 'collector' | 'workflow' | 'repository';
    operation: string; exitCode?: number; signal?: number; code?: string; status?: number; providerCode?: number;
    retryAfterMs?: number; limitKind?: 'command' | 'task' | 'model' | 'transport'; timeoutMs?: number; elapsedMs?: number; timedOut?: boolean; oomKilled?: boolean; diskAvailableBytes?: number; truncated?: boolean; step?: string; reason?: string };
  output: string; at: string;
}
export interface HostedPreflight {
  commit: string; setup?: string; checks: string[];
  runtimes: { name: 'Node' | 'Python' | 'Go'; version: string; path: string }[];
  lockfiles: string[]; missing: string[];
}
/** What one report of a hosted run says; the next report replaces it. */
interface HostedState {
  status: 'preflight' | 'running' | 'retrying' | 'failed' | 'completed';
  failure?: HostedFailure;
  retry?: { attempt: number; limit: number; nextAt: string };
}
/** What stays true for the rest of a hosted run once a report has said it. */
export interface HostedFacts {
  preflight?: HostedPreflight;
  /** Kept after recovery, so a successful run still explains its retry. */
  recovered?: { cause: HostedFailureCause; attempts: number };
  /** The commands the agent ran to prepare the repository, as it ran them. */
  prepared?: { command: string; status: 'passed' | 'failed' }[];
}
export type HostedEnvironment = HostedState & HostedFacts;
/** `fleet` lets an orchestrator mint a separate identity for each agent it runs under one owner approval. */
/** Account grants follow current membership; repository IDs keep existing grants restricted. */
export const ACCOUNT_ACCESS = '*';
export type AgentScope = 'read' | 'setup' | 'work' | 'fleet';
/**
 * An MCP client's OAuth request as its consent page shows it: the name the client gives itself, where the browser
 * returns (a web host, this computer, or an app's own scheme), the host of its metadata document when it has one, and
 * the access it asks for. A request that cannot be shown answers `{ redirect }` instead, back to the client.
 */
export interface OAuthRequestView {
  client: { name: string; redirect: { kind: 'web' | 'loopback' | 'app'; host: string }; document: string | null };
  scope: 'read' | 'work';
}
export interface LocalTestReport { command: string; result: 'passed' | 'failed' | 'not-run'; detail?: string }
export interface FileChange { withheld?: boolean; path: string; before: string; after: string; additions: number; deletions: number; contentRef?: string; beforeHash?: string; afterHash?: string; deleted?: true; mode?: '100644' | '100755' }
export interface AgentCheck {
  label: string; status: CheckStatus; detail: string;
  /**
   * What a check Braid writes stands for; an agent's own checks have none. `local` notes that a local agent did the
   * work, `report` is a test result it reported and `run` a command it ran on its own machine.
   */
  kind?: 'proposals' | 'decisions' | 'base' | 'patch' | 'runtime' | 'local' | 'report' | 'run';
}
export interface Agent {
  id: string; name: string; role: string; color: string; status: AgentStatus;
  task: string; scope: string[]; repo?: string; remote?: string; commit?: string;
  summary: string; rationale: string; checks: AgentCheck[]; changes: FileChange[];
  startedAt?: string; completedAt?: string; error?: string; model?: string; failureStage?: AgentFailureStage;
  /** A hosted agent running on its starter's own provider key rather than Workers AI. */
  provider?: ProviderId;
  /** A selected work connection is the only connection allowed to claim this agent. */
  connection?: { id: string; label: string };
  owner?: ProvenanceOwner;
  tool?: string;
  progress?: { message: string; updatedAt: string };
  environment?: HostedEnvironment;
  hostedActivity?: AgentActivityEvent[];
  revision?: number; previousCommit?: string;
  /** The change this lane's result became when the repository lands through the queue. */
  change?: { id: string; number: number; status: ChangeStatus };
}
export interface Collision {
  id: string; path: string; agentIds: string[];
  /** `reason` is the person's own words, present only when they gave one. */
  resolution?: { agentId: string; reason?: string; resolvedAt: string };
}
export interface Mission {
  withheld?: boolean;
  id: string; title: string; intent: string; status: MissionStatus;
  createdAt: string; baseCommit: string; agents: Agent[]; collisions: Collision[];
  source: 'demo' | 'live'; execution: ExecutionMode; mergeCommit?: string; mergedAt?: string; error?: string;
  reviewSelection?: { agentIds: string[]; actor: string; selectedAt: string };
  timeBudgetMinutes?: number;
  /** Its owner stopped this local task, so it failed by their choice. */
  cancelled?: true;
}
export interface ContextItem {
  id: string; title: string; body: string; kind: 'constraint' | 'decision' | 'learning';
  author: string; createdAt: string; missionId?: string;
}
export interface Activity {
  id: string; type: 'fork' | 'thinking' | 'change' | 'conflict' | 'resolution' | 'merge' | 'context' | 'error';
  message: string; detail?: string; timestamp: string; agentId?: string; missionId?: string;
  /** How many changes a queue landing entry counts; consecutive landings share one entry. */
  landed?: number;
}
export interface Project {
  id: string; name: string; description: string; remote?: string;
  branch: string; head: string; stack: string[];
  /** Every branch of an imported repository, the default first, as they arrive. */
  branches?: string[];
}
export interface Capabilities {
  mode: 'demo' | 'live'; artifacts: boolean; ai: boolean; storage: 'durable-object';
  authenticated: boolean; model: string; namespace: string;
  /** Whether this viewer may change the repository; the gateway sets it for each request. */
  canWrite: boolean;
  identity?: { id: string; email?: string; role: 'owner' | 'viewer'; provider: 'owner-key' | 'cloudflare-access' | 'github' };
}
/**
 * One file of a change: main's version against the revision's, or with `since`
 * an earlier revision's against this one. `before` is null for a file the
 * change adds and `after` for one it deletes. Both are null only when `withheld` is true.
 */
export type ChangeDiff = { path: string; revision: number; since?: number; binary: boolean } & ({ before: string; after: string | null; withheld?: false } | { before: null; after: string; withheld?: false } | { before: null; after: null; withheld: true });
/** The files that differ between an earlier revision of a change and a later one, with their line counts. */
export interface ChangeComparison { withheld?: true; revision: number; since: number; files: Pick<ChangeFile, 'path' | 'additions' | 'deletions' | 'added' | 'deleted'>[] }
export interface WorkspaceSnapshot {
  project: Project; missions: Mission[]; context: ContextItem[]; activity: Activity[];
  files: Record<string, string>; capabilities: Capabilities;
  /** An import still copying, for the repository's members: where from, since when, and why it stopped if it did. */
  importing?: ProjectImport;
  /** An import's other branches still being copied after its default branch opened; null until the source is read. */
  branchCopy?: { remaining: number | null };
}
/**
 * A repository's code still arriving: the source as people read it ('owner/repo' for GitHub, the URL otherwise), the
 * branch being copied once known, and `preview` when its files can be read from the source meanwhile.
 */
export interface ProjectImport { name: string; source: string; startedAt: string; branch?: string; preview?: boolean; error?: string; code?: 'mirror_too_large' }
export interface CreateMissionInput { title: string; intent: string; execution?: ExecutionMode; agentCount?: 1 | 2 | 3; connectionIds?: string[]; timeBudgetMinutes?: number }

export interface IntegrationFile {
  path: string;
  disposition: 'independent' | 'agreement' | 'selected' | 'unresolved';
  change: FileChange | null;
  versions: { agentId: string; agentName: string; commit?: string; selected: boolean; additions: number; deletions: number }[];
  reason?: string;
}
export interface IntegrationPreview {
  missionId: string; title: string; source: 'demo' | 'live';
  status: MissionStatus; baseCommit: string; headCommit: string; mergeCommit?: string;
  fingerprint: string; ready: boolean; blocker: string | null;
  files: IntegrationFile[];
  totals: { files: number; independent: number; agreements: number; selected: number; unresolved: number; additions: number; deletions: number };
  checks: AgentCheck[];
  constraints: ContextItem[]; contextAvailable: boolean;
  handoff: string;
}

/* ---------- Changes, policy and the landing queue ---------- */

/**
 * A change is the unit that lands on trunk, Braid's equivalent of a pull request.
 * `open`: policy is being evaluated. `revise`: the author must submit a new
 * revision (conflict, failed check or requested changes). `attention`: a person
 * must decide. `queued` and `landing`: approved and moving through the queue.
 */
export type ChangeStatus = 'open' | 'revise' | 'attention' | 'queued' | 'landing' | 'landed' | 'closed';
export type ChangeCloseReason = 'abandoned' | 'superseded' | 'rejected';
export type Autonomy = 'auto' | 'review' | 'human';
type Risk = 'low' | 'medium' | 'high';
export type MergeConflictKind = 'content' | 'add-add' | 'modify-delete' | 'delete-modify' | 'binary' | 'mode' | 'type';
export type LandingStrategy = 'fast-forward' | 'line' | 'union' | 'json' | 'already-applied';
export interface ChangeAuthor {
  kind: 'agent' | 'human' | 'bot' | 'github' | 'simulated';
  /** Stable identity: an agent connection, fleet member, person or GitHub login. */
  id: string; name: string; model?: string; fleet?: string;
  /** The person whose agent this is: who approved its connection. */
  owner?: ProvenanceOwner;
  /** The coding tool and its version, such as `claude-code/2.4.1`, and the run that made the change. */
  tool?: string; session?: string;
  /** The orchestrator's run, when one agent started another. */
  parentSession?: string;
}
export interface ProvenanceOwner { id?: string; publicId?: string; name: string; email?: string; github?: string }
/** Repository-private feedback from an authenticated agent. All text is displayed literally. */
export interface AgentReport {
  id: string; summary: string; details?: string; tool?: string; pullRequest?: number; createdAt: string;
  agent: { connection: string; name: string; model?: string; owner: Pick<ProvenanceOwner, 'name' | 'publicId' | 'github'> };
}
export interface AgentReports { items: AgentReport[]; canResolve: boolean }
/**
 * Who made a commit. `braid` means Braid saw an authenticated agent submit it, `trailers` that the commit says so in
 * its Agent-* trailers, and `inferred` that it was read from signs other tools leave: bot authors, Co-authored-by
 * lines or generated-with notes. A human commit has no agent.
 */
export interface Provenance {
  commit: string; at: string; subject: string;
  kind: 'agent' | 'human' | 'bot';
  agent?: { id?: string; name: string; model?: string; tool?: string; fleet?: string; session?: string; parentSession?: string };
  owner?: ProvenanceOwner;
  change?: { id: string; number: number };
  task?: { id: string; title?: string };
  confidence: 'braid' | 'trailers' | 'inferred';
  /** A combined task commit keeps its byline; each path names the proposal whose content landed. */
  files?: Record<string, Pick<Provenance, 'kind' | 'agent' | 'owner'>>;
}
/** Lines `start` to `start + lines - 1` (1-based) of a file as of a commit, and who last changed them. */
export interface BlameRange { start: number; lines: number; provenance: Provenance }
/** A note explains coarse attribution; `pending` means the open view should follow the background line history. */
export interface FileBlame { path: string; ref: string; lines: number; ranges: BlameRange[]; note?: string; pending?: boolean }
/**
 * One agent's record on a repository, for the fleet roster. Simulated agents stay labelled here too. `authors` are the
 * change author ids a record groups, which the server always sends; it is optional only so that clients parsing older
 * answers still accept them.
 */
export interface AgentRecord {
  id: string; name: string; owner?: ProvenanceOwner; models: string[]; tools: string[]; fleet?: string; simulated?: true; authors?: string[];
  changes: { landed: number; sentBack: number; reverted: number; open: number };
  /** Lines it added that landed, and how many of them are still on main. */
  lines: { added: number; alive: number };
  firstActive: string; lastActive: string;
}
export interface ChangeFile {
  path: string; additions: number; deletions: number;
  added?: true; deleted?: true; mode?: '100644' | '100755';
  beforeHash: string | null; afterHash: string | null;
}
export interface ChangeReview {
  /** The authenticated person or agent who wrote this review. */
  author?: ChangeAuthor;
  id: string; revision: number; reviewer: string; kind: 'agent' | 'human';
  /** `comment` records feedback that neither approves nor blocks, such as a GitHub review app that only commented. */
  verdict: 'approve' | 'revise' | 'escalate' | 'reject' | 'comment';
  risk?: Risk; summary: string; createdAt: string; model?: string;
  findings: { path?: string; line?: number; severity: 'info' | 'warning' | 'error'; message: string }[];
}
/** `ci` is a status reported by the repository's own CI through Braid's merge_group webhook. */
export interface ChangeCheck {
  revision: number; label: string; status: CheckStatus; detail: string; source: 'braid' | 'agent' | 'github' | 'ci';
  /** What a check Braid writes stands for, as on a task's checks; `dependencies` is Braid's dependency review. */
  kind?: NonNullable<AgentCheck['kind']> | 'dependencies';
  /** A command Braid ran in its sandbox: the combined result it ran on, its exit code and how long it took. */
  run?: { commit: string; exitCode: number; seconds: number };
}
/** Where evidence ran: `braid` in Braid's sandbox, `agent` on the agent's machine, which is reported and never verified. */
export type EvidenceSource = 'braid' | 'agent';
/** A page the change was seen rendering at one viewport; `image` is served from `/api/changes/:id/evidence/:image`. */
export interface ScreenshotEvidence { kind: 'screenshot'; revision: number; page: string; viewport: 'desktop' | 'mobile'; image: string; width: number; height: number; source: EvidenceSource; at: string }
/** A command run against the change, how it ended and the end of what it printed. */
export interface CommandEvidence { kind: 'command'; revision: number; command: string; exitCode: number; output: string; durationMs?: number; source: EvidenceSource; at: string }
/** What a change was shown doing, so a person can judge the result without reading the diff. */
export type Evidence = ScreenshotEvidence | CommandEvidence;
/** Evidence as an agent submits it with a revision; screenshots are base64 images. */
export type EvidenceInput =
  | { kind: 'screenshot'; page: string; viewport: 'desktop' | 'mobile'; width: number; height: number; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
  | { kind: 'command'; command: string; exitCode: number; output: string; durationMs?: number };
/**
 * A rule every agent follows. Instructions live in the repository's `.braid/instructions.json`, are mirrored into a
 * section of AGENTS.md that every coding tool reads, and are checked on every change: adding one of the `block`
 * strings in a file matching `paths` (all files when absent) sends the change back citing the instruction.
 */
export interface Instruction { id: string; text: string; block?: string[]; paths?: string[] }
export interface ChangeConflictRegion { baseStart: number; oursStart: number; theirsStart: number; base: string[]; ours: string[]; theirs: string[] }
export interface ChangeConflict { path: string; kind: MergeConflictKind; regions?: ChangeConflictRegion[]; jsonPaths?: string[] }
export interface PolicyRequirement { id: 'policy' | 'protected' | 'size' | 'reviews' | 'human' | 'checks' | 'risk' | 'guard' | 'rounds' | 'trust' | 'duplicate'; label: string; satisfied: boolean; detail: string }
export interface PolicyDecision {
  autonomy: Autonomy; reviewers: number; requirements: PolicyRequirement[];
  /** Rules that matched this change's paths, by index in the policy file. */
  rules: number[];
  /** Paths agents may not change; such a change cannot land. */
  protected: string[];
}
export interface ChangeEvent {
  at: string; type: 'submitted' | 'revised' | 'reviewed' | 'approved' | 'queued' | 'conflict' | 'landed' | 'closed' | 'checks' | 'escalated' | 'overlap' | 'reverted'; message: string; actor?: string;
  /** A possible-duplicate warning, or the hold it led to: the open pull requests whose intent matched. */
  duplicates?: { number: number; title: string }[];
  /** An escalation by policy: the requirement that handed the change to a person. */
  requirement?: PolicyRequirement['id'];
  /** A push: the revision it made and the main commit it is based on. */
  revision?: number; base?: string;
}
export interface ChangeOverlap { changeId: string; number: number; title: string; status: ChangeStatus; paths: string[] }
export interface ChangeReference { id: string; number: number; status: ChangeStatus }
export interface PullRequestContext extends ChangeReference { next?: string; dependsOn?: ChangeReference[]; waitingOn?: ChangeReference[]; outdated?: ChangeReference[] }
export interface ChangeSummary {
  /** Dependencies and their reverse links, within this repository. Waiting pull requests are not queued. */
  dependsOn?: ChangeReference[];
  requiredBy?: ChangeReference[];
  waitingOn?: ChangeReference[];
  /** Prerequisites revised since this revision was built. */
  outdated?: ChangeReference[];
  /** Position in the connected stack's deterministic dependency order. */
  stack?: { position: number; total: number };
  /** Conversation and line comments, including replies. */
  commentCount?: number;
  id: string; number: number; title: string; status: ChangeStatus; closeReason?: ChangeCloseReason;
  author: ChangeAuthor; risk?: Risk; autonomy?: Autonomy; revision: number;
  files: number; additions: number; deletions: number;
  taskId?: string; landedCommit?: string; createdAt: string; updatedAt: string;
  /** The submitted Git head, when known from a push, for links from branches and comparisons. */
  headCommit?: string;
  /** One line for queues and inboxes: what needs to happen next, if anything. */
  next?: string;
  /** A two- or three-word tag for lists when it needs a person or was sent back, such as "Secret found" or "Conflicts". */
  label?: string;
  /** The current version's checks in one state, like the mark beside a pull request on GitHub; absent when none ran. */
  checkState?: 'passed' | 'failed' | 'pending';
}
export interface Change extends Omit<ChangeSummary, 'files'> {
  /** Review conversations arrive with the change, oldest first. */
  comments?: ChangeComment[];
  intent: string; summary: string; rationale: string;
  baseCommit: string; files: ChangeFile[];
  policy?: PolicyDecision; reviews: ChangeReview[]; checks: ChangeCheck[];
  conflicts: ChangeConflict[]; conflictBase?: string;
  /** What sent it back to its author, while it is there; `next` says it in words. */
  sentBack?: 'conflicts' | 'review' | 'checks' | 'guard' | 'restack';
  /** Deterministic findings such as deleted or skipped tests, dependency downgrades and broken instructions. */
  guards?: { kind: 'tests' | 'dependencies' | 'secrets' | 'instructions'; path: string; detail: string }[];
  /** Screenshots and command runs for every revision, newest last. */
  evidence?: Evidence[];
  /** Active changes whose stated intent is nearly the same, found by comparing intent embeddings. */
  duplicates?: { changeId: string; number: number; title: string; similarity: number }[];
  overlaps: ChangeOverlap[];
  strategies?: Record<string, LandingStrategy>;
  batchId?: string; landedAt?: string;
  /** The commit main was at just before this change landed; reverting restores its files to that version. */
  landedParent?: string;
  /** The change that reverts this one, and for a revert, the change it undoes. */
  revertedBy?: { id: string; number: number };
  revertOf?: { id: string; number: number };
  github?: { pullNumber?: number; url?: string; headSha?: string };
  events: ChangeEvent[];
}
/** An original line location remains stable; position follows unchanged lines in the current revision. */
export interface CommentAnchor {
  path: string; line: number; side: 'LEFT' | 'RIGHT'; revision: number;
  position: number | null; outdated: boolean;
}
/** Replies name the root comment. Resolution belongs to the root, including when its line is outdated. */
export interface ChangeComment {
  id: string; body: string; author: ChangeAuthor; createdAt: string; revision: number;
  inReplyTo?: string; anchor?: CommentAnchor;
  resolved?: boolean; resolvedBy?: { author: ChangeAuthor }; resolvedAt?: string;
}
export interface SubmitChangeInput {
  /** Up to 16 pull request numbers or change ids; omitted on revision retains the dependencies, [] clears them. */
  dependsOn?: (number | string)[];
  title: string; intent?: string; summary: string; rationale?: string;
  baseCommit: string; taskId?: string; model?: string;
  files: { path: string; content: string | null; mode?: '100644' | '100755' }[];
  tests?: LocalTestReport[];
  /** At most 12 screenshots of at most 600 KB each and 4 MB together, and 10 commands with at most 8,000 characters of output. */
  evidence?: EvidenceInput[];
}
export interface BatchSummary {
  id: string; status: 'composing' | 'verifying' | 'pushing' | 'landed' | 'failed';
  base: string; head?: string; startedAt: string; finishedAt?: string;
  landed: { changeId: string; number: number; commit?: string }[];
  ejected: { changeId: string; number: number; reason: string }[];
  strategies: Partial<Record<LandingStrategy, number>>;
  /** Why a batch did not land, or how it was retried. */
  note?: string;
  /** The pull requests a failed batch put back in the queue. */
  requeued?: { changeId: string; number: number }[];
}
/** How a repository relates to GitHub: Braid lands through pull requests there, or mirrors its trunk to it. */
export interface GitHubLinkStatus {
  fullName: string; defaultBranch: string; mode: 'pull-requests' | 'mirror';
  status: 'synced' | 'behind' | 'diverged' | 'error';
  linkedBy: string; linkedAt: string; checkedAt?: string; message?: string; mirroredHead?: string;
}
/** What the repository's own CI reported for a batch, by status context; `required` are the ones the rules wait for. */
export interface BatchCi { required: string[]; statuses: Record<string, { state: 'pending' | 'success' | 'failure' | 'error'; description?: string; url?: string; at: string }> }
interface QueueChange { changeId: string; number: number; title: string }
interface LandingBatch extends BatchSummary {
  changes?: QueueChange[];
  checks?: { command: string; status: 'pending' | 'passed' | 'failed' | 'error' }[];
  pullRequest?: { number: number; url: string; state: string; reason: string };
  ci?: BatchCi;
}
export interface TrunkStatus {
  /** Active pull request stacks, in dependency order, including prerequisites already merged. */
  stacks?: ChangeReference[][];
  nextStackCursor?: number | null;
  branch: string; head: string; enabled: boolean; paused?: string;
  /** Changes in the queue, including those merging now; `merging` lists the ones in batches, front first, and `waiting` counts the rest. */
  queued: number; waiting: number; merging: QueueChange[]; landing?: LandingBatch;
  /** The first 100 waiting changes in queue order, excluding batches already in flight. */
  waitingEntries?: QueueChange[]; waitingEntriesTruncated?: boolean;
  /** Every batch being verified, front first; each was composed on the one ahead of it. */
  verifying?: LandingBatch[];
  recent: BatchSummary[];
  github?: GitHubLinkStatus;
  /** Totals over the retained batch history, used for throughput and automatic-merge rates. */
  stats: { landed: number; ejected: number; batches: number; strategies: Partial<Record<LandingStrategy, number>>; since: string };
}
export interface HotPath { path: string; active: number; changes: { changeId: string; number: number; status: ChangeStatus; author: string }[] }
export interface ChangeCounts { open: number; revise: number; attention: number; queued: number; landing: number; landed: number; closed: number }
export interface ChangePage { items: ChangeSummary[]; nextCursor: string | null; counts: ChangeCounts }
export type SwarmScenario = 'mixed' | 'hotspot' | 'disjoint';
/** A simulated-agent run. The edits are synthetic; review, policy, merging and landing are the real system. */
export interface SwarmRun {
  id: string; repository: string; scenario: SwarmScenario; agents: number; seed: number;
  startedAt: string; startedBy: string; preparedAt?: string; finishedAt?: string;
  status: 'preparing' | 'running' | 'finished' | 'stopped';
  launched: number; revisions: number; counts: ChangeCounts; failures?: number; note?: string;
  setup?: { changeId: string; shard: number; revision: number };
}

/* ---------- Guided review ---------- */

export type { ChangeGuide, GuideChapter, GuideHunk } from './guide';
