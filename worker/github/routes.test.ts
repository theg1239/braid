import { organizationWithRepository } from '../test/organization';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import api from '../http/api';
import { Security } from '../accounts/security';
import { Directory } from '../accounts/directory';
import { Workspace } from '../workspace/workspace';
import type { BraidEnv } from '../env';
import { digest, sessionToken } from '../http/auth';
import { storageFixture } from '../test/storage';
import { githubImportSource, githubRepositoryForImport, githubRoute } from './routes';
import { githubApi, openGitHub } from './client';
import { installationToken, type GitHubLink } from './bridge';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const alice = { id: 'alice', name: 'Alice', email: 'alice@example.test' }, bob = { id: 'bob', name: 'Bob', email: 'bob@example.test' };
const repository = { id: 22, name: 'private-project', full_name: 'acme/private-project', private: true, default_branch: 'main' };
const selection = { installationId: 11, repositoryId: 22 };
const databases: ReturnType<typeof storageFixture>[] = [];
const storage = () => { const db = storageFixture(); databases.push(db); return db; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.db.close(); });
async function fixture() {
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', SESSION_SECRET: 'test-session-secret-for-github-at-least-32-characters', PUBLIC_ORIGIN: 'https://braid.example',
    GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'braid-test', GITHUB_APP_CLIENT_ID: 'app-client', GITHUB_APP_CLIENT_SECRET: 'app-client-secret',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  } as BraidEnv;
  const store = storage(), security = new Security(store.ctx, env), teams = storage(), directory = new Directory(teams.ctx, env);
  const team = organizationWithRepository(directory, alice, 'Acme'), workspaceId = team.workspaces[0].id;
  const repositoryStore = storage();
  const repo = { [Symbol.dispose]() {}, log: vi.fn(async () => [{ hash: 'a'.repeat(40) }]), info: vi.fn(async () => ({ remote: 'https://git.example/project', defaultBranch: 'main' })), revokeToken: vi.fn(async () => {}) };
  const artifacts = { get: vi.fn(async () => repo), import: vi.fn(async (_input: unknown) => ({ name: 'private-project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'artifacts-initial-secret' })) };
  Object.assign(env, { SECURITY: { idFromName: () => 'security', get: () => security }, DIRECTORY: { idFromName: () => 'directory', get: () => directory }, ARTIFACTS: artifacts,
    ASSETS: { fetch: () => new Response('asset') } });
  const workspace = new Workspace(repositoryStore.ctx, env); await repositoryStore.ready();
  env.WORKSPACES = { idFromName: () => 'workspace', get: () => workspace } as unknown as BraidEnv['WORKSPACES'];
  const token = await sessionToken(env.SESSION_SECRET), userCookie = `__Host-braid-session=${token}`;
  await security.issue(await digest(token), Date.now() + 86_400_000, alice);
  const call = (path: string, options: { method?: string; body?: unknown; cookie?: string; workspace?: string; headers?: Record<string, string> } = {}) => api.fetch(new Request(`https://braid.example${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'), headers: { cookie: options.cookie ?? userCookie, 'x-braid-workspace': options.workspace ?? workspaceId, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined,
  }), env);
  /** What GitHub lets Alice do in the selected repository. */
  const access = { push: true };
  const network = vi.fn(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-user-secret', token_type: 'bearer', expires_in: 28800, refresh_token: 'github-refresh-secret', refresh_token_expires_in: 15897600 });
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === '/user') return Response.json({ id: 1, login: 'alice' });
      if (url.pathname === '/user/installations') return Response.json({ installations: [{ id: 11, account: { login: 'acme', type: 'Organization' } }] });
      if (url.pathname === '/user/installations/11/repositories') return Response.json({ repositories: [repository] });
      if (url.pathname === '/repositories/22') return Response.json({ ...repository, permissions: { admin: false, maintain: false, push: access.push, pull: true } });
      if (url.pathname === '/repos/acme/private-project/installation') return Response.json({ id: 11, suspended_at: null });
      if (url.pathname === '/app/installations/11/access_tokens') {
        expect(JSON.parse(String(options?.body))).toEqual({ repository_ids: [22], permissions: { contents: 'read' } });
        const auth = new Headers(options?.headers).get('authorization')!.slice(7);
        const verified = await jwtVerify(auth, keys.publicKey, { issuer: env.GITHUB_APP_CLIENT_ID, algorithms: ['RS256'] });
        expect(verified.payload.exp! - verified.payload.iat!).toBe(600);
        return Response.json({ token: 'github-installation-secret', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (url.origin === 'https://github.com' && url.pathname.startsWith('/acme/private-project.git/')) {
      expect(options?.redirect).toBe('manual');
      const headers = new Headers(options?.headers);
      expect(headers.get('authorization')).toBe(`Basic ${btoa('x-access-token:github-installation-secret')}`);
      expect(headers.has('cookie')).toBe(false);
      return new Response('git-data', { headers: { 'content-type': url.pathname.endsWith('info/refs') ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result' } });
    }
    throw new Error('Unexpected provider URL');
  });
  vi.stubGlobal('fetch', network);
  const connect = () => security.connectGitHub(alice.id, { login: 'alice', accessToken: 'github-user-secret', expiresAt: Date.now() + 3_600_000 });
  return { env, security, store, directory, team, workspaceId, workspace, repositoryStore, artifacts, repo, token, userCookie, call, connect, network, access };
}

describe('GitHub repository connections', () => {
  it('derives link identities from the session and rejects a forged installation', async () => {
    const f = await fixture(); await f.connect();
    const linkGitHub = vi.fn(async () => ({ ok: true, data: { fullName: repository.full_name } }));
    f.env.TRUNKS = { getByName: () => ({ linkGitHub }) } as unknown as BraidEnv['TRUNKS'];
    f.env.GITHUB_REPOS = { getByName: () => ({ link: vi.fn() }) } as unknown as BraidEnv['GITHUB_REPOS'];
    const body = { ...selection, mode: 'pull-requests', pusher: bob.id, authorization: { user: bob, workspaceId: 'foreign', teamId: 'foreign' } };
    const linked = await f.call('/api/github/link', { body, headers: { 'x-braid-user-id': bob.id, 'x-braid-owner': encodeURIComponent(JSON.stringify(bob)) } });
    expect(linked.status).toBe(201);
    expect(linkGitHub).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pusher: alice.id,
      authorization: expect.objectContaining({ user: expect.objectContaining({ id: alice.id }), workspaceId: f.workspaceId, teamId: f.team.id }) }));
    linkGitHub.mockClear();
    expect((await f.call('/api/github/link', { body: { ...body, installationId: 99 } })).status).toBe(403);
    expect(linkGitHub).not.toHaveBeenCalled();
  });

  it.each(['read', 'work', 'setup', 'fleet'] as const)('does not let a %s agent connection establish a GitHub link', async scope => {
    const f = await fixture(); await f.connect();
    const token = `braid_agent_fixture_${scope}`;
    await f.security.issueAgent(await digest(token), { id: `agent-${scope}`, user: alice, workspaceId: f.workspaceId, scope, label: 'Fixture agent', expires: Date.now() + 60_000 });
    expect((await f.call('/api/github/link', { body: { ...selection, mode: 'mirror' }, headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(f.network).not.toHaveBeenCalled();
  });

  it.each([false, true])('revokes a linked App token when its Braid owner is removed (write=%s)', async write => {
    const f = await fixture(); await f.connect();
    const link: GitHubLink = { ...selection, fullName: repository.full_name, defaultBranch: 'main', mode: 'pull-requests', linkedBy: 'Alice', linkedAt: new Date().toISOString(),
      pusher: alice.id, authorization: { user: alice, workspaceId: f.workspaceId, teamId: f.team.id } };
    const upstream = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, options) => String(input).endsWith('/access_tokens')
      ? Response.json({ token: 'fixture-linked-app', expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : upstream(input, options));
    await installationToken(f.env, link, write);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'owner' })).token);
    f.directory.removeMember(bob.id, f.team.id, alice.id);
    // Alice's GitHub access is still good. A different Braid owner must not retain her authority through the link.
    f.network.mockClear();
    await expect(installationToken(f.env, link, write)).rejects.toMatchObject({ status: 403 });
    expect(f.network).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'Alice Example', username: 'alice', expected: '@alice' },
    { name: 'alice@example.test', username: 'alice', expected: '@alice' },
    { name: 'alice@example.test', username: null, expected: 'alice' },
  ])('stores the public account handle on a live GitHub link for $name / $username', async ({ name, username, expected }) => {
    const f = await fixture(); await f.connect();
    const linkGitHub = vi.fn(async () => ({ ok: true, data: { fullName: repository.full_name } }));
    f.env.TRUNKS = { getByName: () => ({ linkGitHub }) } as unknown as BraidEnv['TRUNKS'];
    f.env.GITHUB_REPOS = { getByName: () => ({ link: vi.fn() }) } as unknown as BraidEnv['GITHUB_REPOS'];
    const response = await githubRoute(new Request('https://braid.example/api/github/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, mode: 'pull-requests' }) }), f.env, { ...alice, name, username }, f.workspaceId);
    expect(response.status).toBe(201);
    expect(linkGitHub).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ linkedBy: expected }));
  });

  it('unlinks the webhook route by the repository id the link stored, after a rename and while landing refuses', async () => {
    const f = await fixture(); await f.connect();
    const unlinkGitHub = vi.fn(async () => ({ ok: true, data: { repositoryId: 22 } }));
    // The repository was renamed on GitHub since it was linked, so its stored name no longer resolves.
    const githubLink = vi.fn(async () => ({ fullName: 'acme/old-name' }));
    const unlink = vi.fn(), repos = vi.fn(() => ({ unlink }));
    f.env.TRUNKS = { getByName: () => ({ unlinkGitHub, githubLink }) } as unknown as BraidEnv['TRUNKS'];
    f.env.GITHUB_REPOS = { getByName: repos } as unknown as BraidEnv['GITHUB_REPOS'];
    const remove = () => githubRoute(new Request('https://braid.example/api/github/link', { method: 'DELETE' }), f.env, alice, f.workspaceId);
    expect((await remove()).status).toBe(200);
    expect(repos).toHaveBeenCalledWith('github-repo:22');
    expect(unlink).toHaveBeenCalledOnce();
    unlinkGitHub.mockResolvedValueOnce({ ok: false, status: 409, error: 'A batch is landing through GitHub. Wait for it to finish.' } as never);
    await expect(remove()).rejects.toMatchObject({ status: 409, message: 'A batch is landing through GitHub. Wait for it to finish.' });
  });

  it('links a repository only for someone GitHub lets push to it, never on the strength of the App installation', async () => {
    const f = await fixture(); await f.connect();
    const linkGitHub = vi.fn(async () => ({ ok: true, data: { fullName: repository.full_name } }));
    f.env.TRUNKS = { getByName: () => ({ linkGitHub }) } as unknown as BraidEnv['TRUNKS'];
    f.env.GITHUB_REPOS = { getByName: () => ({ link: vi.fn() }) } as unknown as BraidEnv['GITHUB_REPOS'];
    const link = (mode: string) => githubRoute(new Request('https://braid.example/api/github/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, mode }) }), f.env, alice, f.workspaceId);
    // Alice can read the repository, as anyone can read a public one, but GitHub does not let her push to it.
    f.access.push = false;
    for (const mode of ['pull-requests', 'mirror']) await expect(link(mode)).rejects.toMatchObject({ status: 403, message: 'Linking needs your push access to acme/private-project on GitHub.' });
    expect(linkGitHub).not.toHaveBeenCalled();
    expect(f.network.mock.calls.some(([input]) => String(input).includes('/access_tokens'))).toBe(false);
    f.access.push = true;
    expect((await link('mirror')).status).toBe(201);
    expect(linkGitHub).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pusher: alice.id }));
  });
  it('binds one-time PKCE authorization to its browser, active Braid session and workspace owner', async () => {
    const f = await fixture();
    const start = await f.call('/api/github/connect', { body: {} });
    expect(start.status).toBe(200);
    const target = new URL((await start.json() as { url: string }).url), cookie = start.headers.get('set-cookie')!.split(';')[0];
    expect(target.origin).toBe('https://github.com'); expect(target.searchParams.get('scope')).toBeNull();
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = `/api/github/callback?code=test-code&state=${target.searchParams.get('state')}&iss=https://github.com/login/oauth`;
    expect((await f.call(callback, { cookie: 'wrong=browser' })).status).toBe(400);
    const complete = await f.call(callback, { cookie });
    expect(complete.status).toBe(303);
    expect(complete.headers.get('location')).toContain(`workspace=${f.workspaceId}`);
    expect(complete.headers.get('location')).not.toContain('secret');
    const exchange = f.network.mock.calls.find(([url]) => String(url).endsWith('/access_token'))!;
    const body = exchange[1]!.body as URLSearchParams;
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('redirect_uri')).toBe('https://braid.example/api/github/callback');
    expect((await f.call(callback, { cookie })).status).toBe(400);
    const status = await (await f.call('/api/github/connection')).json();
    expect(status).toEqual({ configured: true, connected: true, login: 'alice' });
    const stored = f.store.db.prepare('SELECT value FROM github_connections').get()!.value as string;
    expect(stored).not.toContain('secret');
    await expect(openGitHub(f.env, 'user:bob', stored)).rejects.toThrow();
  });
  it.each(['logout', 'removed', 'issuer'])('refuses callback after %s without retaining provider credentials', async reason => {
    const f = await fixture();
    const start = await f.call('/api/github/connect', { body: {} });
    const target = new URL((await start.json() as { url: string }).url), cookie = start.headers.get('set-cookie')!.split(';')[0];
    if (reason === 'logout') f.security.revoke(await digest(f.token));
    if (reason === 'removed') {
      await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'owner' })).token);
      f.directory.removeMember(bob.id, f.team.id, alice.id);
    }
    const response = await f.call(`/api/github/callback?code=code&state=${target.searchParams.get('state')}${reason === 'issuer' ? '&iss=https://evil.example' : ''}`, { cookie });
    expect(response.status).toBe(reason === 'logout' ? 401 : reason === 'removed' ? 404 : 400);
    expect(await f.security.githubConnection(alice.id)).toBeNull();
    expect(f.network).not.toHaveBeenCalled();
  });
  it('lists only user-accessible installations and repositories and handles paging', async () => {
    const f = await fixture(); await f.connect();
    expect(await (await f.call('/api/github/installations')).json()).toEqual({ items: [{ id: 11, account: 'acme', kind: 'Organization' }], nextPage: null });
    expect(await (await f.call('/api/github/repositories?installationId=11')).json()).toEqual({ items: [{ id: 22, name: repository.name, fullName: repository.full_name, private: true, defaultBranch: 'main' }], nextPage: null });
    expect((await f.call('/api/github/repositories?installationId=99')).status).toBe(403);
    expect((await f.call('/api/github/repositories?installationId=11&page=-1')).status).toBe(400);
    f.network.mockResolvedValueOnce(Response.json({ repositories: Array.from({ length: 100 }, (_, index) => ({ ...repository, id: index + 1 })) }));
    expect((await (await f.call('/api/github/repositories?installationId=11')).json() as { nextPage: number }).nextPage).toBe(2);
  });
  it('checks owner membership for connection reads and writes', async () => {
    const f = await fixture(); await f.connect();
    const foreign = organizationWithRepository(f.directory, bob, 'Other').workspaces[0].id;
    expect((await f.call('/api/github/connection', { cookie: '' })).status).toBe(401);
    expect((await f.call('/api/github/connection', { workspace: foreign })).status).toBe(404);
    expect((await f.call('/api/github/connect', { body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'member' })).token);
    const token = await sessionToken(f.env.SESSION_SECRET); await f.security.issue(await digest(token), Date.now() + 60_000, bob);
    expect((await f.call('/api/github/connection', { cookie: `__Host-braid-session=${token}` })).status).toBe(403);
  });
  it('treats installation callback IDs as untrusted and supports pending organization approval', async () => {
    const f = await fixture(); await f.connect();
    const start = await f.call('/api/github/install', { body: {} });
    const target = new URL((await start.json() as { url: string }).url), cookie = start.headers.get('set-cookie')!.split(';')[0];
    expect(target.pathname).toBe('/apps/braid-test/installations/new');
    const result = await f.call(`/api/github/installed?installation_id=99999&setup_action=request&state=${target.searchParams.get('state')}`, { cookie });
    expect(result.status).toBe(303); expect(result.headers.get('location')).toContain('github=pending');
    expect((await f.call('/api/github/repositories?installationId=99999')).status).toBe(403);
  });
  it('refreshes once for concurrent readers and preserves a disconnect during refresh', async () => {
    const f = await fixture();
    await f.security.connectGitHub(alice.id, { login: 'alice', accessToken: 'expired', expiresAt: 0, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 60_000 });
    const results = await Promise.all([f.security.githubAccessToken(alice.id), f.security.githubAccessToken(alice.id)]);
    expect(results).toEqual([{ ok: true, token: 'github-user-secret' }, { ok: true, token: 'github-user-secret' }]);
    expect(f.network).toHaveBeenCalledTimes(1);
    await f.security.connectGitHub(alice.id, { login: 'alice', accessToken: 'expired', expiresAt: 0, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 60_000 });
    let complete!: (response: Response) => void, started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    f.network.mockImplementationOnce(() => { started(); return new Promise(resolve => { complete = resolve; }); });
    const refreshing = f.security.githubAccessToken(alice.id); await pending;
    f.security.disconnectGitHub(alice.id);
    complete(Response.json({ access_token: 'new-secret', token_type: 'bearer', expires_in: 28800 }));
    expect((await refreshing).ok).toBe(false); expect(await f.security.githubConnection(alice.id)).toBeNull();
  });
  it('forgets revoked user authorization and never follows provider redirects', async () => {
    const f = await fixture(); await f.connect();
    f.network.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await f.call('/api/github/installations')).status).toBe(409);
    expect(await f.security.githubConnection(alice.id)).toBeNull();
    f.network.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    await expect(githubApi('/user', 'provider-secret')).rejects.toThrow('GitHub could not complete');
    expect(f.network.mock.calls.at(-1)![1]?.redirect).toBe('manual');
  });
});

