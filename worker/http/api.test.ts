import { organizationWithRepository } from '../test/organization';
import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import type { BraidEnv } from '../env';
import { digest, sessionToken } from './auth';
import { base64url } from 'jose';
import { githubProfile } from '../accounts/oauth';
import type { AccountIdentity } from '../../shared/account';
import type { Actor } from '../changes/shard';

function fixture() {
  const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
  const store = storageFixture(), security = new Security(store.ctx, {} as BraidEnv);
  const calls: { workspace: string; mode: string | null; actor: string | null; role: string | null }[] = [];
  const forwardedHeaders: Headers[] = [];
  const env = { AUTH_MODE: 'github', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', ADMIN_TOKEN: 'strong-owner-key-for-tests-123456789', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-client-secret',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: (workspace: string) => ({ fetch: async (request: Request) => {
      calls.push({ workspace, mode: request.headers.get('x-braid-mode'), actor: request.headers.get('x-braid-actor'), role: request.headers.get('x-braid-role') });
      forwardedHeaders.push(new Headers(request.headers));
      return Response.json({ capabilities: { mode: request.headers.get('x-braid-mode') } });
    } }) }, ASSETS: { fetch: () => Response.json({ asset: true }) },
  } as unknown as BraidEnv;
  const call = (path: string, options: { userCookie?: string; workspace?: string; body?: unknown; method?: string; extra?: Record<string, string> } = {}) => api.fetch(new Request(`https://braid.example${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'), headers: { ...(options.userCookie ? { cookie: options.userCookie } : {}), ...(options.workspace ? { 'x-braid-workspace': options.workspace } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.extra }, body: options.body ? JSON.stringify(options.body) : undefined,
  }), env);
  const login = async (user: AccountIdentity) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, user); return `__Host-braid-session=${token}`; };
  return { env, security, directory, calls, forwardedHeaders, call, login };
}
/** Existing tenant tests exercise private repositories; new ones below explicitly publish repositories. */
function privateTeam(directory: Directory, user: AccountIdentity, name: string) {
  const team = organizationWithRepository(directory, user, name);
  team.workspaces = team.workspaces.map(repo => directory.updateWorkspace(user.id, { teamId: team.id, workspaceId: repo.id, visibility: 'private' }));
  return team;
}
const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' }, bob = { id: 'bob', email: 'bob@example.com', name: 'Bob' };
describe('recorded example sessions', () => {
  it('reads a first visit from the shared copy without a session and isolates cookie-less writes even on the same network', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const f = fixture(); edgeCache();
      const visitor = { 'cf-connecting-ip': '203.0.113.7' };
      const reads = await Promise.all([1, 2, 3].map(() => f.call('/api/state', { workspace: 'demo', extra: visitor })));
      expect(reads.map(response => response.status)).toEqual([200, 200, 200]);
      expect(reads.some(response => response.headers.has('set-cookie'))).toBe(false);
      expect(new Set(f.calls.map(call => call.workspace))).toEqual(new Set([`demo:shared:any:${Math.floor(Date.now() / 3_600_000)}`]));
      const change = () => f.call('/api/context', { workspace: 'demo', body: { text: 'Keep deliveries idempotent.' }, extra: visitor });
      const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
      const first = await Promise.all([change(), change(), change()]);
      expect(new Set(first.map(cookieOf)).size).toBe(3);
      expect(cookieOf(first[0])).toMatch(/^braid-demo=/);
      expect(f.calls.at(-1)!.workspace).toMatch(/^demo:(?!shared)/);
      vi.setSystemTime(Date.now() + 11_000);
      expect(cookieOf(await change())).not.toBe(cookieOf(first[0]));
    } finally { vi.useRealTimers(); }
  });
});

describe('public API tenant boundary', () => {
  it('revalidates cached snapshots when permissions, identity, or deployment capabilities change', async () => {
    const f = fixture(), team = privateTeam(f.directory, alice, 'A');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, team.id, { email: bob.email, role: 'owner' })).token);
    const db = storageFixture(), repository = new Workspace(db.ctx, f.env);
    await db.ready();
    f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => repository } as unknown as BraidEnv['WORKSPACES'];
    const workspace = team.workspaces[0].id, userCookie = await f.login(bob);
    const original = await f.call('/api/state', { workspace, userCookie });
    const extra = { 'if-none-match': original.headers.get('etag')! };
    expect(original.status).toBe(200);
    expect((await f.call('/api/state', { workspace, userCookie, extra })).status).toBe(304);
    const weak = `W/${extra['if-none-match']}`;
    expect((await f.call('/api/state', { workspace, userCookie, extra: { 'if-none-match': weak } })).status).toBe(304);
    expect((await f.call('/api/state', { workspace, userCookie, extra: { 'if-none-match': `"stale", ${weak}` } })).status).toBe(304);
    extra['if-none-match'] = weak;
    f.directory.removeMember(alice.id, team.id, bob.id);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, team.id, { email: bob.email, role: 'member' })).token);
    const demoted = await f.call('/api/state', { workspace, userCookie, extra });
    expect(demoted.status).toBe(200);
    expect((await demoted.json() as { capabilities: { canWrite: boolean } }).capabilities.canWrite).toBe(false);
    extra['if-none-match'] = demoted.headers.get('etag')!;
    const renamedCookie = await f.login({ ...bob, name: 'Robert' });
    const renamed = await f.call('/api/state', { workspace, userCookie: renamedCookie, extra });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { capabilities: { identity: { name: string } } }).capabilities.identity.name).toBe('Robert');
    extra['if-none-match'] = renamed.headers.get('etag')!;
    f.env.AI_MODEL = 'updated-model';
    const configured = await f.call('/api/state', { workspace, userCookie: renamedCookie, extra });
    expect(configured.status).toBe(200);
    expect((await configured.json() as { capabilities: { model: string } }).capabilities.model).toBe('updated-model');
    f.directory.removeMember(alice.id, team.id, bob.id);
    expect((await f.call('/api/state', { workspace, userCookie: renamedCookie, extra })).status).toBe(404);
  });
  it('denies cross-team IDs and spoofed owner headers before touching a workspace', async () => {
    const f = fixture(), a = privateTeam(f.directory, alice, 'A'), b = privateTeam(f.directory, bob, 'B');
    const userCookie = await f.login(alice);
    expect((await f.call('/api/state', { userCookie, workspace: b.workspaces[0].id })).status).toBe(404);
    expect((await f.call('/api/state', { workspace: a.workspaces[0].id, extra: { 'x-braid-mode': 'live', 'x-braid-role': 'owner' } })).status).toBe(404);
    expect(f.calls).toHaveLength(0);
    const response = await f.call('/api/state', { userCookie, workspace: a.workspaces[0].id, extra: { 'x-braid-actor': 'forged', 'x-braid-team': b.id } });
    expect(response.status).toBe(200);
    expect(f.calls[0]).toEqual({ workspace: `team:${a.id}:repository:${a.workspaces[0].id}`, mode: 'live', actor: alice.name, role: 'owner' });
    expect((await response.json() as { capabilities: { identity: { id: string } } }).capabilities.identity.id).toBe(alice.id);
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-request-id')).toBeTruthy();
  });
  it('allows members to read and rejects writes and membership administration', async () => {
    const f = fixture(), a = privateTeam(f.directory, alice, 'A');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, a.id, { email: bob.email, role: 'member' })).token);
    const userCookie = await f.login(bob), workspace = a.workspaces[0].id;
    expect((await f.call('/api/state', { userCookie, workspace })).status).toBe(200);
    expect((await f.call('/api/missions', { userCookie, workspace, body: { title: 'denied' } })).status).toBe(403);
    expect((await f.call(`/api/teams/${a.id}/invites`, { userCookie, body: { email: 'third@example.com', role: 'owner' } })).status).toBe(403);
    f.directory.removeMember(alice.id, a.id, bob.id);
    expect((await f.call('/api/state', { userCookie, workspace })).status).toBe(404);
  });
  it('revokes copied session cookies on logout and protects mutations against cross-site requests', async () => {
    const f = fixture(), userCookie = await f.login(alice);
    expect((await f.call('/api/teams', { userCookie, body: { name: 'A' }, extra: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await f.call('/api/session', { userCookie, method: 'DELETE' })).status).toBe(200);
    expect((await f.call('/api/teams', { userCookie, body: { name: 'A' } })).status).toBe(401);
  });
  it('requires scoped owner approval before issuing an agent connection and blocks merge/admin access', async () => {
    const f = fixture(), a = privateTeam(f.directory, alice, 'A'), b = privateTeam(f.directory, bob, 'B');
    const userCookie = await f.login(alice), workspace = a.workspaces[0].id;
    const start = await f.call('/api/agent/requests', { body: { name: 'Local coding agent', scope: 'setup' } });
    const request = await start.json() as { deviceCode: string; userCode: string };
    expect((await f.call(`/api/agent/requests/${request.userCode}`, { userCookie, body: { workspaceId: b.workspaces[0].id, scope: 'setup' } })).status).toBe(404);
    expect((await f.call(`/api/agent/requests/${request.userCode}`, { userCookie, body: { workspaceId: workspace, scope: 'setup' } })).status).toBe(200);
    const result = await f.call('/api/agent/token', { body: { deviceCode: request.deviceCode } });
    const grant = await result.json() as { accessToken: string };
    const extra = { authorization: `Bearer ${grant.accessToken}` };
    expect((await f.call('/api/state', { extra })).status).toBe(200);
    expect((await f.call('/api/state', { workspace: b.workspaces[0].id, extra })).status).toBe(403);
    expect((await f.call('/api/teams', { body: { name: 'Forbidden' }, extra })).status).toBe(403);
    expect((await f.call('/api/missions/a/merge', { body: {}, extra })).status).toBe(403);
    expect((await f.call('/api/agent/token', { body: { deviceCode: request.deviceCode } })).status).toBe(410);
    const connections = await f.security.agents(alice.id);
    f.security.revokeAgent(alice.id, connections[0].id);
    expect((await f.call('/api/state', { extra })).status).toBe(401);
  });
  it('reports read-only capabilities for agents even when their approving user is an owner', async () => {
    const f = fixture(), a = privateTeam(f.directory, alice, 'A'), workspace = a.workspaces[0].id;
    const token = 'braid_agent_read_test';
    await f.security.issueAgent(await digest(token), { id: 'grant', user: alice, workspaceId: workspace, scope: 'read', label: 'Read-only agent', expires: Date.now() + 60_000 });
    const extra = { authorization: `Bearer ${token}` };
    const response = await f.call('/api/state', { extra });
    expect(response.status).toBe(200);
    expect((await response.json() as { capabilities: { canWrite: boolean } }).capabilities.canWrite).toBe(false);
    expect(f.calls[0].role).toBe('viewer');
    expect((await f.call('/api/context', { body: { title: 'Forbidden', body: 'No writes.' }, extra })).status).toBe(403);
  });
  it('limits local work grants to reads, checkout and submit, and strips forged connection headers', async () => {
    const setup = fixture(), team = privateTeam(setup.directory, alice, 'Local'), workspace = team.workspaces[0].id;
    const other = privateTeam(setup.directory, bob, 'Other').workspaces[0].id;
    const token = 'braid_agent_local_test', hash = await digest(token), expires = Date.now() + 60_000;
    await setup.security.issueAgent(hash, { id: 'local-connection', user: alice, workspaceId: workspace, scope: 'work', label: 'Local agent', expires });
    const extra = { authorization: `Bearer ${token}`, 'x-braid-connection': 'forged', 'x-braid-connection-digest': 'forged-digest', 'x-braid-connection-expires': '9999999999999' };
    for (const path of ['/api/state', '/api/repository', '/api/missions/task/integration', '/api/missions/task/diff']) expect((await setup.call(path, { extra })).status).toBe(200);
    for (const operation of ['checkout', 'submit', 'progress', 'update']) expect((await setup.call(`/api/missions/task/agents/atlas/${operation}`, { body: {}, extra })).status).toBe(200);
    const headers = setup.forwardedHeaders.at(-1)!;
    expect(headers.get('x-braid-connection')).toBe('local-connection');
    expect(headers.get('x-braid-connection-digest')).toBe(hash);
    expect(headers.get('x-braid-connection-expires')).toBe(String(expires));
    for (const path of ['/api/project', '/api/project/import/retry', '/api/missions', '/api/context', '/api/missions/task/merge', '/api/missions/task/resolve', '/api/missions/task/cancel', '/api/missions/task/finish', '/api/teams'])
      expect((await setup.call(path, { body: {}, extra })).status).toBe(403);
    expect((await setup.call('/api/export', { extra })).status).toBe(403);
    expect((await setup.call('/api/missions/task/agents/atlas/submit', { body: {}, workspace: other, extra })).status).toBe(403);
    const userCookie = await setup.login(alice);
    expect((await setup.call('/api/state', { workspace, userCookie, extra: { 'x-braid-connection': 'forged', 'x-braid-connection-digest': hash } })).status).toBe(200);
    expect(setup.forwardedHeaders.at(-1)!.get('x-braid-connection')).toBeNull();
    expect(setup.forwardedHeaders.at(-1)!.get('x-braid-connection-digest')).toBeNull();
    await setup.security.revokeAgent(alice.id, 'local-connection');
    expect((await setup.call('/api/missions/task/agents/atlas/submit', { body: {}, extra })).status).toBe(401);
  });
  it.each(['setup', 'read', 'work', 'fleet'] as const)('allows %s connections to retry imports under the same scope as creation', async scope => {
    const f = fixture(), team = privateTeam(f.directory, alice, 'Imports'), workspaceId = team.workspaces[0].id;
    const token = `braid_agent_import_${scope}`;
    await f.security.issueAgent(await digest(token), { id: `grant-${scope}`, user: alice, workspaceId, scope, label: 'Importer', expires: Date.now() + 60_000 });
    const extra = { authorization: `Bearer ${token}` };
    const expected = scope === 'setup' ? 200 : 403;
    expect((await f.call('/api/project', { body: {}, extra })).status).toBe(expected);
    expect((await f.call('/api/project/import/retry', { body: {}, extra })).status).toBe(expected);
  });
  it('requires current owner membership for local work and disallows permission upgrades during approval', async () => {
    const setup = fixture(), team = privateTeam(setup.directory, alice, 'Local'), workspace = team.workspaces[0].id;
    await setup.directory.accept(bob, (await setup.directory.invite(alice.id, team.id, { email: bob.email, role: 'owner' })).token);
    const userCookie = await setup.login(bob);
    const request = await (await setup.call('/api/agent/requests', { body: { name: 'Local coder', scope: 'work' } })).json() as { userCode: string; deviceCode: string };
    expect((await setup.call(`/api/agent/requests/${request.userCode}`, { userCookie, body: { workspaceId: workspace, scope: 'setup' } })).status).toBe(400);
    expect((await setup.call(`/api/agent/requests/${request.userCode}`, { userCookie, body: { workspaceId: workspace, scope: ['work'] } })).status).toBe(400);
    expect((await setup.call(`/api/agent/requests/${request.userCode}`, { userCookie, body: { workspaceId: workspace, scope: 'work' } })).status).toBe(200);
    const grant = await (await setup.call('/api/agent/token', { body: { deviceCode: request.deviceCode } })).json() as { scope: string; accessToken: string };
    expect(grant.scope).toBe('work');
    expect(Date.parse((grant as { expiresAt?: string }).expiresAt!)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const extra = { authorization: `Bearer ${grant.accessToken}` };
    setup.directory.removeMember(alice.id, team.id, bob.id);
    await setup.directory.accept(bob, (await setup.directory.invite(alice.id, team.id, { email: bob.email, role: 'member' })).token);
    expect((await setup.call('/api/missions/task/agents/atlas/checkout', { body: {}, extra })).status).toBe(403);
    const downgrade = await (await setup.call('/api/agent/requests', { body: { name: 'Inspect only', scope: 'work' } })).json() as { userCode: string; deviceCode: string };
    expect((await setup.call(`/api/agent/requests/${downgrade.userCode}`, { userCookie: await setup.login(alice), body: { workspaceId: workspace, scope: 'read' } })).status).toBe(200);
    const readonly = await (await setup.call('/api/agent/token', { body: { deviceCode: downgrade.deviceCode } })).json() as { scope: string; accessToken: string };
    expect(readonly.scope).toBe('read');
    expect((await setup.call('/api/missions/task/agents/atlas/checkout', { body: {}, extra: { authorization: `Bearer ${readonly.accessToken}` } })).status).toBe(403);
  });
  it('serves a local guide without reflecting unsafe query parameters', async () => {
    const setup = fixture();
    const response = await setup.call('/local-agents.md?mission=mission-test&agent=atlas');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const guide = await response.text();
    expect(guide).toContain('start "https://braid.example/tasks/mission-test?agent=atlas"');
    expect(guide).toContain('/cli/braid.mjs');
    expect(guide).toContain('Your connection cannot merge');
    const unsafe = await (await setup.call('/local-agents.md?mission=%24%28touch%20injected%29&agent=%60injected%60')).text();
    expect(unsafe).not.toContain('injected');
    expect(unsafe).toContain('start "TASK_URL"');
  });
});
describe('CI statuses', () => {
  it('answers a status report with the Trunk\'s refusal, or 201 once it is kept', async () => {
    const f = fixture(), report = vi.fn(async () => ({ ok: false as const, status: 401, error: 'The signature does not match the webhook secret.' }));
    f.env.TRUNKS = { getByName: () => ({ report }) } as unknown as BraidEnv['TRUNKS'];
    const post = (key: string) => f.call(`/api/statuses/${base64url.encode(key)}/${'a'.repeat(40)}`, { body: { state: 'success', context: 'ci/test' } });
    const unknown = await post('not a repository key');
    expect([unknown.status, (await unknown.json() as { error: string }).error]).toEqual([400, 'Unknown repository or oversized status.']);
    const refused = await post('team:t:repository:w');
    expect([refused.status, (await refused.json() as { error: string }).error]).toEqual([401, 'The signature does not match the webhook secret.']);
    report.mockResolvedValueOnce({ ok: true } as never);
    const kept = await post('team:t:repository:w');
    expect([kept.status, await kept.json()]).toEqual([201, { ok: true }]);
    expect(report).toHaveBeenCalledWith('team:t:repository:w', 'a'.repeat(40), JSON.stringify({ state: 'success', context: 'ci/test' }), null);
  });
});

describe('evidence images and the owners of work', () => {
  it('lets a plain <img> name its repository in the query, authorized by the session as before', async () => {
    const f = fixture(), team = privateTeam(f.directory, alice, 'A'), workspace = team.workspaces[0].id;
    const other = privateTeam(f.directory, bob, 'B').workspaces[0].id;
    const shards: string[] = [];
    Object.assign(f.env, { CHANGES: { getByName: (name: string) => ({ image: async () => { shards.push(name); return { ok: true, data: { type: 'image/png', bytes: new Uint8Array([0x89, 0x50]) } }; } }) }, TRUNKS: { getByName: () => ({}) } });
    const userCookie = await f.login(alice), image = `/api/changes/ch_1aaaaaaaaaaaa/evidence/${'a'.repeat(64)}.png`;
    const shown = await f.call(`${image}?workspace=${workspace}`, { userCookie });
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(shards).toEqual([`team:${team.id}:repository:${workspace}#changes:1`]);
    // The query only selects a repository the session may already read; the header still wins, and nothing else reads the query.
    expect((await f.call(`${image}?workspace=${other}`, { userCookie })).status).toBe(404);
    expect((await f.call(`${image}?workspace=${other}`, { userCookie, workspace })).status).toBe(200);
    expect((await f.call(image, { userCookie })).status).toBe(400);
    expect((await f.call(`/api/changes?workspace=${workspace}`, { userCookie })).status).toBe(400);
    expect((await f.call(`${image}?workspace=${workspace}`)).status).toBe(404);
  });

  it('names the person behind a change by the GitHub account they signed in with', async () => {
    const f = fixture(), team = privateTeam(f.directory, alice, 'A'), workspace = team.workspaces[0].id;
    const submitted: { actor: Actor }[] = [];
    Object.assign(f.env, { CHANGES: { getByName: () => ({ submit: async (context: { actor: Actor }) => { submitted.push(context); return { ok: true, data: { id: 'ch_1aaaaaaaaaaaa', number: 1 } }; } }) }, TRUNKS: { getByName: () => ({}) } });
    f.security.recordGitHubIdentity(alice.id, { id: 7, login: 'alice-gh' }, 'sign-in');
    // Connecting another GitHub account for repositories does not replace the one she signed in with.
    f.security.recordGitHubIdentity(alice.id, { id: 8, login: 'alice-work' }, 'connection');
    const userCookie = await f.login(alice);
    expect((await f.call('/api/changes', { userCookie, workspace, body: { title: 'x' }, extra: { 'idempotency-key': 'person-request-key-0001' } })).status).toBe(201);
    expect(submitted[0].actor).toEqual({ kind: 'owner', id: 'user:alice', name: alice.name, owner: { id: 'user:alice', publicId: f.directory.publicPerson(alice.id), name: 'Alice', email: '7+alice-gh@users.noreply.github.com', github: 'alice-gh' } });
    // Without a GitHub account, the owner has a name and no address.
    f.security.disconnectGitHub(bob.id);
    expect(f.security.githubIdentity(bob.id)).toBeNull();
  });
});

