import type { ProviderId } from '../../shared/providers';
import type {
  AgentRecord,
  AgentReports,
  ChangeComparison,
  ChangeDiff,
  ChangeGuide,
  Change,
  ChangeCloseReason,
  ChangePage,
  ChangeStatus,
  ContextItem,
  CreateMissionInput,
  ExecutionMode,
  FileBlame,
  FileChange,
  GitHubLinkStatus,
  Instruction,
  IntegrationPreview,
  Mission,
  Project,
  ProjectImport,
  SwarmRun,
  SwarmScenario,
  TrunkStatus,
  WorkspaceSnapshot,
} from '../../shared/types';
import type { Policy } from '../../shared/policy';
import type { GitHubConnection, GitHubInstallation, GitHubPage, GitHubRepository, GitHubRepositorySelection } from '../../shared/github';
import type { RepositoryFile, RepositoryTree } from '../../shared/repository';
import type { RepositoryBranches, RepositoryComparison, RepositoryDiff } from '../../shared/compare';
import type { CommitDetail, CommitDiff, CommitPage } from '../../shared/history';
import type { RepositorySearch } from '../../shared/search';
import type { LocalActivityPage } from '../../shared/agent-activity';
import { clockTime } from './format';
import { followOwnWrite, setPublicPolling } from './polling';
import { EXAMPLE_SESSION_LIMIT } from '../../shared/errors';

/** Error raised for any failed request. `status` is 0 when the network itself failed. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string, public retryAt = 0, public code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// A network budget applies across endpoints. Refused example writes never pause reads.
let rateLimit: ApiError | null = null;
export const retryDelay = () => Math.max(0, (rateLimit?.retryAt ?? 0) - Date.now());

export interface CreateProjectInput {
  name: string;
  template?: 'blank';
  description?: string;
  sourceUrl?: string;
  github?: GitHubRepositorySelection;
}

interface ResolveInput {
  collisionId: string;
  agentId: string;
  /** Worth keeping when given; choosing does not require one. */
  reason?: string;
}

/** What landing a task answers: the task, and the change it became when the repository lands through the queue. */
interface MergeResult {
  missionId: string;
  change?: { id: string; number: number; status: ChangeStatus };
}

/** A task note, or with `missionId` an instruction to one running task, which the key keeps from being sent twice. */
type ContextInput = { title: string; body: string; kind: 'constraint' | 'learning'; missionId?: string };

/** Number of independently proposed approaches. The task dialog defaults to one. */
export type AgentCount = 1 | 2 | 3;

/** A new task as the dialog sends it: the person's execution choice is always explicit. */
export type MissionInput = CreateMissionInput & { execution: ExecutionMode; agentCount?: AgentCount; provider?: HostedRunner };
/** What Braid's hosted agents run on: Workers AI, or a provider the person connected with their own key. */
export type HostedRunner = 'workers-ai' | ProviderId;

interface RequestOptions extends RequestInit {
  /** Marks a write the server applies at most once. Resending with the same key returns the first result. */
  idempotencyKey?: string;
}

/** Pauses before resending a keyed write whose answer never arrived. */
const RESEND_DELAYS = [600, 1800];

let workspaceScope: string | null = null;
let workspaceViewer: string | null = null;
/** The last snapshot of the selected repository with its ETag, so an unchanged poll costs a 304 instead of every diff. */
let stateCache: { scope: string | null; etag: string; snapshot: WorkspaceSnapshot } | null = null;
let cacheEpoch = 0;
const resetListeners = new Set<() => void>();

/** The repository workspace requests are scoped to, for links that carry it in their query instead. */
export const workspaceScopeNow = () => workspaceScope;

/** The current authorized snapshot, without starting a request for a speculative link. */
export const peekState = () => stateCache?.scope === workspaceScope ? stateCache.snapshot : undefined;

/**
 * The repository every workspace request is scoped to, sent as X-Braid-Workspace, and the
 * signed-in person viewing it. The account layer sets both before a workspace mounts, and a
 * change to either forgets every cached snapshot and file. Single-owner deployments pass nulls.
 */