describe('GitHub imports', () => {
  it.each(['github', 'membership', 'missing identity'] as const)('stops pending-import previews after revoking %s access, even with a cached App token', async revoked => {
    const f = await fixture(); await f.connect();
    f.repo.log.mockResolvedValue([]);
    let readable = true, content = 'before revocation';
    const upstream = f.network.getMockImplementation()!;
    const contents = vi.fn(async () => Response.json({ type: 'file', sha: 'c'.repeat(40), size: content.length, encoding: 'base64', content: btoa(content) }));
    f.network.mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === '/repositories/22' && !readable) return Response.json({ message: 'Not Found' }, { status: 404 });
      if (url.pathname === '/repos/acme/private-project/contents/README.md') return contents();
      if (url.pathname === '/repos/acme/private-project/contents') return Response.json([{ name: 'README.md', path: 'README.md', sha: 'c'.repeat(40), type: 'file' }]);
      return upstream(input, options);
    });
    expect((await f.call('/api/project', { body: { name: 'private-project', github: selection } })).status).toBe(202);
    expect(await (await f.call('/api/repository?path=README.md')).json()).toMatchObject({ content });
    content = 'new private content after revocation';
    contents.mockClear();
    let cookie = f.userCookie;
    if (revoked === 'github') readable = false;
    else if (revoked === 'membership') {
      await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'owner' })).token);
      f.directory.removeMember(bob.id, f.team.id, alice.id);
      const session = await sessionToken(f.env.SESSION_SECRET);
      await f.security.issue(await digest(session), Date.now() + 60_000, bob);
      cookie = `__Host-braid-session=${session}`;
    } else {
      const pending = await f.repositoryStore.storage.get<Record<string, unknown>>('pending-project');
      delete pending!.authorization;
      await f.repositoryStore.storage.put('pending-project', pending);
    }
    for (const path of ['/api/repository?path=README.md', '/api/repository/tree?path=']) {
      const response = await f.call(path, { cookie });
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(content);
    }
    expect(contents).not.toHaveBeenCalled();
  });

  it('keeps private import access alive for background completion and revokes it afterward', async () => {
    const f = await fixture(); await f.connect();
    // Still copying: the copy's HEAD, which is the selected branch, has no commit yet.
    f.repo.log.mockResolvedValueOnce([]);
    const response = await f.call('/api/project', { body: { name: 'private-project', github: selection } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ importing: { name: 'private-project', source: 'acme/private-project', startedAt: expect.any(String) } });
    expect(f.repo.log).toHaveBeenCalledTimes(1); expect(f.repo.revokeToken).not.toHaveBeenCalled();
    const source = (f.artifacts.import.mock.calls[0][0] as { source: { url: string; depth: number } }).source;
    expect(source.depth).toBe(1);
    expect((await api.fetch(new Request(`${source.url}/info/refs?service=git-upload-pack`), f.env)).status).toBe(200);
    const pendingSnapshot = await (await f.call('/api/state')).text();
    expect(pendingSnapshot).not.toContain('secret'); expect(pendingSnapshot).not.toContain('/api/github/import/');
    const setupToken = 'braid_agent_setup_import_retry';
    await f.security.issueAgent(await digest(setupToken), { id: 'setup', user: alice, workspaceId: f.workspaceId, scope: 'setup', label: 'Setup', expires: Date.now() + 60_000 });
    expect((await f.call('/api/project/import/retry', { body: {}, headers: { authorization: `Bearer ${setupToken}` } })).status).toBe(403);
    await f.repositoryStore.storage.deleteAlarm(); await f.workspace.alarm();
    const state = await (await f.call('/api/state')).json() as { project: { id: string }; importing?: unknown };
    expect(state.project.id).toBeTruthy(); expect(state).not.toHaveProperty('importing');
    expect(f.directory.list(alice)[0].workspaces[0].visibility).toBe('private');
    expect(await f.workspace.publicationMetadata()).toMatchObject({ sourcePublic: false });
    expect(f.repo.revokeToken).toHaveBeenCalledWith('artifacts-initial-secret');
    expect(await f.repositoryStore.storage.get('pending-project')).toBeUndefined();
    expect((await api.fetch(new Request(`${source.url}/info/refs?service=git-upload-pack`), f.env)).status).toBe(401);
  });
  it('imports a private selected repository through an expiring read-only stream without exposing credentials', async () => {
    const f = await fixture(); await f.connect();
    let source = '';
    f.artifacts.import.mockImplementationOnce(async (input: unknown) => {
      source = (input as { source: { url: string } }).source.url;
      expect(source).toMatch(/^https:\/\/braid.example\/api\/github\/import\/[a-zA-Z0-9_-]{43}\/repository.git$/);
      const advertisement = await api.fetch(new Request(`${source}/info/refs?service=git-upload-pack`), f.env);
      expect(advertisement.status).toBe(200); expect(await advertisement.text()).toBe('git-data');
      const pack = await api.fetch(new Request(`${source}/git-upload-pack`, { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request', cookie: 'must-not-forward' }, body: 'git-request' }), f.env);
      expect(pack.status).toBe(200); expect(await pack.text()).toBe('git-data');
      return { name: 'private-project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'artifacts-initial-secret' };
    });
    const response = await f.call('/api/project', { body: { name: 'private-project', github: selection } });
    expect(response.status).toBe(201);
    expect(f.directory.list(alice)[0].workspaces[0].visibility).toBe('private');
    expect(await f.workspace.publicationMetadata()).toMatchObject({ sourcePublic: false });
    const snapshot = await (await f.call('/api/state')).text();
    const exported = await (await f.call('/api/export')).text();
    for (const content of [snapshot, exported, JSON.stringify(f.store.db.prepare('SELECT value FROM github_connections').all())]) {
      expect(content).not.toContain('secret'); expect(content).not.toContain('/api/github/import/');
    }
    expect((await api.fetch(new Request(`${source}/info/refs?service=git-upload-pack`), f.env)).status).toBe(401);
  });
  it('retains a public GitHub source answer while honoring an explicit private choice', async () => {
    const f = await fixture(); await f.connect();
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.workspaceId, visibility: 'private' });
    const upstream = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, options) => String(input) === 'https://api.github.com/repositories/22'
      ? Response.json({ ...repository, private: false }) : upstream(input, options));
    expect((await f.call('/api/project', { body: { name: 'private-project', github: selection } })).status).toBe(201);
    expect(await f.workspace.publicationMetadata()).toMatchObject({ sourcePublic: true });
    expect(f.directory.list(alice)[0].workspaces[0].visibility).toBe('private');
  });
  it('forces privacy if a public source becomes private during its import stream', async () => {
    const f = await fixture(); await f.connect();
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.workspaceId, visibility: 'public' });
    let isPrivate = false;
    const upstream = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, options) => String(input) === 'https://api.github.com/repositories/22'
      ? Response.json({ ...repository, private: isPrivate }) : upstream(input, options));
    f.artifacts.import.mockImplementationOnce(async input => {
      isPrivate = true;
      const source = (input as { source: { url: string } }).source.url;
      const response = await api.fetch(new Request(`${source}/info/refs?service=git-upload-pack`), f.env);
      expect(response.status).toBe(200);
      expect(f.directory.list(alice)[0].workspaces[0].visibility).toBe('private');
      return { name: 'private-project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'artifacts-initial-secret' };
    });
    // The stream outlasts the moment Braid waits, so the request is answered and the copy finishes in the background.
    expect((await f.call('/api/project', { body: { name: 'private-project', github: selection } })).status).toBe(202);
    await f.repositoryStore.settled();
    await f.repositoryStore.storage.deleteAlarm(); await f.workspace.alarm();
    expect(f.directory.list(alice)[0].workspaces[0].visibility).toBe('private');
    expect(await f.workspace.publicationMetadata()).toMatchObject({ sourcePublic: false });
  }, 15000);
  it('shows a GitHub import\'s files from GitHub while Artifacts copies them, then reads its own copy', async () => {
    const f = await fixture(); await f.connect();
    let finish!: () => void;
    f.artifacts.import.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ name: 'private-project', remote: 'https://git.example/project', defaultBranch: 'main', token: 'artifacts-initial-secret' });
    }));
    const upstream = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/acme/private-project/contents' && url.searchParams.get('ref') === 'main')
        return Response.json([{ name: 'README.md', path: 'README.md', sha: 'c'.repeat(40), size: 10, type: 'file' }, { name: 'src', path: 'src', sha: 'b'.repeat(40), size: 0, type: 'dir' }]);
      if (url.pathname === '/repos/acme/private-project/contents/README.md' && url.searchParams.get('ref') === 'main')
        return Response.json({ type: 'file', sha: 'c'.repeat(40), size: 10, encoding: 'base64', content: btoa('# Private\n') });
      return upstream(input, options);
    });
    const response = await f.call('/api/project', { body: { name: 'private-project', github: selection } });
    expect(response.status).toBe(202);
    expect((await response.json() as { importing: unknown }).importing).toMatchObject({ source: 'acme/private-project', branch: 'main', preview: true });
    expect(await (await f.call('/api/repository/tree?path=')).json()).toMatchObject({ ref: 'main', entries: [{ name: 'src', kind: 'dir', mode: '40000' }, { name: 'README.md', kind: 'file' }] });
    expect(await (await f.call('/api/repository?path=README.md')).json()).toMatchObject({ content: '# Private\n', kind: 'text', ref: 'main', path: 'README.md' });
    // The finished import publishes at once, without waiting for the alarm, then revokes its initial token.
    finish(); await f.repositoryStore.settled();
    const state = await (await f.call('/api/state')).json() as { project: { id: string }; importing?: unknown };
    expect(state.project.id).toBeTruthy(); expect(state).not.toHaveProperty('importing');
    await f.repositoryStore.settled();
    expect(await f.repositoryStore.storage.get('pending-project')).toBeUndefined();
    expect(f.repo.revokeToken).toHaveBeenCalledWith('artifacts-initial-secret');
  }, 15000);
  it('rejects forged selections and owner setup connections before creating an import', async () => {
    const f = await fixture(); await f.connect();
    expect((await f.call('/api/project', { body: { name: 'project', github: { ...selection, installationId: 99 } } })).status).toBe(403);
    expect((await f.call('/api/project', { body: { name: 'project', github: [selection] } })).status).toBe(400);
    expect(f.artifacts.import).not.toHaveBeenCalled(); expect(await f.repositoryStore.storage.get('pending-project')).toBeUndefined();
    const token = 'braid_agent_setup_github';
    await f.security.issueAgent(await digest(token), { id: 'setup', user: alice, workspaceId: f.workspaceId, scope: 'setup', label: 'Setup', expires: Date.now() + 60_000 });
    expect((await f.call('/api/project', { body: { name: 'project', github: selection }, headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
  });
  it('refuses receive-pack, other paths, expired capabilities and revoked membership', async () => {
    const f = await fixture(); await f.connect();
    const repo = await githubRepositoryForImport(f.env, alice, selection);
    const source = await githubImportSource(f.env, alice, f.workspaceId, selection, repo);
    const inspect = (path: string, method = 'GET') => api.fetch(new Request(`${source}/${path}`, { method }), f.env);
    expect((await inspect('info/refs?service=git-receive-pack')).status).toBe(405);
    expect((await inspect('git-receive-pack', 'POST')).status).toBe(404);
    expect((await inspect('objects/abc')).status).toBe(404);
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'owner' })).token);
    f.directory.removeMember(bob.id, f.team.id, alice.id);
    expect((await inspect('info/refs?service=git-upload-pack')).status).toBe(404);
    f.security.finishGitHubImports(f.workspaceId);
    expect((await inspect('info/refs?service=git-upload-pack')).status).toBe(401);
  });
});