describe('sign-in boundaries', () => {
  afterEach(() => vi.restoreAllMocks());
  it('accepts the GitHub callback issuer and creates a revocable session without exposing the provider token', async () => {
    const setup = fixture();
    const start = await setup.call('/api/auth/github');
    expect(start.status).toBe(302);
    const login = new URL(start.headers.get('location')!);
    const state = login.searchParams.get('state')!;
    const browserCookie = start.headers.get('set-cookie')!.split(';')[0];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        const parameters = new URLSearchParams(options?.body as URLSearchParams);
        expect(parameters.get('client_id')).toBe(setup.env.GITHUB_CLIENT_ID);
        expect(parameters.get('client_secret')).toBe(setup.env.GITHUB_CLIENT_SECRET);
        expect(parameters.get('code')).toBe('test-authorization-code');
        expect(parameters.get('redirect_uri')).toBe('https://braid.example/api/auth/github/callback');
        expect(await digest(parameters.get('code_verifier')!)).toBe(Buffer.from(login.searchParams.get('code_challenge')!, 'base64url').toString('hex'));
        return Response.json({ access_token: 'test-provider-token', token_type: 'bearer', scope: 'read:user,user:email' });
      }
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-provider-token');
      expect(options?.redirect).toBe('manual');
      if (url === 'https://api.github.com/user') return Response.json({ id: 123, login: 'octocat', name: 'Octocat' });
      if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'octocat@example.com', verified: true, primary: true }]);
      throw new Error('Unexpected provider request.');
    });
    const callback = `/api/auth/github/callback?code=test-authorization-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent('https://github.com/login/oauth')}`;
    const response = await setup.call(callback, { userCookie: browserCookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://braid.example/');
    const setCookies = response.headers.getSetCookie();
    const sessionCookie = setCookies.find(value => value.startsWith('__Host-braid-session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Secure');
    expect(setCookies.find(value => value.startsWith('__Host-braid-oauth='))).toContain('Max-Age=0');
    expect(JSON.stringify(setCookies)).not.toContain('test-provider-token');
    expect(await response.text()).not.toContain('test-provider-token');
    const userCookie = sessionCookie.split(';')[0];
    const account = await (await setup.call('/api/account', { userCookie })).json() as { user: AccountIdentity };
    expect(account.user).toMatchObject({ email: 'octocat@example.com', name: 'Octocat' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await setup.call(callback, { userCookie: browserCookie })).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await setup.call('/api/session', { method: 'DELETE', userCookie });
    expect((await (await setup.call('/api/account', { userCookie })).json() as { user: AccountIdentity | null }).user).toBeNull();
  });
  it('rejects a different callback issuer before exchanging the authorization code', async () => {
    const setup = fixture();
    const start = await setup.call('/api/auth/github');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const userCookie = start.headers.get('set-cookie')!.split(';')[0];
    const fetcher = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await setup.call(`/api/auth/github/callback?code=test-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent('https://untrusted.example')}`, { userCookie });
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('rejects profile redirects without following them or creating a session', async () => {
    const setup = fixture();
    const start = await setup.call('/api/auth/github');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const userCookie = start.headers.get('set-cookie')!.split(';')[0];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'secret-provider-token', token_type: 'bearer', scope: 'read:user,user:email' });
      expect(options?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/profile' } });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await setup.call(`/api/auth/github/callback?code=test-code&state=${encodeURIComponent(state)}`, { userCookie });
    expect(response.status).toBe(502);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('secret-provider-token');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects unverified provider email and never exposes upstream credentials', async () => {
    expect(() => githubProfile({ id: 1, login: 'a' }, [{ email: 'a@example.com', primary: true, verified: false }])).toThrow(/Verify/);
    const f = fixture();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.env.ASSETS = { fetch: () => { throw new Error('secret-token-from-upstream'); } } as unknown as Fetcher;
    const result = await f.call('/');
    expect(await result.text()).not.toContain('secret-token');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-token'); spy.mockRestore();
  });
  it('requires a matching browser state before exchanging an OAuth code', async () => {
    const f = fixture(), fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await f.call('/api/auth/github/callback?code=forged&state=forged');
    expect(response.status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
  it('answers repeated sign-ins and connection requests with 429 and the time left in their budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const f = fixture(), request = () => f.call('/api/agent/requests', { body: { name: 'Codex', scope: 'work' } });
      for (let attempt = 0; attempt < 10; attempt++) expect((await request()).status).toBe(201);
      const flooded = await request();
      expect([flooded.status, flooded.headers.get('retry-after')]).toEqual([429, '3600']);
      expect(await flooded.json()).toMatchObject({ error: 'Too many connection requests. Wait the Retry-After interval before requesting another connection.' });
      f.env.AUTH_MODE = 'owner-key';
      const signIn = () => f.call('/api/session', { body: { token: 'not-the-owner-key' } });
      for (let attempt = 0; attempt < 8; attempt++) expect((await signIn()).status).toBe(401);
      const refused = await signIn();
      expect([refused.status, refused.headers.get('retry-after')]).toEqual([429, '300']);
      expect(await refused.json()).toMatchObject({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
    } finally { vi.useRealTimers(); }
  });
});
describe('fleet-scale agent access', () => {
  it('mints short-lived per-agent tokens from a fleet connection and rechecks their repository permission on every request', async () => {
    const f = fixture(), team = privateTeam(f.directory, alice, 'Fleet'), workspace = team.workspaces[0].id;
    const submitted: { context: { actor: { id: string; name: string } }; body: unknown }[] = [];
    Object.assign(f.env, { CHANGES: { getByName: () => ({ submit: async (context: never, body: unknown) => { submitted.push({ context, body }); return { ok: true, data: { id: 'ch_1aaaaaaaaaaaa', number: 1 } }; } }) },
      TRUNKS: { getByName: () => ({}) }, AGENT_LIMITER: { limit: vi.fn(async () => ({ success: true })) } });
    const fleetToken = 'braid_agent_fleet_test';
    await f.security.issueAgent(await digest(fleetToken), { id: 'fleet-grant', user: alice, workspaceId: workspace, scope: 'fleet', label: 'Nightly migration fleet', expires: Date.now() + 86_400_000 });
    // The fleet connection itself cannot act; it mints identities for its agents.
    expect((await f.call('/api/changes', { body: {}, extra: { authorization: `Bearer ${fleetToken}`, 'idempotency-key': 'k'.repeat(20) } })).status).toBe(403);
    expect((await f.call('/api/agent/session', { body: { name: 'bad\nname' }, extra: { authorization: `Bearer ${fleetToken}` } })).status).toBe(400);
    const session = await f.call('/api/agent/session', { body: { name: 'Worker 17', model: 'gpt-6-sol' }, extra: { authorization: `Bearer ${fleetToken}` } });
    expect(session.status).toBe(200);
    const minted = await session.json() as { accessToken: string; agent: { id: string; name: string }; expiresAt: string };
    expect(minted.agent).toEqual({ id: 'fleet:fleet-grant:worker-17', name: 'Worker 17' });
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const access = vi.spyOn(f.directory, 'access');
    const extra = { authorization: `Bearer ${minted.accessToken}` };
    expect((await f.call('/api/changes', { body: { title: 'x' }, extra: { ...extra, 'idempotency-key': 'fleet-request-key-0001' } })).status).toBe(201);
    // The agent carries its model, its fleet and the person who approved the fleet as the owner of its work.
    expect(submitted[0].context.actor).toEqual({ kind: 'agent', id: 'agent:fleet:fleet-grant:worker-17', name: 'Worker 17', model: 'gpt-6-sol', fleet: 'Nightly migration fleet', owner: { id: 'user:alice', publicId: f.directory.publicPerson(alice.id), name: 'Alice' } });
    expect((await f.call('/api/state', { extra })).status).toBe(200);
    expect(access).toHaveBeenCalledWith({ ...alice, username: null, avatarUrl: null }, team.workspaces[0].id, true);
    expect(access).toHaveBeenCalledWith({ ...alice, username: null, avatarUrl: null }, team.workspaces[0].id, false);
    // Access tokens never reach task checkouts or administration, and tampering is rejected.
    expect((await f.call('/api/missions/task/agents/atlas/submit', { body: {}, extra })).status).toBe(403);
    expect((await f.call('/api/teams', { body: { name: 'No' }, extra })).status).toBe(403);
    const [payload, signature] = minted.accessToken.slice('braid_at_'.length).split('.');
    const forged = `braid_at_${btoa(JSON.stringify({ ...JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))), team: 'other-team' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.${signature}`;
    expect((await f.call('/api/state', { extra: { authorization: `Bearer ${forged}` } })).status).toBe(401);
    // Each agent is throttled on its own identity.
    (f.env.AGENT_LIMITER!.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false });
    expect((await f.call('/api/state', { extra })).status).toBe(429);
    // Once Braid knows the approver's GitHub account, new agents name them by its no-reply address.
    f.security.recordGitHubIdentity(alice.id, { id: 4242, login: 'alice-gh' }, 'sign-in');
    const named = await (await f.call('/api/agent/session', { body: { name: 'Worker 19', model: 'claude-opus-5-5' }, extra: { authorization: `Bearer ${fleetToken}` } })).json() as { accessToken: string };
    expect((await f.call('/api/changes', { body: { title: 'y' }, extra: { authorization: `Bearer ${named.accessToken}`, 'idempotency-key': 'fleet-request-key-0002' } })).status).toBe(201);
    expect(submitted[1].context.actor).toMatchObject({ model: 'claude-opus-5-5', owner: { id: 'user:alice', name: 'Alice', email: '4242+alice-gh@users.noreply.github.com', github: 'alice-gh' } });
    // Revoking the connection stops new tokens immediately.
    f.security.revokeAgent(alice.id, 'fleet-grant');
    expect((await f.call('/api/agent/session', { body: { name: 'Worker 18' }, extra: { authorization: `Bearer ${fleetToken}` } })).status).toBe(401);
  });
});

const anonymousReads = [
  '/api/state', '/api/repository/tree', '/api/repository?path=README.md', '/api/repository?path=README.md&download=1',
  '/api/changes', '/api/changes/ch_1aaaaaaaaaaaa', '/api/changes/ch_1aaaaaaaaaaaa/diff?path=README.md',
  '/api/changes/ch_1aaaaaaaaaaaa/compare?since=1', `/api/changes/ch_1aaaaaaaaaaaa/evidence/${'a'.repeat(64)}.png`,
  '/api/blame?path=README.md', `/api/provenance?commits=${'b'.repeat(40)}`, '/api/agents', '/api/policy', '/api/instructions',
  '/api/queue', '/api/coordination?paths=README.md', '/api/coordination/hot', '/api/missions', '/api/missions/mission-1',
  '/api/missions/mission-1/integration', '/api/missions/mission-1/diff?agent=atlas&path=README.md', '/api/tasks', '/api/tasks/mission-1',
];
const sensitiveReads = ['/api/hooks', '/api/export', '/api/swarm', '/api/queue/landing', '/api/changes/checkout',
  '/api/repository/credentials', '/api/missions/mission-1/agents/atlas/checkout', '/api/missions/export', '/api/tasks/export', '/api/unknown', '/api/instructions/rule'];
const anonymousWrites = [
  ['POST', '/api/project'], ['POST', '/api/project/import/retry'], ['POST', '/api/missions'], ['POST', '/api/missions/mission-1/merge'], ['POST', '/api/missions/mission-1/resolve'],
  ['POST', '/api/missions/mission-1/agents/atlas/checkout'], ['POST', '/api/missions/mission-1/agents/atlas/submit'],
  ['POST', '/api/missions/mission-1/agents/atlas/progress'], ['POST', '/api/missions/mission-1/agents/atlas/update'],
  ['POST', '/api/changes'], ['POST', '/api/changes/checkout'], ['POST', '/api/changes/ch_1aaaaaaaaaaaa/revisions'],
  ['POST', '/api/changes/ch_1aaaaaaaaaaaa/reviews'], ['POST', '/api/changes/ch_1aaaaaaaaaaaa/approve'],
  ['POST', '/api/changes/ch_1aaaaaaaaaaaa/revert'], ['POST', '/api/changes/ch_1aaaaaaaaaaaa/close'],
  ['POST', '/api/instructions'], ['DELETE', '/api/instructions/rule'], ['POST', '/api/queue/landing'], ['POST', '/api/swarm'],
  ['POST', '/api/swarm/stop'], ['PUT', '/api/hooks'], ['DELETE', '/api/hooks'], ['POST', '/api/context'], ['POST', '/api/reset'],
  ['PATCH', '/api/state'], ['DELETE', '/api/state'],
] as const;
function publicFixture() {
  const f = fixture(), team = organizationWithRepository(f.directory, alice, 'Public team', 'public'), workspace = team.workspaces[0].id;
  const info = { checks: [], name: 'A readable result', owner: { name: 'Alice', email: alice.email }, actor: alice.email };
  Object.assign(f.env, {
    CHANGES: { getByName: () => ({ list: async () => ({ items: [], counts: { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 } }),
      get: async () => ({ ok: true, data: info }), diff: async () => ({ ok: true, data: { before: 'before', after: 'after' } }),
      compare: async () => ({ ok: true, data: { revision: 2, since: 1, files: [] } }),
      image: async () => ({ ok: true, data: { type: 'image/png', bytes: new Uint8Array([0x89, 0x50]) } }), agentStats: async () => [] }) },
    TRUNKS: { getByName: () => ({ publicChecks: async () => false, status: async () => info, publicPolicy: async () => ({ ok: true, data: info }), publicInstructions: async () => ({ ok: true, data: info }), policy: async () => info, instructions: async () => info,
      blame: async () => ({ ok: true, data: { ...info, path: 'README.md', ref: 'a'.repeat(40), lines: 0, ranges: [] } }), provenance: async () => [info], agentLines: async () => ({}), stackViews: async () => ({}), occupiedShards: async () => null, recordShards: async () => {} }) },
    PATHS: { getByName: () => ({ touching: async () => ({ 'README.md': [] }), hot: async () => [] }) },
  });
  return { ...f, team, workspace };
}
describe('anonymous public repository gateway', () => {
  it.each(anonymousReads.flatMap(path => ['GET', 'HEAD'].map(method => ({ path, method }))))('serves $method $path in live mode', async ({ path, method }) => {
    const f = publicFixture(), response = await f.call(path, { workspace: f.workspace, method });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    if (method === 'HEAD') expect(await response.text()).toBe('');
    else if (path === '/api/state') expect(await response.json()).toMatchObject({ capabilities: { mode: 'live', canWrite: false, authenticated: false } });
    if (f.calls.length) expect(f.calls[0]).toMatchObject({ workspace: `team:${f.team.id}:repository:${f.workspace}`, mode: 'live', role: 'viewer' });
  });
  it.each(sensitiveReads.flatMap(path => ['GET', 'HEAD'].map(method => ({ path, method }))))('refuses sensitive $method $path before accessing a workspace', async ({ path, method }) => {
    const f = publicFixture();
    expect((await f.call(path, { workspace: f.workspace, method })).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it.each(anonymousWrites)('refuses %s %s before accessing a workspace', async (method, path) => {
    const f = publicFixture();
    expect((await f.call(path, { workspace: f.workspace, method, body: {} })).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it.each(anonymousReads.flatMap(path => ['POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ path, method }))))('refuses $method on public read $path', async ({ method, path }) => {
    const f = publicFixture();
    expect((await f.call(path, { workspace: f.workspace, method, body: {} })).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it.each([...anonymousReads.flatMap(path => [['GET', path] as const, ['HEAD', path] as const]), ...sensitiveReads.flatMap(path => [['GET', path] as const, ['HEAD', path] as const]), ...anonymousWrites])('conceals a private repository for %s %s', async (method, path) => {
    const f = publicFixture();
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.workspace, visibility: 'private' });
    const existing = await f.call(path, { workspace: f.workspace, method, ...(['GET', 'HEAD'].includes(method) ? {} : { body: {} }) });
    const unknown = await f.call(path, { workspace: 'does-not-exist', method, ...(['GET', 'HEAD'].includes(method) ? {} : { body: {} }) });
    expect(existing.status).toBe(404); expect(unknown.status).toBe(404);
    if (method === 'HEAD') { expect(await existing.text()).toBe(''); expect(await unknown.text()).toBe(''); }
    else expect((await existing.json() as { error: string }).error).toBe((await unknown.json() as { error: string }).error);
    expect(f.calls).toHaveLength(0);
  });
  it('gives nonmembers only public reads while members keep their normal permissions', async () => {
    const f = publicFixture(), outsider = await f.login(bob);
    const response = await f.call('/api/state', { workspace: f.workspace, userCookie: outsider });
    expect(await response.json()).toMatchObject({ capabilities: { mode: 'live', canWrite: false, authenticated: false } });
    expect((await f.call('/api/hooks', { workspace: f.workspace, userCookie: outsider })).status).toBe(403);
    expect((await f.call('/api/missions', { workspace: f.workspace, userCookie: outsider, body: {} })).status).toBe(403);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'member' })).token);
    const member = await f.call('/api/state', { workspace: f.workspace, userCookie: outsider });
    expect(await member.json()).toMatchObject({ capabilities: { identity: { id: bob.id }, canWrite: false } });
    expect((await f.call('/api/missions', { workspace: f.workspace, userCookie: outsider, body: {} })).status).toBe(403);
    const owner = await f.call('/api/state', { workspace: f.workspace, userCookie: await f.login(alice) });
    expect(await owner.json()).toMatchObject({ capabilities: { canWrite: true, identity: { id: alice.id } } });
  });
  it('serves evidence query selection, strips forged headers, and retains the IP rate limit', async () => {
    const f = publicFixture(), image = `/api/changes/ch_1aaaaaaaaaaaa/evidence/${'a'.repeat(64)}.png`;
    expect((await f.call(`${image}?workspace=${f.workspace}`)).status).toBe(200);
    expect((await f.call('/api/state?workspace=does-not-exist')).status).toBe(401);
    const extra = { 'x-braid-role': 'owner', 'x-braid-mode': 'demo', 'x-braid-user-id': alice.id, 'x-braid-owner': 'forged', 'x-braid-team': 'forged', 'x-braid-connection': 'forged' };
    expect((await f.call('/api/state', { workspace: f.workspace, extra })).status).toBe(200);
    const forwarded = f.forwardedHeaders.at(-1)!;
    expect(forwarded.get('x-braid-role')).toBe('viewer'); expect(forwarded.get('x-braid-mode')).toBe('live');
    for (const key of ['owner', 'team', 'connection', 'user-id']) expect(forwarded.has(`x-braid-${key}`)).toBe(false);
    f.env.IP_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    expect((await f.call('/api/state', { workspace: f.workspace })).status).toBe(429);
  });
  it('keeps account, member, invitation, audit, connection and GitHub setup data private', async () => {
    const f = publicFixture();
    for (const path of [`/api/teams/${f.team.id}/members`, `/api/teams/${f.team.id}/audit`, `/api/teams/${f.team.id}/invites`,
      '/api/agent/connections', '/api/github/connection', '/api/github/repositories', '/api/github/installations'])
      expect((await f.call(path, { workspace: f.workspace })).status, path).toBe(path.endsWith('/invites') ? 404 : 401);
    expect(await (await f.call('/api/account')).json()).toMatchObject({ user: null, organizations: [] });
    for (const [method, path] of [['POST', `/api/teams/${f.team.id}/invites`], ['DELETE', `/api/teams/${f.team.id}/members/alice`],
      ['PATCH', `/api/teams/${f.team.id}/workspaces/${f.workspace}`], ['POST', '/api/teams'], ['POST', '/api/github/connect'], ['DELETE', '/api/agent/connections/connection']])
      expect((await f.call(path, { workspace: f.workspace, method, body: method === 'PATCH' ? { visibility: 'private' } : { name: 'Forbidden', email: 'third@example.test', role: 'owner' } })).status, path).toBe(401);
  });
  it('preserves published Git paths and policy guard settings while removing actual credentials', async () => {
    const f = publicFixture(), path = 'contacts/alice@example.com';
    const tree = { ref: 'b'.repeat(40), path: 'contacts', entries: [{ name: 'alice@example.com', path, kind: 'file' }], nextCursor: null };
    f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => Response.json(new URL(request.url).pathname.endsWith('/tree')
      ? tree : { path, content: 'Published Git content', kind: 'text' }) }) } as unknown as BraidEnv['WORKSPACES'];
    expect(await (await f.call('/api/repository/tree', { workspace: f.workspace })).json()).toEqual(tree);
    expect(await (await f.call(`/api/repository?path=${encodeURIComponent(path)}`, { workspace: f.workspace })).json()).toMatchObject({ path, content: 'Published Git content' });
    f.env.TRUNKS = { getByName: () => ({ publicPolicy: async () => ({ ok: true, data: { policy: { guards: { secrets: 'revise', dependencies: 'attention' } }, artifactsToken: 'fixture-credential' } }) }) } as unknown as BraidEnv['TRUNKS'];
    expect(await (await f.call('/api/policy', { workspace: f.workspace })).json()).toEqual({ policy: { guards: { secrets: 'revise', dependencies: 'attention' } } });
  });
  it('omits account emails, private connection metadata, and credentials from public JSON', async () => {
    const f = publicFixture();
    f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({
      capabilities: { mode: 'live', authenticated: true, canWrite: true, identity: alice },
      project: { remote: 'https://artifacts.example/repo', name: 'Public' }, files: { 'cache.ts': 'private cached data' },
      missions: [{ owner: alice, authorization: { user: alice }, token: 'artifacts-credential', webhookUrl: 'https://ci.example/private-hook',
        activity: `Submitted by ${alice.email}`, remote: 'https://username:password@git.example/repo' }],
    }) }) } as unknown as BraidEnv['WORKSPACES'];
    const result = await f.call('/api/state', { workspace: f.workspace }), content = await result.text();
    for (const secret of [alice.email, 'artifacts-credential', 'private-hook', 'username:password', 'private cached data']) expect(content).not.toContain(secret);
    const snapshot = JSON.parse(content);
    expect(snapshot.capabilities).toEqual({ mode: 'live', authenticated: false, canWrite: false });
    expect(snapshot.files).toEqual({});
    const detail = await (await f.call('/api/changes/ch_1aaaaaaaaaaaa', { workspace: f.workspace })).text();
    expect(detail).not.toContain(alice.email);
  });
});

describe('repository address and owner editing API', () => {
  it('answers exact addresses and discovery shapes, includes account fields, and parses paging', async () => {
    const f = publicFixture(), repo = f.team.workspaces[0], path = `/api/repos/${f.team.slug}/${repo.slug}`;
    expect(await (await f.call(path)).json()).toEqual({ workspaceId: f.workspace, owner: { slug: f.team.slug, name: f.team.name, kind: 'organization' }, repo: { slug: repo.slug, name: repo.name }, visibility: 'public', canWrite: false });
    const userCookie = await f.login(alice);
    expect(await (await f.call(path, { userCookie })).json()).toMatchObject({ canWrite: true });
    expect(await (await f.call('/api/account', { userCookie })).json()).toMatchObject({ organizations: [{ slug: f.team.slug, workspaces: [{ slug: repo.slug, visibility: 'public' }] }] });
    const second = f.directory.createWorkspace(alice.id, f.team.id, 'Second', 'public');
    // Discovery lists repositories with commits.
    for (const id of [f.workspace, second.id]) f.directory.repositoryImported(id, true, undefined, true);
    const first = await (await f.call('/api/repos?limit=1')).json() as { items: unknown[]; nextCursor: string };
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTypeOf('string');
    const last = await (await f.call(`/api/repos?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as { items: unknown[]; nextCursor: string | null };
    expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
    for (const query of ['limit=0', 'limit=101', 'limit=1.2', 'limit=bad', 'cursor=bad']) expect((await f.call(`/api/repos?${query}`)).status).toBe(400);
  });
  it('allows owner PATCH only, parses its body, hides private addresses and preserves renamed addresses', async () => {
    const f = publicFixture(), repo = f.team.workspaces[0], path = `/api/teams/${f.team.id}/workspaces/${f.workspace}`;
    const owner = await f.login(alice), outsider = await f.login(bob);
    expect((await f.call(path, { method: 'PATCH', body: { visibility: 'private' } })).status).toBe(401);
    expect((await f.call(path, { userCookie: outsider, method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'member' })).token);
    expect((await f.call(path, { userCookie: outsider, method: 'PATCH', body: { name: 'X' } })).status).toBe(403);
    for (const body of [{}, { slug: 'INVALID' }, { slug: 'a--b' }, { visibility: 'hidden' }, { name: '' }, { typo: true }])
      expect((await f.call(path, { userCookie: owner, method: 'PATCH', body })).status).toBe(400);
    const patched = await f.call(path, { userCookie: owner, method: 'PATCH', body: { visibility: 'private', slug: 'renamed', name: 'Renamed' } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ...repo, visibility: 'private', slug: 'renamed', name: 'Renamed' });
    expect(await (await f.call(`/api/repos/${f.team.slug}/${repo.slug}`, { userCookie: owner })).json()).toMatchObject({ workspaceId: f.workspace, repo: { slug: 'renamed' } });
    const hidden = await f.call(`/api/repos/${f.team.slug}/renamed`), missing = await f.call(`/api/repos/${f.team.slug}/unknown`);
    expect(hidden.status).toBe(404); expect(missing.status).toBe(404); expect(hidden.headers.get('location')).toBeNull();
    expect((await hidden.json() as { error: string }).error).toBe((await missing.json() as { error: string }).error);
    expect((await f.call('/api/repos/Public/INVALID')).status).toBe(404);
    expect((await f.call('/api/repos/%ZZ/invalid')).status).toBe(404);
    expect(await (await f.call(`/api/repos/${f.team.slug}/renamed`, { userCookie: outsider })).json()).toMatchObject({ visibility: 'private', canWrite: false });
  });
});