export function setWorkspaceScope(scope: string | null, viewer: string | null = null) {
  // Learning who the viewer is keeps what was read for the same scope; another person or repository does not.
  const viewerChanged = workspaceViewer !== null && viewer !== workspaceViewer;
  const changed = scope !== workspaceScope || viewerChanged;
  workspaceScope = scope;
  workspaceViewer = viewer;
  if (changed) resetWorkspaceCaches(!viewerChanged);
}

/** The scope the first reads carry, when the account layer has not set one yet; it confirms the scope, with the viewer, when it renders. */
export function primeWorkspaceScope(scope: string) {
  if (workspaceScope === null) setWorkspaceScope(scope);
}

/**
 * Forgets everything cached for the current repository and session. A changed scope does this
 * itself; signing in or out must call it, because the same scope can then show different data.
 */
export function resetWorkspaceCaches(keepEarlyReads = false) {
  // Scope-only changes preserve the initial reads by scope; a session reset invalidates all of them.
  // Detaching the object also prevents a late boot address lookup from repopulating it.
  if (!keepEarlyReads && typeof window !== 'undefined') delete window.__braidEarly;
  setPublicPolling(true);
  stateCache = null;
  first = null;
  cacheEpoch += 1;
  for (const listener of resetListeners) listener();
}

/** Lets module caches clear themselves whenever the repository or session changes. */
export function onWorkspaceReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
}

function scopedHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (workspaceScope) headers.set('x-braid-workspace', workspaceScope);
  return headers;
}

/** Workspace requests carry the selected repository, so they can never read or write another team's state. */
async function workspaceRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const scope = workspaceScope;
  const data = await request<T>(path, { ...options, headers: scopedHeaders(options.headers) });
  if (scope === workspaceScope && options.method && options.method !== 'GET' && options.method !== 'HEAD') {
    // The first example write creates a personal copy. Unconsumed startup reads and validators
    // belong to the copy we read before the write, even if their answers arrive afterwards.
    stateCache = null;
    first = null;
    cacheEpoch += 1;
    if (typeof window !== 'undefined' && window.__braidEarly) delete window.__braidEarly.reads;
  }
  return data;
}

/** A same-origin JSON request with session cookies. Account endpoints use it directly, without a repository scope. */
export async function request<T>(path: string, { idempotencyKey, ...init }: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD') followOwnWrite();
  if (!idempotencyKey) return send<T>(path, { ...init, headers });

  headers.set('idempotency-key', idempotencyKey);
  for (let attempt = 0; ; attempt++) {
    try {
      return await send<T>(path, { ...init, headers });
    } catch (error) {
      const lost = error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 504);
      if (!lost || attempt >= RESEND_DELAYS.length) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, RESEND_DELAYS[attempt]));
    }
  }
}

/** Fetches without judging the status, or takes over the same read where boot.js started it. Only a network failure throws, as ApiError with status 0. */
async function reach(path: string, init: RequestInit): Promise<Response> {
  if (retryDelay()) throw rateLimit;
  const started = (init.method ?? 'GET') === 'GET' ? takeEarlyRead(path, new Headers(init.headers).get('x-braid-workspace')) : null;
  if (started && init.cache !== 'reload') return started;
  // An explicit refresh must not consume an older response from a late boot script, so that read is dropped.
  if (started) void started.catch(() => undefined);
  try {
    return await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw unreachable();
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => { throw unreachable(); });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON, such as a gateway's error page: the status says what happened.
    return null;
  }
}

