import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace';
import type { Result } from '../errors';
import { seedWorkspace } from './seed';
import { storageFixture } from '../test/storage';
import { parse } from '../schemas';
import { assignedTask, taskNote } from './task-input';
import type { BraidEnv } from '../env';
import type { AgentGrant } from '../accounts/security';
import type { ContextItem, WorkspaceSnapshot } from '../../shared/types';

vi.mock('../git/push', async original => ({ ...await original<typeof import('../git/push')>(), commitFiles: vi.fn(async () => 'b'.repeat(40)) }));
const databases: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.db.close(); });
const head = 'a'.repeat(40);
const owner = { id: 'user:owner', email: 'owner@example.test', name: 'Owner' };
const ownerHeaders = { 'x-braid-user-id': owner.id, 'x-braid-actor': 'Owner', 'x-braid-workspace': 'workspace-1', 'x-braid-team': 'team-1' };
const grant = (id: string, extra: Partial<AgentGrant> = {}): AgentGrant => ({ id, user: owner, workspaceId: 'workspace-1', scope: 'work', label: `${id} on MacBook Pro`, expires: Date.now() + 86_400_000, ...extra });
const connection = (id: string) => ({ 'x-braid-connection': id, 'x-braid-connection-digest': id, 'x-braid-connection-expires': String(Date.now() + 86_400_000), 'x-braid-connection-label': encodeURIComponent(`Codex on ${id}-MacBook`) });

