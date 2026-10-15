import { afterEach, expect, it, vi } from 'vitest';
import { Workspace } from '../workspace/workspace';
import { ContentStore } from '../workspace/content';
import { storageFixture } from '../test/storage';
import { HttpError } from '../errors';
import type { Agent, HostedFailure, Mission, WorkspaceSnapshot } from '../../shared/types';
import type { Authorization } from '../http/authorization';
import { checkAuthorization } from '../http/authorization';
import type { HostedProvider } from './providers';
import { failure } from './hosted-failures';

vi.mock('../http/authorization', () => ({ checkAuthorization: vi.fn(async () => {}) }));
const databases: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); vi.clearAllMocks(); });
const owner = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' }, workspaceId: 'workspace', teamId: 'team' } as Authorization;
const provider: HostedProvider = { id: 'openai', owner: 'owner', version: 'v1' };
const head = 'a'.repeat(40);
type Harness = {
  createMission(body: unknown, receipt?: unknown, authorization?: Authorization): Promise<string>;
  hostedProvider(agent: Agent, input: { provider?: HostedProvider; authorization?: Authorization }): HostedProvider | undefined;
  hostedWorkflowFailure(missionId: string, agentId: string, reason: HostedFailure, attempt: number): Promise<void>;
  runAgent(missionId: string, agentId: string): Promise<{ commit: string | null; failure?: HostedFailure }>;
  readHostedPreflight(commit: string): Promise<unknown>;
};
function fixture() {
  const db = storageFixture(); databases.push(db); db.storage.sql.exec('CREATE TABLE inputs (mission TEXT PRIMARY KEY, value TEXT)');
  const choice = vi.fn(async () => ({ ok: true, version: 'v1', model: 'selected-model' })), consume = vi.fn(async () => ({ allowed: true }));
  const repo = { [Symbol.dispose]() {}, log: vi.fn(async () => [{ hash: head }]), readFile: vi.fn(async () => null as Blob | null) };
  const enqueue = vi.fn(async () => {}), save = vi.fn(async () => {});
  const data = { project: { id: 'repo', branch: 'main', head }, capabilities: { mode: 'live' }, missions: [] as Mission[], context: [], files: {} } as unknown as WorkspaceSnapshot;
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    ctx: { ...db.ctx, exports: { AgentSandbox: {} } }, env: { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true', ARTIFACTS: { get: async () => repo },
      SECURITY: { idFromName: () => 'security', get: () => ({ providerChoice: choice, consume }) } }, data,
    content: new ContentStore(db.storage), trunkBusy: () => false, save, event: vi.fn(), enqueue,
    currentOperation: async () => true, runningAgents: new Set(), agentStages: new Map(),
  }) as Harness;
  return { db, workspace, repo, data, choice, consume, enqueue, save, env: (workspace as unknown as { env: Record<string, unknown> }).env };
}
it.each([undefined, 'workers-ai'])('starts keyless Workers AI tasks and freezes their configured model: %s', async provider => {
  const f = fixture(); Object.assign(f.env, { AI: {}, AI_MODEL: '@cf/fixture/model' });
  const id = await f.workspace.createMission({ title: 'Update docs', intent: 'Clarify usage', execution: 'cloud', agentCount: 1, provider }, undefined, owner);
  expect(f.data.missions[0]).toMatchObject({ id, status: 'running', agents: [{ model: '@cf/fixture/model' }] });
  expect(f.data.missions[0].agents[0].provider).toBeUndefined();
  expect(f.choice).not.toHaveBeenCalled(); expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(id, 'run');
  const snapshot = f.db.storage.sql.exec<{ value: string }>('SELECT value FROM inputs WHERE mission = ?', id).toArray()[0];
  expect(JSON.parse(snapshot.value).provider).toBeUndefined();
  expect(f.workspace.hostedProvider(f.data.missions[0].agents[0], { authorization: owner })).toBeUndefined();
});
it('refuses an unavailable Workers AI binding before using capacity', async () => {
  const f = fixture();
  await expect(f.workspace.createMission({ title: 'Update docs', intent: 'Clarify usage', execution: 'cloud' }, undefined, owner)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Workers AI is not configured') });
  expect(f.consume).not.toHaveBeenCalled(); expect(f.repo.log).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
});
it('starts a provider-backed task without a Workers AI binding and freezes its owner, key version and repository commit', async () => {
  const f = fixture();
  const id = await f.workspace.createMission({ title: 'Update docs', intent: 'Clarify usage', execution: 'cloud', agentCount: 1, provider: 'openai' }, undefined, owner);
  expect(f.data.missions[0]).toMatchObject({ id, baseCommit: head, status: 'running', agents: [{ model: 'selected-model', provider: 'openai' }] });
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(id, 'run');
  const snapshot = f.db.storage.sql.exec<{ value: string }>('SELECT value FROM inputs WHERE mission = ?', id).toArray()[0];
  expect(JSON.parse(snapshot.value)).toMatchObject({ authorization: owner, provider });
  expect(f.choice.mock.invocationCallOrder[0]).toBeLessThan(f.consume.mock.invocationCallOrder[0]);
  expect(checkAuthorization).toHaveBeenCalledWith(expect.anything(), owner);
});
it('keeps a rejected provider from spending the daily task budget', async () => {
  const f = fixture(); f.choice.mockResolvedValueOnce({ ok: false, error: 'Reconnect the provider.' } as never);
  await expect(f.workspace.createMission({ title: 'Update docs', intent: 'Clarify usage', execution: 'cloud', provider: 'openai' }, undefined, owner)).rejects.toMatchObject({ status: 409 });
  expect(f.consume).not.toHaveBeenCalled(); expect(f.repo.log).not.toHaveBeenCalled();
});
it('persists a typed launch failure for every lane when the workflow cannot be enqueued', async () => {
  const f = fixture(); f.enqueue.mockRejectedValueOnce(new Error('private upstream detail'));
  await expect(f.workspace.createMission({ title: 'Update docs', intent: 'Clarify usage', execution: 'cloud', agentCount: 1, provider: 'openai' }, undefined, owner)).rejects.toThrow('private upstream detail');
  expect(f.data.missions[0]).toMatchObject({ status: 'failed', error: 'The task workflow could not start. Retry the task.', agents: [{ status: 'failed', environment: { status: 'failed', failure: { cause: 'workflow_step', evidence: { reason: 'launch' } } } }] });
  expect(JSON.stringify(f.data)).not.toContain('private upstream detail');
});
it('labels a missing saved task context without calling it an authorization failure', async () => {
  const f = fixture();
  f.data.missions.push({ id: 'm', status: 'running', agents: [{ id: 'a', status: 'queued' }] } as Mission);
  Object.assign(f.workspace, { input: async () => null });
  await expect(f.workspace.runAgent('m', 'a')).resolves.toMatchObject({ failure: { cause: 'preflight', evidence: { reason: 'missing_context' } } });
});
it.each([undefined, { ...provider, owner: 'someone-else' }, { ...provider, id: 'anthropic' as const }])('never substitutes a missing or different saved provider: %j', supplied => {
  const f = fixture();
  expect(() => f.workspace.hostedProvider({ provider: 'openai' } as Agent, { authorization: owner, provider: supplied })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ cause: 'provider', evidence: expect.objectContaining({ code: 'revoked' }) }) }));
});
it('records an authorization refusal as terminal typed data instead of retrying it as an opaque workflow error', async () => {
  const f = fixture();
  f.data.missions.push({ id: 'm', status: 'running', agents: [{ id: 'a', status: 'working' }] } as Mission);
  Object.assign(f.workspace, { executeAgent: async () => { throw new HttpError(403, 'Owner access was revoked.'); } });
  const result = await f.workspace.runAgent('m', 'a');
  expect(result).toMatchObject({ commit: null, failure: { evidence: { reason: 'authorization', status: 403 } } });
  expect(f.data.missions[0].agents[0].environment).toMatchObject({ status: 'failed', failure: result.failure });
});
it('keeps the failed stage when the last workflow retry is exhausted', async () => {
  const f = fixture();
  f.data.missions.push({ id: 'm', status: 'running', agents: [{ id: 'a', status: 'working', failureStage: 'publish' }] } as Mission);
  await f.workspace.hostedWorkflowFailure('m', 'a', failure('workflow_step', 'workflow', { source: 'workflow', operation: 'run a' }), 0);
  expect(f.data.missions[0].agents[0].environment?.failure?.evidence.reason).toBe('publish');
});
it('preserves typed command and task limits through workspace validation and activity persistence', async () => {
  const f = fixture();
  f.data.missions.push({ id: 'm', status: 'running', agents: [{ id: 'a', status: 'working' }] } as Mission);
  const reason = failure('timeout', 'command', { source: 'process', operation: 'go build ./cmd/lecrev', timedOut: true, limitKind: 'task', timeoutMs: 27 * 60_000, elapsedMs: 27 * 60_000 });
  await f.workspace.hostedWorkflowFailure('m', 'a', reason, 0);
  expect(f.data.missions[0].agents[0].environment?.failure?.evidence).toMatchObject({ limitKind: 'task', timeoutMs: 27 * 60_000 });
  expect(f.data.missions[0].agents[0].hostedActivity?.at(-1)?.failure?.evidence).toMatchObject({ limitKind: 'task', timeoutMs: 27 * 60_000 });
});
it('defers oversized optional manifests to the checkout rather than rejecting task creation', async () => {
  const f = fixture(); f.repo.readFile.mockImplementation(async (...args: unknown[]) => (args[0] as { path: string }).path === 'package.json' ? new Blob([' '.repeat(70_000)]) : null);
  await expect(f.workspace.readHostedPreflight(head)).resolves.toMatchObject({ missing: [], checks: [] });
});