/** The server answers errors as `{ error }`; anything else, such as a gateway page, gets the status line. */
function failure(response: Response, data: unknown): ApiError {
  const { error, code } = (data ?? {}) as { error?: unknown; code?: unknown };
  if (response.status === 429) {
    if (code === 'example_session_limit') {
      if (typeof window !== 'undefined') window.dispatchEvent?.(new Event('braid:example-readonly'));
      return new ApiError(429, EXAMPLE_SESSION_LIMIT);
    }
    const after = response.headers.get('retry-after');
    const time = after && /^\d+(?:\.\d+)?$/.test(after) ? Date.now() + Number(after) * 1000 : Date.parse(after ?? '');
    const retryAt = Number.isFinite(time) ? Math.max(Date.now(), time) : Date.now() + 60_000;
    const limited = new ApiError(429, `Too many requests. Try again after ${clockTime(retryAt)}.`, retryAt);
    if (!rateLimit || rateLimit.retryAt < retryAt) rateLimit = limited;
    return limited;
  }
  return new ApiError(response.status, response.status >= 500 ? 'Something went wrong. Try again.' : typeof error === 'string' ? error : 'The request could not be completed. Try again.', 0, typeof code === 'string' ? code : undefined);
}

/** The body of an answer, or the ApiError a failed one maps to. */
async function bodyOf<T>(response: Response): Promise<T> {
  const data = await readJson(response);
  if (!response.ok) throw failure(response, data);
  return data as T;
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  return bounded(async signal => bodyOf<T>(await reach(path, { ...init, signal })), init.signal);
}

/** Reads `public/boot.js` started before this code arrived: the account, and the first screen's reads by scope and path. */
type EarlyReads = { account?: Promise<Response>; reads?: Record<string, Promise<Response>> };
declare global {
  interface Window {
    __braidEarly?: EarlyReads;
  }
}

const unreachable = () => new ApiError(0, 'Check your connection and try again.');

/** Takes over a read boot.js started for this path under this scope, once. Null when it started none. */
function takeEarlyRead(path: string, scope: string | null): Promise<Response> | null {
  const reads = typeof window === 'undefined' ? undefined : window.__braidEarly?.reads;
  const key = `${scope ?? ''} ${path}`;
  const started = reads?.[key];
  if (!started) return null;
  delete reads![key];
  return started.catch(() => { throw unreachable(); });
}

/** Bounds both headers and body, including when an older boot script started the read. */
function deadline<T>(read: Promise<T>, abort?: () => void, ms = 15_000, message = 'The request timed out. Try again.'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    read,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError(0, message));
        abort?.();
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function bounded<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cancelled = new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(unreachable()), { once: true }));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return deadline(Promise.race([read(controller.signal), cancelled]), abort).finally(() => signal?.removeEventListener('abort', abort));
}

/** Every account attempt has the same deadline; retrying must never hold the page open. */
export function readAccount<T>(): Promise<T> {
  const controller = new AbortController();
  return deadline(request<T>('/api/account', { signal: controller.signal }), () => controller.abort(), 4_000, 'Sign-in is temporarily unavailable.');
}

/** The account read boot.js started, answered as `request` answers, or null when it started none. */
export function earlyAccount<T>(): Promise<T> | null {
  const early = typeof window === 'undefined' ? undefined : window.__braidEarly;
  const started = early?.account;
  if (!started) return null;
  delete early!.account;
  return deadline(started.then(bodyOf<T>, () => { throw unreachable(); }), undefined, 4_000, 'Sign-in is temporarily unavailable.');
}

/**
 * A scope's first snapshot read, by the warm start or by the workspace, kept for the other until it asks, so a page
 * never reads its first snapshot twice whichever of them asks first; the polls after that read anew.
 */
let first: { scope: string | null; by: 'prime' | 'workspace'; promise: Promise<WorkspaceSnapshot> } | null = null;

function readState(by: 'prime' | 'workspace' = 'workspace'): Promise<WorkspaceSnapshot> {
  const scope = workspaceScope;
  if (first?.scope === scope && first.by !== by) {
    const { promise } = first;
    first = null;
    return promise;
  }
  const promise = fetchState();
  if (stateCache?.scope !== scope) first = { scope, by, promise };
  return promise;
}