async function fixture() {
  const db = storageFixture(); databases.push(db);
  const seed = seedWorkspace('live', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, canWrite: true, model: '', namespace: 'test' });
  seed.project = { id: 'project', name: 'Project', branch: 'main', head, description: '', stack: [] };
  await db.storage.put('workspace', seed);
  const grants = new Map(['claude', 'codex', 'other'].map(id => [id, grant(id)]));
  const security = { agents: vi.fn(async () => [...grants.values()].filter(grant => grant.user.id === owner.id)), agent: vi.fn(async (id: string) => grants.get(id)), consume: vi.fn(async () => ({ allowed: true })) };
  const repo = { [Symbol.dispose]() {}, log: vi.fn(async () => [{ hash: head }]), readCommit: vi.fn(async () => ({ treeHash: head })), readTree: vi.fn(async () => []), readFile: vi.fn(async () => null),
    createToken: vi.fn(async () => ({ plaintext: 'temporary-test-git-token' })), revokeToken: vi.fn(async () => {}),
    fork: vi.fn(async (name: string) => ({ name, remote: `https://git.example/${name}`, token: 'temporary-fork-token' })),
  };
  const directory = { access: vi.fn(async (): Promise<Result<{ teamId: string }>> => ({ ok: true, data: { teamId: 'team-1' } })) };
  const env = { AI_MODEL: 'test-model', AUTH_MODE: 'github', LIVE_ENABLED: 'true', ARTIFACTS: { get: vi.fn(async () => repo) }, SECURITY: { idFromName: () => 'security', get: () => security }, DIRECTORY: { idFromName: () => 'directory', get: () => directory } } as unknown as BraidEnv;
  let workspace = new Workspace(db.ctx, env); await db.ready();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, key = crypto.randomUUID()) => workspace.fetch(new Request(`https://braid.example${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-braid-mode': 'live', 'x-braid-role': 'owner', 'content-type': 'application/json', 'idempotency-key': key, ...ownerHeaders, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const state = async () => await (await request('/api/state')).json() as WorkspaceSnapshot;
  const start = async (ids?: string[]) => {
    const response = await request('/api/missions', { title: 'Update docs', intent: 'Explain the setup', execution: 'local', ...(ids ? { connectionIds: ids } : {}) });
    expect(response.status).toBe(202);
    return (await response.json() as { missionId: string }).missionId;
  };
  return { db, request, start, state, grants, security, repo, directory, current: () => workspace, restart: async () => { workspace = new Workspace(db.ctx, env); await db.ready(); } };
}

describe('assigned task connections', () => {
  it('lets any of the owner’s work connections take a lane started for another, and only the one that took it report and submit', async () => {
    const f = await fixture(), id = await f.start(['claude', 'codex']);
    const task = (await f.state()).missions[0];
    expect(task.agents.map(agent => agent.connection?.id)).toEqual(['claude', 'codex']);
    const base = `/api/missions/${id}/agents/${task.agents[0].id}`;
    expect((await f.request(`${base}/checkout`, {})).status).toBe(403);
    expect(f.repo.createToken).not.toHaveBeenCalled();
    expect((await f.request(`${base}/checkout`, {}, connection('other'))).status).toBe(200);
    expect((await f.state()).missions[0].agents[0].connection).toEqual({ id: 'other', label: expect.any(String) });
    expect((await f.request(`${base}/checkout`, {}, connection('claude'))).status).toBe(409);
    const key = crypto.randomUUID(), body = { message: 'Reading the docs' };
    expect((await f.request(`${base}/progress`, body, connection('other'), key)).status).toBe(200);
    expect((await f.request(`${base}/progress`, body, connection('codex'), key)).status).toBe(403);
    const submission = { baseCommit: head, summary: 'Explain setup', rationale: 'Help new contributors', model: 'claude-opus-5-5', files: [{ path: 'docs/setup.md', content: 'Setup\n' }] };
    expect((await f.request(`${base}/submit`, submission, connection('codex'))).status).toBe(403);
    expect((await f.request(`${base}/submit`, submission, connection('other'))).status).toBe(200);
    expect((await f.state()).missions[0].agents[0]).toMatchObject({ status: 'review', model: 'claude-opus-5-5', completedAt: expect.any(String) });
  });

  it.each(['repository', 'owner', 'read', 'fleet', 'expired', 'missing'] as const)('rejects an unavailable %s connection before spending task budget', async kind => {
    const f = await fixture();
    if (kind === 'repository') f.grants.set('claude', grant('claude', { workspaceId: 'workspace-2' }));
    if (kind === 'owner') f.grants.set('claude', grant('claude', { user: { ...owner, id: 'user:other' } }));
    if (kind === 'read' || kind === 'fleet') f.grants.set('claude', grant('claude', { scope: kind }));
    if (kind === 'expired') f.grants.set('claude', grant('claude', { expires: Date.now() - 1 }));
    if (kind === 'missing') f.grants.delete('claude');
    const response = await f.request('/api/missions', { title: 'Docs', intent: 'Explain setup', execution: 'local', connectionIds: ['claude'] });
    expect(response.status).toBe(403); expect(f.security.consume).not.toHaveBeenCalled();
  });

  it('rechecks grant repository, revocation and owner membership when claiming', async () => {
    const f = await fixture(), id = await f.start(['claude']);
    const agent = (await f.state()).missions[0].agents[0];
    const path = `/api/missions/${id}/agents/${agent.id}/checkout`;
    f.grants.set('claude', grant('claude', { workspaceId: 'workspace-2' }));
    expect((await f.request(path, {}, connection('claude'))).status).toBe(403);
    f.grants.delete('claude');
    expect((await f.request(path, {}, connection('claude'))).status).toBe(403);
    f.grants.set('claude', grant('claude'));
    f.directory.access.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden.' });
    expect((await f.request(path, {}, connection('claude'))).status).toBe(403);
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });

  it('does not disclose connection identifiers or device labels in public task reads', async () => {
    const f = await fixture(), id = await f.start(['claude']);
    const response = await f.request(`/api/missions/${id}`, undefined, { 'x-braid-public': 'true' });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('MacBook');
  });
});

describe('task instructions', () => {
  it('persists an instruction once, exposes it in activity and returns it on the assigned agent’s next checkout', async () => {
    const f = await fixture(), id = await f.start(['claude']);
    const agent = (await f.state()).missions[0].agents[0];
    const path = `/api/missions/${id}/agents/${agent.id}/checkout`;
    expect((await f.request(path, {}, connection('claude'))).status).toBe(200);
    const note = { title: 'Task instruction', body: 'Keep the public API unchanged.', missionId: id }, key = crypto.randomUUID();
    expect((await f.request('/api/context', note, {}, key)).status).toBe(201);
    expect((await f.request('/api/context', note, {}, key)).status).toBe(201);
    await f.restart();
    const details = await (await f.request(path, {}, connection('claude'))).json() as { context: ContextItem[] };
    expect(details.context.filter(note => note.missionId === id)).toHaveLength(1);
    expect(details.context.at(-1)?.body).toBe(note.body);
    const events = (await f.state()).activity.filter(item => item.type === 'context' && item.missionId === id);
    expect(events).toHaveLength(1); expect(events[0].detail).toBe(note.body);
    const other = await f.start(['codex']);
    const next = (await f.state()).missions.find(task => task.id === other)!;
    const separate = await (await f.request(`/api/missions/${other}/agents/${next.agents[0].id}/checkout`, {}, connection('codex'))).json() as { context: ContextItem[] };
    expect(separate.context).not.toContainEqual(expect.objectContaining({ missionId: id }));
  });

  it('rejects instructions from agent connections, readers, for unknown tasks and after a task stops', async () => {
    const f = await fixture(), id = await f.start();
    const note = { title: 'Task instruction', body: 'Keep the API unchanged.', missionId: id };
    expect((await f.request('/api/context', note, connection('claude'))).status).toBe(403);
    expect((await f.request('/api/context', note, { 'x-braid-role': 'viewer' })).status).toBe(403);
    expect((await f.request('/api/context', { ...note, missionId: 'unknown' })).status).toBe(404);
    expect((await f.request(`/api/missions/${id}/cancel`, {})).status).toBe(200);
    expect((await f.request('/api/context', note)).status).toBe(409);
  });
});

describe('task request boundaries', () => {
  const task = { title: 'Docs', intent: 'Explain setup', execution: 'local' };
  it.each([[], ['a', 'a'], ['a', 'b', 'c', 'd'], [12], [''], 'a'])('rejects invalid selected connections %j', connectionIds => {
    expect(() => parse(assignedTask, { ...task, connectionIds })).toThrow();
  });
  it('rejects cloud assignments and a mismatched count', () => {
    expect(() => parse(assignedTask, { ...task, execution: 'cloud', connectionIds: ['a'] })).toThrow();
    expect(() => parse(assignedTask, { ...task, agentCount: 2, connectionIds: ['a'] })).toThrow();
  });
  it('validates and trims task notes while retaining their scope', () => {
    expect(parse(taskNote, { title: ' Instruction ', body: ' Keep APIs ', missionId: 'mission-1' })).toEqual({ title: 'Instruction', body: 'Keep APIs', missionId: 'mission-1', kind: 'constraint' });
    expect(() => parse(taskNote, { title: 'Instruction', body: ' ', missionId: 'mission-1' })).toThrow();
  });
});
