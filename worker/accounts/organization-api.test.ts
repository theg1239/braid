import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unoccupiedGitHubNames } from '../test/github-names';
beforeEach(() => { unoccupiedGitHubNames(); });
afterEach(() => vi.restoreAllMocks());
import api from '../http/api';
import { Directory } from './directory';
import { Security } from './security';
import { storageFixture } from '../test/storage';
import { digest, sessionToken } from '../http/auth';
import { mintAccess } from '../http/agent-token';
import type { BraidEnv } from '../env';
import type { AccountIdentity, Organization, TeamDetail } from '../../shared/account';
// Capture the gateway passed to the unchanged change engine; Directory and session checks are real.
vi.mock('../changes/router', () => ({ changesRoute: async (_request: Request, _env: unknown, gateway: { role: string }) => Response.json({ role: gateway.role }) }));
const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' };
const bob = { id: 'bob', email: 'bob@example.com', name: 'Bob' };
async function fixture() {
  const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
  const store = storageFixture(), security = new Security(store.ctx, {} as BraidEnv);
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', SESSION_SECRET: 'organizations-session-secret-for-testing-only', PUBLIC_ORIGIN: 'https://braid.example',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => Response.json({ role: request.headers.get('x-braid-role') }) }) },
  } as unknown as BraidEnv;
  const login = async (user: AccountIdentity) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, user); return `__Host-braid-session=${token}`; };
  const cookie = await login(alice), memberCookie = await login(bob);
  const call = (path: string, options: { method?: string; body?: unknown; cookie?: string; workspace?: string; bearer?: string } = {}) => api.fetch(new Request(`https://braid.example${path}`, { method: options.method ?? (options.body ? 'POST' : 'GET'), headers: {
    ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.workspace ? { 'x-braid-workspace': options.workspace } : {}), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}),
  }, body: options.body ? JSON.stringify(options.body) : undefined }), env);
  return { db, directory, security, env, cookie, memberCookie, call };
}
describe('organization API', () => {
  it.each(['/api/orgs', '/api/teams'])('creates an empty organization through %s', async path => {
    const f = await fixture();
    const response = await f.call(path, { cookie: f.cookie, body: { name: 'Acme' } });
    expect(response.status).toBe(201); const org = await response.json() as Organization; expect(org.workspaces).toEqual([]);
    const account = await (await f.call('/api/account', { cookie: f.cookie })).json() as { organizations: Organization[]; teams?: unknown };
    expect(account.organizations[0].id).toBe(org.id); expect(account.teams).toEqual(account.organizations);
    expect((await f.call(`/api/owners/${org.slug}`)).status).toBe(404);
    expect((await f.call(`/api/owners/${org.slug}`, { cookie: f.cookie })).status).toBe(200);
    expect((await f.call(`/api/teams/${org.id}`, { method: 'PATCH', cookie: f.cookie, body: { name: 'Renamed' } })).status).toBe(200);
  });
  it.each(['signed-in', 'visitor', 'owner-key'] as const)('serves the same organizations as teams to old tabs: %s', async mode => {
    const f = await fixture();
    const organization = f.directory.createOrganization(alice, 'Acme');
    const repository = f.directory.createWorkspace(alice.id, organization.id, 'App');
    if (mode === 'owner-key') f.env.AUTH_MODE = 'owner-key';
    const response = await f.call('/api/account', mode === 'signed-in' ? { cookie: f.cookie } : {});
    expect(response.status).toBe(200);
    const account = await response.json() as { organizations: Organization[]; teams: Organization[] };
    expect(account.teams).toEqual(account.organizations);
    if (mode === 'signed-in') expect(account.teams[0]).toMatchObject({ id: organization.id, workspaces: [{ id: repository.id }] });
    else expect(account.teams).toEqual([]);
  });
  it('validates names, addresses, team roles and repository permissions at the boundary', async () => {
    const f = await fixture(); const org = f.directory.createOrganization(alice, 'Acme');
    expect((await f.call('/api/orgs', { cookie: f.cookie, body: { name: '' } })).status).toBe(400);
    for (const slug of ['orgs', 'organizations']) expect((await f.call(`/api/orgs/${org.id}`, { cookie: f.cookie, method: 'PATCH', body: { slug } })).status).toBe(400);
    const root = `/api/orgs/${org.id}/teams`; const response = await f.call(root, { cookie: f.cookie, body: { name: 'Engineering', description: 'Build' } });
    expect(response.status).toBe(201); const detail = await response.json() as TeamDetail;
    for (const [path, body] of [[`${root}/${detail.team.id}/members/bob`, { role: 'owner' }], [`${root}/${detail.team.id}/repositories/repo`, { permission: 'admin' }]] as const) expect((await f.call(path, { method: 'PUT', cookie: f.cookie, body })).status).toBe(400);
    expect((await f.call(`${root}/${detail.team.slug}`, { cookie: f.cookie })).status).toBe(200);
    expect((await f.call(root)).status).toBe(401);
  });
  it.each(['/api/missions', '/api/changes/ch_123456789abcd/reviews', '/api/changes/ch_123456789abcd/approve', '/api/queue/landing', '/api/changes/ch_123456789abcd/comments'])('enforces current grants and forwards the effective role for %s', async path => {
    const f = await fixture(); const org = f.directory.createOrganization(alice, 'Acme'), repo = f.directory.createWorkspace(alice.id, org.id, 'App');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, org.id, { email: bob.email, role: 'member' })).token);
    const team = f.directory.createOrgTeam(alice.id, { orgId: org.id, name: 'Engineering' }).team, input = { orgId: org.id, teamId: team.id };
    const write = () => f.call(path, { cookie: f.memberCookie, workspace: repo.id, body: {} });
    expect((await write()).status).toBe(403);
    f.directory.setTeamMember(alice.id, { ...input, memberId: bob.id, role: 'member' });
    f.directory.setTeamRepository(alice.id, { ...input, workspaceId: repo.id, permission: 'read' }); expect((await write()).status).toBe(403);
    f.directory.setTeamRepository(alice.id, { ...input, workspaceId: repo.id, permission: 'write' });
    const response = await write(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ role: 'owner' });
    expect((await f.call(`/api/orgs/${org.id}/workspaces/${repo.id}`, { cookie: f.memberCookie, method: 'PATCH', body: { visibility: 'public' } })).status).toBe(403);
    f.directory.removeTeamRepository(alice.id, { ...input, workspaceId: repo.id }); expect((await write()).status).toBe(403);
  });
  it('rechecks grants for an already minted access token immediately after revocation', async () => {
    const f = await fixture(); const org = f.directory.createOrganization(alice, 'Acme'), repo = f.directory.createWorkspace(alice.id, org.id, 'App');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, org.id, { email: bob.email, role: 'member' })).token);
    const team = f.directory.createOrgTeam(alice.id, { orgId: org.id, name: 'Engineering' }).team, input = { orgId: org.id, teamId: team.id };
    f.directory.setTeamMember(alice.id, { ...input, memberId: bob.id, role: 'member' });
    f.directory.setTeamRepository(alice.id, { ...input, workspaceId: repo.id, permission: 'write' });
    const bearer = await mintAccess(f.env, { grant: 'grant', user: bob, workspace: repo.id, team: org.id, scope: 'work', agent: 'agent', name: 'Codex', exp: Date.now() + 120_000 });
    const write = () => f.call('/api/changes', { bearer, workspace: repo.id, body: {} });
    expect((await write()).status).toBe(200);
    f.directory.removeTeamRepository(alice.id, { ...input, workspaceId: repo.id });
    expect((await write()).status).toBe(403);
    const read = await f.call('/api/repository', { bearer, workspace: repo.id }); expect(await read.json()).toMatchObject({ role: 'viewer' });
  });
});