async function fetchState(): Promise<WorkspaceSnapshot> {
  return bounded(async signal => {
    const scope = workspaceScope;
    const epoch = cacheEpoch;
    const cached = stateCache?.scope === scope ? stateCache : null;
    const headers = scopedHeaders({ accept: 'application/json' });
    if (cached) headers.set('if-none-match', cached.etag);
    const response = await reach('/api/state', { headers, signal });
    if (response.status === 304 && cached) return cached.snapshot;
    const snapshot = await bodyOf<WorkspaceSnapshot>(response);
    const etag = response.headers.get('etag');
    // A switch or sign-out while this was in flight means the answer belongs to a session that is gone.
    if (!signal.aborted && epoch === cacheEpoch) stateCache = etag ? { scope, etag, snapshot } : null;
    return snapshot;
  });
}

/**
 * Reads the snapshot for a scope the page will almost certainly open, in parallel with the
 * account read instead of after it. The workspace picks the answer up if the scope matches,
 * or shares the read it already started; otherwise the warm start's read is dropped.
 */
export function primeState(): Promise<WorkspaceSnapshot> {
  const promise = readState('prime');
  // The workspace takes this read over and shows a failure; a dropped one has no reader.
  promise.catch(() => undefined);
  return promise;
}

/** The owner's JSON backup of the selected repository's workspace, as the server sent it. */
async function readExport(): Promise<{ blob: Blob; filename: string | null }> {
  const response = await reach('/api/export', { headers: scopedHeaders({ accept: 'application/json' }) });
  if (!response.ok) throw failure(response, await readJson(response));
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
  return { blob: await response.blob(), filename: filename ? decodeURIComponent(filename) : null };
}

const missionPath = (id: string) => `/api/missions/${encodeURIComponent(id)}`;

export const api = {
  /** Sends If-None-Match with the cached ETag and answers a 304 with the snapshot it already has. */
  state: () => readState(),
  exportWorkspace: readExport,
  /** Starts a task. The key comes from useIdempotencyKey so a resent request cannot start it twice. */
  createMission: (input: MissionInput, idempotencyKey: string) =>
    workspaceRequest<{ missionId: string }>('/api/missions', { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
  /** Stops a task that is still waiting for or working with local agents. Owner only; the server answers with the reason when it cannot. */
  cancelMission: (missionId: string) => workspaceRequest<Mission | { missionId: string }>(`${missionPath(missionId)}/cancel`, { method: 'POST', body: '{}' }),
  finishMission: (missionId: string, agentIds: string[]) => workspaceRequest<Mission>(`${missionPath(missionId)}/finish`, { method: 'POST', body: JSON.stringify({ agentIds }) }),
  resolveCollision: (missionId: string, input: ResolveInput) =>
    workspaceRequest<Mission>(`${missionPath(missionId)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
  integration: (missionId: string) => workspaceRequest<IntegrationPreview>(`${missionPath(missionId)}/integration`),
  /** The fingerprint must be the one the person reviewed. The server answers 409 if the composition changed since. */
  mergeMission: (missionId: string, integrationFingerprint: string, idempotencyKey: string) =>
    workspaceRequest<MergeResult>(`${missionPath(missionId)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ integrationFingerprint }),
      idempotencyKey,
    }),
  addContext: (input: ContextInput, idempotencyKey?: string) => workspaceRequest<ContextItem>('/api/context', { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
  resetDemo: () => workspaceRequest<{ ok: true }>('/api/reset', { method: 'POST', body: '{}' }),
  unlock: (token: string) => request<{ ok: true }>('/api/session', { method: 'POST', body: JSON.stringify({ token }) }).finally(resetWorkspaceCaches),
  lock: () => request<{ ok: true }>('/api/session', { method: 'DELETE' }).finally(resetWorkspaceCaches),
  /** The project when its code is ready at once (201), or the import still copying (202), which the snapshot then follows. */
  createProject: (input: CreateProjectInput, idempotencyKey: string) =>
    workspaceRequest<Project | { importing: ProjectImport }>('/api/project', { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
  /** Restarts an import that stopped. The key makes a resend after a dropped connection the same restart. */
  retryImport: (idempotencyKey: string) =>
    workspaceRequest<{ importing: ProjectImport }>('/api/project/import/retry', { method: 'POST', body: '{}', idempotencyKey }),
  githubConnection: () => workspaceRequest<GitHubConnection>('/api/github/connection'),
  connectGitHub: (returnTo?: string) => workspaceRequest<{ url: string }>('/api/github/connect', { method: 'POST', body: JSON.stringify({ returnTo }) }),
  installGitHub: (returnTo?: string) => workspaceRequest<{ url: string }>('/api/github/install', { method: 'POST', body: JSON.stringify({ returnTo }) }),
  disconnectGitHub: () => workspaceRequest<{ ok: true }>('/api/github/connection', { method: 'DELETE' }),
  githubInstallations: (page = 1) => workspaceRequest<GitHubPage<GitHubInstallation>>(`/api/github/installations?page=${page}`),
  githubRepositories: (installationId: number, page = 1) => workspaceRequest<GitHubPage<GitHubRepository>>(`/api/github/repositories?installationId=${installationId}&page=${page}`),
  readFile: (path: string, ref = 'main') =>
    workspaceRequest<RepositoryFile>(`/api/repository?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`),
  readTree: (path: string, ref: string, cursor?: string) =>
    workspaceRequest<RepositoryTree>(`/api/repository/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  branches: () => workspaceRequest<RepositoryBranches>('/api/repository/branches'),
  search: (query: string, ref?: string) =>
    workspaceRequest<RepositorySearch>(`/api/repository/search?q=${encodeURIComponent(query)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`),
  compare: (base: string, head: string) =>
    workspaceRequest<RepositoryComparison>(`/api/repository/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`),
  compareDiff: (base: string, head: string, path: string) =>
    workspaceRequest<RepositoryDiff>(`/api/repository/compare/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&path=${encodeURIComponent(path)}`),
  commits: (ref: string, path = '', cursor?: string | null, limit?: number) =>
    workspaceRequest<CommitPage>(`/api/repository/commits?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${limit ? `&limit=${limit}` : ''}`),
  commit: (sha: string) => workspaceRequest<CommitDetail>(`/api/repository/commit?sha=${encodeURIComponent(sha)}`),
  commitDiff: (sha: string, path: string) =>
    workspaceRequest<CommitDiff>(`/api/repository/commit/diff?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`),
  downloadFile: async (path: string, ref: string) => {
    const response = await reach(`/api/repository?download=1&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`, { headers: scopedHeaders({}) });
    if (!response.ok) throw failure(response, await readJson(response));
    return response.blob();
  },
  /** Who last changed each line of a file on main, at main's head. */
  blame: (path: string, ref: string) => workspaceRequest<FileBlame>(`/api/blame?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`),
  /** The fleet roster: one record per model, owner and tool. */
  agents: () => workspaceRequest<AgentRecord[]>('/api/agents'),
  agentReports: () => workspaceRequest<AgentReports>('/api/agent-reports'),
  /** Local agents' activity in this repository, or for one pull request. */
  localActivity: (changeId?: string) => workspaceRequest<LocalActivityPage>(`/api/local-activity${changeId ? `?changeId=${encodeURIComponent(changeId)}` : ''}`),
  treeCommits: (ref: string, path: string, cursor?: string) =>
    workspaceRequest<RepositoryTree>(`/api/repository/tree/commits?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  resolveAgentReport: (id: string) => workspaceRequest<AgentReports>(`/api/agent-reports/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: '{}' }),
  /**
   * One proposed file with its full before and after text. The snapshot carries only the
   * metadata and a content reference; the server answers 409 when that proposal has since changed.
   */
  missionDiff: (missionId: string, agentId: string, path: string, contentRef: string) =>
    workspaceRequest<FileChange>(`${missionPath(missionId)}/diff?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(contentRef)}`),
};

/* ---------- Changes, the landing queue, policy and coordination ---------- */

interface ChangeQuery {
  /** A group (`active`, `attention`, `done`) or comma-separated statuses. Omit for every change. */
  status?: string;
  cursor?: string | null;
  limit?: number;
  /** `me` or an author id. */
  author?: string;
  /** Changes submitted for one task. */
  task?: string;
  /** One fleet roster agent's changes, by its `AgentRecord.id`. */
  agent?: string;
}

/** The effective policy at `head`, with the parse errors that kept fields at their defaults, and the instructions every agent follows. */
export interface PolicyFile {
  policy: Policy;
  errors: string[];
  head: string;
  instructions: Instruction[];
}

/** `.braid/instructions.json` on main, with what Braid could not read in it. */
interface InstructionsFile {
  instructions: Instruction[];
  errors: string[];
  head: string;
}

/** An instruction as a person adds one: what every agent should do, strings a change may not add, and the files it covers. */
type InstructionInput = { text: string; block?: string[]; paths?: string[] };

/** The webhook to the repository's CI, without its secret, and what was sent to it lately. Owners only. */
export interface Webhook {
  url: string;
  origin: string;
  by: string;
  createdAt: string;
  deliveries: WebhookDelivery[];
}
/** One `merge_group` delivery: the CI's response code, or `unreachable`, for one merge queue commit. */
interface WebhookDelivery { id: string; event: string; at: string; status: number | 'unreachable'; sha: string }

/** Active changes touching each requested path. */
type TouchingChanges = Record<string, { changeId: string; number: number; title: string; status: ChangeStatus; author: string }[]>;

function changeQuery(query: ChangeQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.author) params.set('author', query.author);
  if (query.task) params.set('task', query.task);
  if (query.agent) params.set('agent', query.agent);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const changePath = (id: string) => `/api/changes/${encodeURIComponent(id)}`;

/**
 * Changes are the unit that lands on main. Reads work in the recorded example too, and so do
 * approve, send back and close; every other write there answers 409.
 */
export const changes = {
  list: (query: ChangeQuery = {}) => workspaceRequest<ChangePage>(`/api/changes${changeQuery(query)}`),
  get: (idOrNumber: string) => workspaceRequest<Change>(changePath(idOrNumber)),
  /** One file of a revision against main, or with `since` against an earlier revision of the same change. */
  diff: (id: string, path: string, revision?: number, since?: number) =>
    workspaceRequest<ChangeDiff>(`${changePath(id)}/diff?path=${encodeURIComponent(path)}${revision ? `&revision=${revision}` : ''}${since ? `&since=${since}` : ''}`),
  /** The files that differ since an earlier revision, counted against it. */
  compare: (id: string, revision: number, since: number) => workspaceRequest<ChangeComparison>(`${changePath(id)}/compare?since=${since}&revision=${revision}`),
  /** The revision's guided review: before and after, and its diff in chapters. */
  guide: (id: string, revision: number) => workspaceRequest<ChangeGuide>(`${changePath(id)}/guide?revision=${revision}`),
  /** A person approves one exact revision; a newer revision needs its own approval. */
  approve: (id: string, revision: number, body?: string, idempotencyKey?: string) =>
    workspaceRequest<Change>(`${changePath(id)}/approve`, { method: 'POST', body: JSON.stringify({ revision, body }), idempotencyKey }),
  close: (id: string, reason: ChangeCloseReason) => workspaceRequest<Change>(`${changePath(id)}/close`, { method: 'POST', body: JSON.stringify({ reason }) }),
  /** Sends a revision back to its author with a note saying what should change. */
  sendBack: (id: string, revision: number, summary: string, idempotencyKey?: string) =>
    workspaceRequest<Change>(`${changePath(id)}/reviews`, { method: 'POST', body: JSON.stringify({ verdict: 'revise', revision, summary }), idempotencyKey }),
  comment: (id: string, input: { body: string; revision: number; path?: string; line?: number; side?: 'LEFT' | 'RIGHT'; inReplyTo?: string }, idempotencyKey: string) =>
    workspaceRequest<Change>(`${changePath(id)}/comments`, { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
  resolveConversation: (id: string, commentId: string, resolved: boolean, idempotencyKey: string) =>
    workspaceRequest<Change>(`${changePath(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }), idempotencyKey }),
  /** Opens a new change that undoes a landed one. Owner only, live repositories; the recorded example answers 409. */
  revert: (id: string, idempotencyKey: string) => workspaceRequest<Change>(`${changePath(id)}/revert`, { method: 'POST', body: '{}', idempotencyKey }),
  /** Rebuilds a dependent pull request on its prerequisite's newest revision; author or owner only. */
  restack: (id: string, previousRevision: number, idempotencyKey: string) =>
    workspaceRequest<Change>(`${changePath(id)}/restack`, { method: 'POST', body: JSON.stringify({ previousRevision }), idempotencyKey }),
  queue: (stackCursor = 0) => workspaceRequest<TrunkStatus>(`/api/queue${stackCursor ? `?stackCursor=${stackCursor}` : ''}`),
  setLanding: (enabled: boolean) => workspaceRequest<TrunkStatus>('/api/queue/landing', { method: 'POST', body: JSON.stringify({ enabled }) }),
  policy: () => workspaceRequest<PolicyFile>('/api/policy'),
  touching: (paths: string[]) => workspaceRequest<TouchingChanges>(`/api/coordination?paths=${encodeURIComponent(paths.join(','))}`),
  swarm: () => workspaceRequest<SwarmRun | null>('/api/swarm'),
  startSwarm: (agents: number, scenario: SwarmScenario) => workspaceRequest<SwarmRun>('/api/swarm', { method: 'POST', body: JSON.stringify({ agents, scenario }) }),
  stopSwarm: () => workspaceRequest<SwarmRun | null>('/api/swarm/stop', { method: 'POST', body: '{}' }),
  /** The CI webhook, as GitHub's merge queue connects any CI: owners read, add or replace and remove it. */
  hook: () => workspaceRequest<Webhook | null>('/api/hooks'),
  setHook: (url: string, secret: string) => workspaceRequest<Webhook>('/api/hooks', { method: 'PUT', body: JSON.stringify({ url, secret }) }),
  deleteHook: () => workspaceRequest<null>('/api/hooks', { method: 'DELETE' }),
  /**
   * Where an `<img>` reads a screenshot a change carries as evidence. An image element cannot send the
   * workspace header, so the repository rides in the query; the session cookie still authorizes it.
   */
  evidenceImageUrl: (id: string, image: string) => `${changePath(id)}/evidence/${encodeURIComponent(image)}${workspaceScope ? `?workspace=${encodeURIComponent(workspaceScope)}` : ''}`,
  /** The instructions every agent follows, from `.braid/instructions.json` on main. */
  instructions: () => workspaceRequest<InstructionsFile>('/api/instructions'),
  /** Adds an instruction through a pull request of the person's own. Owner only, live repositories; the recorded example answers 409. */
  addInstruction: (input: InstructionInput, idempotencyKey: string) => workspaceRequest<Change>('/api/instructions', { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
  /** Removes an instruction through a pull request. Owner only, live repositories. */
  removeInstruction: (id: string, idempotencyKey: string) => workspaceRequest<Change>(`/api/instructions/${encodeURIComponent(id)}`, { method: 'DELETE', idempotencyKey }),
  githubLink: () => workspaceRequest<GitHubLinkStatus | null>('/api/github/link'),
  linkGitHub: (selection: GitHubRepositorySelection, mode: GitHubLinkStatus['mode']) =>
    workspaceRequest<GitHubLinkStatus>('/api/github/link', { method: 'POST', body: JSON.stringify({ ...selection, mode }) }),
  unlinkGitHub: () => workspaceRequest<{ ok: true }>('/api/github/link', { method: 'DELETE' }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * True when a write may or may not have been applied: the connection dropped, the
 * server was rate limiting, or it failed partway. Retrying such a write must reuse its key.
 */
export function outcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
