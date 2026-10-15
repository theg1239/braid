import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import { seedWorkspace } from '../workspace/seed';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import { digest, sessionToken } from '../http/auth';
import { concat, FLUSH, pktLine } from '../git/transport';
import { githubClaimProof, publicMirrorSource, privateMirrorRepository, mirrorEndpoint, mirrorTransfer, MIRROR_ACCESS_MS, MIRROR_PRIVATE_ACCESS_MS, MIRROR_NETWORK_LIMIT, MIRROR_DAILY_LIMIT, MIRROR_ADVERTISEMENT_BYTES, MIRROR_PACK_BYTES, MIRROR_TOTAL_BYTES, MIRROR_NAMESPACE_CHANGED } from './mirrors';
import { repositoryAddress } from '../schemas';
import { RESERVED_OWNERS } from '../../shared/routes';
import type { AccountIdentity } from '../../shared/account';
import type { BraidEnv } from '../env';

const head = 'a'.repeat(40);
const alice = { id: 'github:101', email: 'alice@example.test', name: 'Alice' };
const bob = { id: 'github:202', email: 'bob@example.test', name: 'Bob' };
const databases: ReturnType<typeof storageFixture>[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { await db.settled(); db.db.close(); }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function advertised() {
  return new Response(concat([pktLine('# service=git-upload-pack\n'), FLUSH,
    pktLine(`${head} HEAD\0symref=HEAD:refs/heads/main\n`), pktLine(`${head} refs/heads/main\n`), FLUSH]),
  { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
}
function fixture() {
  const cache = edgeCache();
  const db = storageFixture(), securityDb = storageFixture(); databases.push(db, securityDb);
  const profiles = new Map([[alice.id, { id: 101, login: 'alice', type: 'User' }], [bob.id, { id: 202, login: 'bob', type: 'User' }]]);
  const state = { visible: true, organizationRole: 'admin', organizationState: 'active', organizationId: 303, privateName: 'alice/private', privateReaders: new Set<string>() };
  const workspace = { readMirror: vi.fn(async () => {}), stopMirror: vi.fn(async () => ({ ok: true })), resumeMirror: vi.fn(async () => {}), repository: vi.fn(async () => null),
    fetch: vi.fn(async () => Response.json({ content: 'fixture mirrored content', ref: head, path: 'secret.txt', kind: 'text' })) };
  const env = { AUTH_MODE: 'github', SESSION_SECRET: 'mirror-review-fixture-secret-123456789', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example',
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    PUBLIC_EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    DIRECTORY: { idFromName: (n: string) => n, get: () => directory },
    SECURITY: { idFromName: (n: string) => n, get: () => security }, WORKSPACES: { idFromName: (n: string) => n, get: () => workspace, getByName: () => workspace },
  } as unknown as BraidEnv;
  const directory = new Directory(db.ctx, env), security = new Security(securityDb.ctx, env);
  vi.spyOn(security, 'githubIdentity').mockImplementation(id => profiles.get(id) ?? null);
  vi.spyOn(security, 'githubConnection').mockImplementation(async id => profiles.has(id) ? { login: profiles.get(id)!.login, connectedAt: '' } : null);
  vi.spyOn(security, 'githubAccessToken').mockImplementation(async id => ({ ok: true, token: `fixture-${id}` }));
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://github.com' && url.pathname.endsWith('/info/refs')) {
      expect(init?.redirect).toBe('manual');
      const auth = new Headers(init?.headers).get('authorization');
      const person = auth?.startsWith('Basic ') ? atob(auth.slice(6)).replace('x-access-token:fixture-', '') : '';
      return state.visible || state.privateReaders.has(person) ? advertised() : new Response('', { status: 401 });
    }
    if (url.origin !== 'https://api.github.com') throw new Error(`Unexpected fixture origin: ${url.origin}`);
    const person = new Headers(init?.headers).get('authorization')?.replace('Bearer fixture-', '');
    if (url.pathname === '/user') return Response.json(profiles.get(person ?? ''));
    if (url.pathname.startsWith('/user/memberships/orgs/')) return Response.json({ role: state.organizationRole, state: state.organizationState,
      organization: { id: state.organizationId, login: url.pathname.split('/').at(-1), type: 'Organization' } });
    if (url.pathname.startsWith('/users/')) return Response.json([...profiles.values()].find(profile => profile.login === url.pathname.split('/').at(-1)) ?? { id: state.organizationId, login: url.pathname.split('/').at(-1), type: 'Organization' });
    if (url.pathname.startsWith('/repos/') || url.pathname.startsWith('/repositories/')) {
      if (!state.visible && !state.privateReaders.has(person ?? '')) return Response.json({ message: 'Not Found' }, { status: 404 });
      if (url.pathname.startsWith('/repos/')) state.privateName = url.pathname.slice(7);
      const owner = state.privateName.split('/')[0];
      return Response.json({ id: 404, full_name: state.privateName, name: state.privateName.split('/')[1], private: !state.visible, size: 128, default_branch: 'main', disabled: false,
        owner: [...profiles.values()].find(profile => profile.login === owner) ?? { id: state.organizationId, login: owner, type: 'Organization' } });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', network);
  const request = async (path: string, user?: AccountIdentity, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    if (user) {
      const token = await sessionToken(env.SESSION_SECRET);
      await security.issue(await digest(token), Date.now() + 60_000, user);
      headers = { ...headers, cookie: `__Host-braid-session=${token}` };
    }
    return api.fetch(new Request(`https://braid.example${path}`, { ...init, headers: { 'cf-connecting-ip': '198.51.100.8', ...headers } }), env);
  };
  return { db, security, directory, env, state, profiles, network, workspace, request, cache };
}
function requireMirror(result: Awaited<ReturnType<Directory['resolveMirror']>>) {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe('mirror security review: address and anonymous probe boundary', () => {
  it.each(['%2f', '%5c', '%252f', '..', '.', 'alice@evil.test', 'a?b', 'a#b', '%00', '%0d%0a', 'аlice', 'a／b', 'a。b', 'a'.repeat(101)])('rejects hostile owner/repository input %s before fetch', async value => {
    const f = fixture();
    for (const pair of [{ owner: value, repo: 'repo' }, { owner: 'alice', repo: value }]) {
      expect(v.safeParse(repositoryAddress, pair).success).toBe(false);
      const segment = (value: string) => value.replaceAll('?', '%3f').replaceAll('#', '%23');
      const answer = await f.request(`/api/repos/${segment(pair.owner)}/${segment(pair.repo)}`);
      expect(answer.status).not.toBe(200);
    }
    expect(f.network).not.toHaveBeenCalled();
  });
  it('allows dots/underscores in a repository but keeps them in one GitHub path segment', async () => {
    const f = fixture();
    const input = v.parse(repositoryAddress, { owner: 'ALICE', repo: '.config_repo.git' });
    expect(input).toEqual({ owner: 'alice', repo: '.config_repo.git' });
    await publicMirrorSource(f.env, `${input.owner}/${input.repo}`);
    expect(f.network.mock.calls[0][0]).toBe('https://github.com/alice/.config_repo.git.git/info/refs?service=git-upload-pack');
    expect(new Headers(f.network.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });
  it.each([301, 302, 307, 308])('never follows a %i source redirect', async status => {
    const f = fixture();
    f.network.mockResolvedValue(new Response('', { status, headers: { location: 'http://169.254.169.254/private' } }));
    await expect(publicMirrorSource(f.env, 'alice/repo')).rejects.toMatchObject({ status: 502 });
    expect(f.network).toHaveBeenCalledTimes(1);
    expect(f.network.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
  it('caps both declared and streaming ref advertisements', async () => {
    const f = fixture();
    f.network.mockResolvedValueOnce(new Response('oversized', { headers: { 'content-length': String(MIRROR_ADVERTISEMENT_BYTES + 1) } }));
    await expect(publicMirrorSource(f.env, 'alice/declared')).rejects.toMatchObject({ status: 413 });
    const cancel = vi.fn();
    f.network.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MIRROR_ADVERTISEMENT_BYTES + 1)); }, cancel }),
      { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }));
    await expect(publicMirrorSource(f.env, 'alice/chunked')).rejects.toMatchObject({ status: 413 }); expect(cancel).toHaveBeenCalled();
  });
  it('prevents every reserved owner from starting a mirror', async () => {
    const f = fixture();
    for (const owner of RESERVED_OWNERS) expect(await f.directory.resolveMirror(null, owner, 'repo', 'network')).toMatchObject({ ok: false });
    expect(f.network).not.toHaveBeenCalled();
  });
});

describe('mirror security review: claims, admission, and confidentiality', () => {
  it('S-01 charges refused/missing probes to the network budget before GitHub', async () => {
    const f = fixture(); f.state.visible = false;
    for (let n = 0; n < MIRROR_NETWORK_LIMIT; n++) expect(await f.directory.resolveMirror(null, 'alice', `missing-${n}`, 'network')).toMatchObject({ ok: false, status: 404 });
    f.network.mockClear();
    expect(await f.directory.resolveMirror(null, 'alice', 'one-too-many', 'network')).toMatchObject({ ok: false, status: 429 });
    expect(f.network).not.toHaveBeenCalled();
  });
  it('S-01 rejects an exhausted global budget before GitHub, across networks', async () => {
    const f = fixture();
    f.db.storage.sql.exec('INSERT INTO mirror_budgets VALUES (?, ?, ?)', 'global', MIRROR_DAILY_LIMIT, Date.now() + 86_400_000);
    expect(await f.directory.resolveMirror(null, 'alice', 'repo', 'new-network')).toMatchObject({ ok: false, status: 429 });
    expect(f.network).not.toHaveBeenCalled();
  });
  it('S-02 rejects a recycled GitHub login claiming the previous account private workspaces', async () => {
    const f = fixture();
    f.directory.account(alice, f.profiles.get(alice.id)!);
    expect(await f.directory.claimMirrorOwner(alice, 'alice')).toMatchObject({ ok: true });
    const original = f.directory.personalOwner(alice.id)!;
    const privateRepo = f.directory.createWorkspace(alice.id, original.id, 'Private work', 'private');
    f.profiles.set(alice.id, { id: 101, login: 'renamed-alice', type: 'User' });
    f.profiles.set(bob.id, { id: 202, login: 'alice', type: 'User' });
    f.directory.account(bob, f.profiles.get(bob.id)!);
    expect(await f.directory.claimMirrorOwner(bob, 'alice')).toMatchObject({ ok: false });
    expect(() => f.directory.authorize(bob.id, privateRepo.id, false)).toThrow();
    expect(f.directory.personalOwner(alice.id)?.id).toBe(original.id);
  });
  it('S-03 revalidates unclaimed mirrors for existing Braid members at the gateway', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    const org = f.directory.list(alice)[0];
    await f.directory.accept(bob, (await f.directory.invite(alice.id, org.id, { email: bob.email, role: 'member' })).token);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'acme', 'new-repo', 'network'));
    f.state.visible = false;
    await expect(publicMirrorSource(f.env, 'acme/new-repo', true)).rejects.toMatchObject({ status: 404 });
    const response = await f.request('/api/repository?path=secret.txt', bob, { 'x-braid-workspace': repo.workspaceId });
    expect(response.status).toBe(404);
    expect(f.workspace.fetch).not.toHaveBeenCalled();
  });
  it('S-02 rejects a recycled GitHub organization login granting access to the original private workspaces', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    const org = f.directory.list(alice)[0], privateRepo = f.directory.createWorkspace(alice.id, org.id, 'Confidential', 'private');
    f.state.organizationId = 404;
    expect.soft(await f.directory.claimMirrorOwner(bob, 'acme')).toMatchObject({ ok: false });
    expect(() => f.directory.authorize(bob.id, privateRepo.id, false)).toThrow();
  });
  it('S-07 refuses a new public mirror from a recycled login under an already claimed namespace', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    const original = f.directory.list(alice)[0];
    f.state.organizationId = 404; // The original organization renamed; a different organization now owns acme.
    const result = await f.directory.resolveMirror(null, 'acme', 'attacker-content', 'network');
    expect.soft(result).toMatchObject({ ok: false });
    expect(f.db.storage.sql.exec('SELECT m.workspace FROM mirrors m JOIN workspaces w ON w.id = m.workspace WHERE w.team_id = ?', original.id).toArray()).toEqual([]);
  });
  it('S-07 refuses an authenticated admission when the current owner ID differs from the pinned namespace', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    f.state.organizationId = 404;
    expect(await f.directory.resolveMirror(bob, 'acme', 'attacker-content', 'network')).toMatchObject({ ok: false });
  });
  it('S-07 rechecks the immutable owner ID at the background transfer boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'acme', 'repo', 'network'));
    const mirror = f.directory.mirrorRecord(repo.workspaceId)!;
    expect((await mirrorEndpoint(f.env, mirror, alice.id)).remote).toBe('https://github.com/acme/repo.git');
    f.state.organizationId = 404; // Same repo ID and spelling, but transferred to the recycled organization.
    vi.advanceTimersByTime(MIRROR_PRIVATE_ACCESS_MS + 1);
    await expect(mirrorEndpoint(f.env, mirror, alice.id)).rejects.toMatchObject({ status: 409, message: MIRROR_NAMESPACE_CHANGED });
    const restarted = new Directory(f.db.ctx, f.env);
    expect(restarted.mirrorRecord(repo.workspaceId)).toMatchObject({ importing: 0, error: MIRROR_NAMESPACE_CHANGED });
    expect(restarted.reserveMirrorBytes(repo.workspaceId, 1)).toBe(false);
  });
  it('refuses private imports for anonymous and unauthorized connected visitors without revealing existence', async () => {
    const f = fixture(); f.state.visible = false;
    expect(await f.directory.resolveMirror(null, 'alice', 'private', 'network')).toMatchObject({ ok: false, status: 404 });
    expect(await f.directory.resolveMirror(alice, 'alice', 'private', 'network')).toMatchObject({ ok: false, status: 404 });
    expect(f.db.storage.sql.exec('SELECT * FROM mirrors').toArray()).toHaveLength(0); expect(f.workspace.readMirror).not.toHaveBeenCalled();
  });
  it('fails closed after the public source lease expires, including cached files and UUID reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(), repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    const path = '/api/repository?path=secret.txt';
    expect((await f.request(path, undefined, { 'x-braid-workspace': repo.workspaceId })).status).toBe(200);
    f.state.visible = false; vi.advanceTimersByTime(MIRROR_ACCESS_MS + 6000); f.workspace.fetch.mockClear();
    expect((await f.request(path, undefined, { 'x-braid-workspace': repo.workspaceId })).status).toBe(404);
    expect(await f.directory.resolveRepository(null, 'alice', 'repo')).toMatchObject({ ok: false });
    expect(f.workspace.fetch).not.toHaveBeenCalled();
  });
  it('lists a public mirror in Explore only once its first copy is ready and without errors, and hides withdrawn mirrors from owner pages', async () => {
    const f = fixture(); const { workspaceId } = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    expect((await f.directory.publicRepositories(30)).items).toEqual([]);
    f.directory.mirrorUpdated(workspaceId, { syncedAt: new Date().toISOString(), importing: false });
    expect((await f.directory.publicRepositories(30)).items.map(item => `${item.owner.slug}/${item.repo.slug}`)).toEqual(['alice/repo']);
    f.directory.mirrorUpdated(workspaceId, { error: 'The GitHub mirror could not be prepared.' });
    expect((await f.directory.publicRepositories(30)).items).toEqual([]);
    f.directory.mirrorUpdated(workspaceId, { error: null });
    f.state.visible = false; await publicMirrorSource(f.env, 'alice/repo', true).catch(() => {});
    const page = await f.directory.mirrorOwnerRepositories(null, 'alice');
    expect(page.ok ? page.data.repositories : []).toEqual([]);
  });
  it.each([['member', 'active'], ['admin', 'pending']])('denies organization ownership to %s/%s', async (role, state) => {
    const f = fixture(); f.state.organizationRole = role; f.state.organizationState = state;
    expect(await githubClaimProof(f.env, alice, 'acme', true)).toMatchObject({ claimable: false });
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: false, status: 403 });
  });
  it('requires a fresh personal ID proof, and rejects mismatched connected identities', async () => {
    const f = fixture();
    expect(await githubClaimProof(f.env, alice, 'alice')).toMatchObject({ claimable: true });
    vi.spyOn(f.security, 'githubAccessToken').mockResolvedValue({ ok: true, token: `fixture-${bob.id}` });
    expect(await f.directory.claimMirrorOwner(alice, 'alice')).toMatchObject({ ok: false, status: 403 });
  });
  it('coalesces simultaneous creation and maintenance for one public mirror', async () => {
    const f = fixture();
    const answers = await Promise.all(Array.from({ length: 20 }, () => f.directory.resolveMirror(null, 'alice', 'repo', 'network')));
    expect(new Set(answers.map(answer => requireMirror(answer).workspaceId)).size).toBe(1);
    expect(f.network.mock.calls.filter(([url]) => String(url).includes('/info/refs'))).toHaveLength(1); expect(f.workspace.readMirror).toHaveBeenCalledTimes(1);
  });
  it('serializes competing organization admins and never adds a second first owner', async () => {
    const f = fixture();
    requireMirror(await f.directory.resolveMirror(null, 'acme', 'repo', 'network'));
    const results = await Promise.all([f.directory.claimMirrorOwner(alice, 'acme'), f.directory.claimMirrorOwner(bob, 'acme')]);
    expect(results).toEqual([{ ok: true, role: 'owner' }, { ok: false, status: 409, error: expect.any(String) }]);
    // A retry after the first claim may join the organization, but cannot become another owner.
    expect(await f.directory.claimMirrorOwner(bob, 'acme')).toEqual({ ok: true, role: 'member' });
    const org = f.directory.list(alice)[0];
    expect(f.db.storage.sql.exec<{ user_id: string }>("SELECT user_id FROM members WHERE team_id = ? AND role = 'owner'", org.id).toArray()).toEqual([{ user_id: alice.id }]);
  });
  it('S-04 a failed multi-repository claim leaves earlier mirrors able to sync', async () => {
    const f = fixture();
    const first = requireMirror(await f.directory.resolveMirror(null, 'acme', 'ready', 'network'));
    const second = requireMirror(await f.directory.resolveMirror(null, 'acme', 'importing', 'network'));
    const initialized = storageFixture(), importing = storageFixture(); databases.push(initialized, importing);
    const seed = seedWorkspace('live', { mode: 'live', artifacts: false, ai: false, storage: 'durable-object', authenticated: true, model: '', namespace: '', canWrite: false });
    await initialized.storage.put('workspace', { ...seed, project: { ...seed.project, id: 'mirror-ready', head } });
    await importing.storage.put('workspace', seed);
    const ready = new Workspace(initialized.ctx, f.env), pending = new Workspace(importing.ctx, f.env);
    await Promise.all([initialized.ready(), importing.ready()]);
    f.env.WORKSPACES = { getByName: (name: string) => name.endsWith(first.workspaceId) ? ready : pending } as unknown as BraidEnv['WORKSPACES'];
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: false, status: 409 });
    expect(f.directory.mirrorRecord(first.workspaceId)?.enabled).toBe(0);
    expect(f.directory.mirrorRecord(second.workspaceId)?.enabled).toBe(0);
    expect(await initialized.storage.get('mirror-stopped')).not.toBe(true);
  });
  it('S-05 honors Braid privacy after a public source mirror is claimed and made private', async () => {
    const f = fixture(), repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    expect(await f.directory.claimMirrorOwner(alice, 'alice')).toMatchObject({ ok: true });
    const owner = f.directory.personalOwner(alice.id)!;
    f.directory.updateWorkspace(alice.id, { teamId: owner.id, workspaceId: repo.workspaceId, visibility: 'private' });
    expect.soft(await f.directory.resolveRepository(null, 'alice', 'repo')).toMatchObject({ ok: false, status: 404 });
    const answer = await f.request('/api/repository?path=secret.txt', bob, { 'x-braid-workspace': repo.workspaceId });
    expect.soft(answer.status).toBe(404);
    expect(f.workspace.fetch).not.toHaveBeenCalled();
  });
  it('S-06 bounds namespace API requests during repeated warm public reads', async () => {
    const f = fixture(), repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    f.network.mockClear();
    for (let n = 0; n < 20; n++) expect(await f.directory.publicRead(repo.workspaceId)).toMatchObject({ ok: true });
    expect(f.network.mock.calls.filter(([url]) => String(url).startsWith('https://api.github.com/users/')).length).toBeLessThanOrEqual(1);
  });
  it('serves new and stale public mirrors with no anonymous REST requests when REST is rate limited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(), original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => String(input).startsWith('https://api.github.com/')
      ? Response.json({ message: 'API rate limit exceeded' }, { status: 403 }) : original(input, init));
    const repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    expect(await f.directory.publicRead(repo.workspaceId)).toMatchObject({ ok: true });
    vi.advanceTimersByTime(MIRROR_ACCESS_MS + 1);
    expect(await f.directory.publicRead(repo.workspaceId)).toMatchObject({ ok: true });
    expect(f.network.mock.calls.filter(([url]) => String(url).startsWith('https://api.github.com/'))).toHaveLength(0);
  });
});

describe('mirror security review: private access leases', () => {
  it('uses only the visitor token and never shares a positive lease between users', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    expect(await privateMirrorRepository(f.env, alice.id, 'alice/private')).toMatchObject({ id: 404, private: true });
    await expect(privateMirrorRepository(f.env, bob.id, 'alice/private')).rejects.toMatchObject({ status: 404 });
    await expect(privateMirrorRepository(f.env, null, 'alice/private')).rejects.toMatchObject({ status: 404 });
    expect(f.cache.size).toBe(0);
    expect(f.network.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual(['Bearer fixture-github:101', 'Bearer fixture-github:202']);
  });
  it('revokes private access within the 60 second lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    await privateMirrorRepository(f.env, alice.id, 'alice/private', 404);
    f.state.privateReaders.clear();
    vi.advanceTimersByTime(MIRROR_PRIVATE_ACCESS_MS + 1);
    await expect(privateMirrorRepository(f.env, alice.id, 'alice/private', 404)).rejects.toMatchObject({ status: 404 });
  });
  it('does not reuse a grant after the visitor changes their connected token', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    await privateMirrorRepository(f.env, alice.id, 'alice/private', 404);
    vi.spyOn(f.security, 'githubAccessToken').mockResolvedValue({ ok: true, token: `fixture-${bob.id}` });
    await expect(privateMirrorRepository(f.env, alice.id, 'alice/private', 404)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects a renamed repository or mismatched immutable repository ID', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    await expect(privateMirrorRepository(f.env, alice.id, 'alice/private', 405)).rejects.toMatchObject({ status: 404 });
    f.state.privateName = 'bob/renamed';
    await expect(privateMirrorRepository(f.env, alice.id, 'alice/private', 404)).rejects.toMatchObject({ status: 404 });
  });
});

describe('mirror security review: private gateway and transport matrix', () => {
  it('authorizes private Git upload-pack as a read for a GitHub reader without Braid ownership', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'alice', 'private', 'network'));
    const token = 'braid_agent_' + 'a'.repeat(64), authorize = vi.spyOn(f.directory, 'dispatch');
    await f.security.issueAgent(await digest(token), { id: 'fixture-reader', user: alice, workspaceId: repo.workspaceId, scope: 'read', label: 'Review', expires: Date.now() + 60_000 });
    const response = await f.request(`/git/${repo.workspaceId}.git/git-upload-pack`, undefined,
      { authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-upload-pack-request' }, { method: 'POST', body: '0000' });
    // The deliberately empty repository fixture returns 409 only after transport authorization succeeds.
    expect.soft(response.status).toBe(409);
    expect(authorize.mock.calls.filter(([, action]) => action === 'authorize').every(([, , input]) => 'write' in input && !input.write)).toBe(true);
  });
  it('opens a private mirror for its GitHub reader without granting other signed-in users access or sharing edge entries', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'alice', 'private', 'network'));
    expect(repo.visibility).toBe('private');
    const headers = { 'x-braid-workspace': repo.workspaceId };
    const allowed = await f.request('/api/repository?path=secret.txt', alice, headers);
    expect(allowed.status).toBe(200); expect(await allowed.text()).toContain('fixture mirrored content');
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect((await f.request('/api/repository?path=secret.txt', undefined, headers)).status).toBe(404);
    expect((await f.request('/api/repository?path=secret.txt', bob, headers)).status).toBe(404);
    expect(f.cache.size).toBe(0);
  });
  it('refuses anonymous Git advertisements and upload-pack for a private mirror', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'alice', 'private', 'network'));
    for (const [suffix, method] of [['info/refs?service=git-upload-pack', 'GET'], ['git-upload-pack', 'POST']]) {
      const response = await f.request(`/git/${repo.workspaceId}.git/${suffix}`, undefined, {}, { method });
      expect([401, 404]).toContain(response.status);
      expect(await response.text()).not.toContain('fixture mirrored content');
    }
  });
  it('hides private mirror metadata from Explore, owner pages, unrelated members, and cross-repository search', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    const org = f.directory.list(alice)[0];
    await f.directory.accept(bob, (await f.directory.invite(alice.id, org.id, { email: bob.email, role: 'member' })).token);
    f.state.visible = false; f.state.privateReaders.add(alice.id);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'acme', 'payroll', 'network'));
    f.directory.mirrorUpdated(repo.workspaceId, { syncedAt: new Date().toISOString(), importing: false });
    expect((await f.directory.publicRepositories(30)).items).toEqual([]);
    expect(JSON.stringify(await f.directory.mirrorOwnerRepositories(bob, 'acme'))).not.toContain('payroll');
    const account = await f.request('/api/account', bob);
    expect(account.status).toBe(200); expect(await account.text()).not.toContain('payroll');
    for (const viewer of [alice, bob]) {
      const response = await f.request('/api/search?q=repo%3Aacme%2Fpayroll%20secret', viewer);
      expect(response.status).toBe(200); expect(await response.text()).not.toContain('payroll');
    }
    expect((await f.request('/api/repository?path=secret.txt', bob, { 'x-braid-workspace': repo.workspaceId })).status).toBe(404);
  });
  it('does not put private mirror names or paths in OG previews, even for its owner', async () => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    requireMirror(await f.directory.resolveMirror(alice, 'alice', 'private-payroll', 'network'));
    vi.stubGlobal('HTMLRewriter', class {
      appended = '';
      on(_selector: string, handler: { element(head: { append(text: string): void }): void }) { handler.element({ append: text => { this.appended += text; } }); return this; }
      transform(response: Response) { return new Response(`<html><head>${this.appended}</head></html>`, response); }
    });
    f.env.ASSETS = { fetch: async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher;
    const response = await f.request('/alice/private-payroll/blob/main/salary.csv', alice);
    expect(response.status).toBe(200); expect(await response.text()).not.toMatch(/private-payroll|salary/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    ['get_repository', {}], ['get_file_contents', { path: 'secret.txt' }], ['get_blame', { path: 'secret.txt' }],
    ['list_commits', {}], ['compare_commits', { base: 'main', head: 'main' }], ['search_code', { query: 'secret' }],
    ['get_merge_queue', {}], ['list_pull_requests', {}], ['get_pull_request', { number: 1 }],
    ['list_pull_request_review_comments', { number: 1 }], ['files_in_progress', { paths: ['secret.txt'] }], ['get_rules', {}],
  ] as const)('MCP %s cannot read a private mirror using a Braid token without GitHub access', async (name, args) => {
    const f = fixture(); f.state.visible = false; f.state.privateReaders.add(alice.id);
    const repo = requireMirror(await f.directory.resolveMirror(alice, 'alice', 'private', 'network'));
    const token = 'braid_agent_' + 'b'.repeat(64);
    await f.security.issueAgent(await digest(token), { id: 'fixture-agent', user: bob, workspaceId: repo.workspaceId, scope: 'read', label: 'Review', expires: Date.now() + 60_000 });
    const response = await f.request('/mcp', undefined, { 'x-braid-workspace': repo.workspaceId, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.text();
    expect(body).not.toContain('fixture mirrored content');
    expect(body).toMatch(/"isError":true|"error"/);
    expect(f.workspace.fetch).not.toHaveBeenCalled();
  });
});

describe('mirror security review: transfer/storage admission', () => {
  it('caps a streamed pack and cancels upstream before forwarding an oversized chunk', async () => {
    const f = fixture(), repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    const transfer = await mirrorTransfer(f.env, repo.workspaceId), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MIRROR_PACK_BYTES + 1)); }, cancel });
    await expect(new Response(transfer.wrap(body)).arrayBuffer()).rejects.toMatchObject({ status: 413, code: 'mirror_too_large' });
    expect(cancel).toHaveBeenCalled(); expect(f.directory.mirrorRecord(repo.workspaceId)?.error).toBe('Too large to mirror.');
    expect(await f.directory.resolveMirror(null, 'alice', 'repo', 'network')).toMatchObject({ ok: false, status: 413, code: 'mirror_too_large' });
  });
  it('enforces the cumulative budget across concurrent transfers and Directory restart', async () => {
    const f = fixture(), repo = requireMirror(await f.directory.resolveMirror(null, 'alice', 'repo', 'network'));
    for (let n = 0; n < MIRROR_TOTAL_BYTES / MIRROR_PACK_BYTES; n++) expect(f.directory.reserveMirrorBytes(repo.workspaceId, MIRROR_PACK_BYTES)).toBe(true);
    const restarted = new Directory(f.db.ctx, f.env);
    expect(restarted.reserveMirrorBytes(repo.workspaceId, 1)).toBe(false);
    expect(restarted.mirrorRecord(repo.workspaceId)?.error).toBe('Too large to mirror.');
  });
});

describe('mirror security review: linking a Braid organization GitHub never confirmed', () => {
  it('lets its owner link it once GitHub confirms them as an admin, and then opens its GitHub repositories there', async () => {
    const f = fixture();
    const organization = f.directory.createOrganization(alice, 'Acme');
    const origin = { origin: 'https://braid.example', 'content-type': 'application/json' };
    // Until it is linked, the organization holds its name: no mirror, and no claim by anyone else.
    expect((await f.request('/api/repos/acme/repo', alice)).status).toBe(404);
    expect(await (await f.request('/api/owners/acme/claim', bob)).json()).toEqual({ claimable: false, reason: 'This namespace belongs to an existing Braid owner.' });
    expect((await f.request('/api/owners/acme/claim', bob, origin, { method: 'POST', body: '{}' })).status).toBe(409);
    expect(await (await f.request('/api/owners/acme/claim', alice)).json()).toEqual({ claimable: true, kind: 'organization', link: true });
    const linked = await f.request('/api/owners/acme/claim', alice, origin, { method: 'POST', body: '{}' });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ ok: true, role: 'owner' });
    const repo = await f.request('/api/repos/acme/repo', alice);
    expect(repo.status).toBe(200);
    const address = await repo.json() as { workspaceId: string; owner: { slug: string } };
    expect(address.owner.slug).toBe('acme');
    expect(f.db.storage.sql.exec<{ team: string }>('SELECT team_id AS team FROM workspaces WHERE id = ?', address.workspaceId).one().team).toBe(organization.id);
  });
  it('links only for an owner, and only one GitHub confirms as an admin', async () => {
    const f = fixture();
    const organization = f.directory.createOrganization(alice, 'Acme');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, organization.id, { email: bob.email, role: 'member' })).token);
    expect(await f.directory.claimStatus(bob, 'acme')).toMatchObject({ claimable: false });
    expect(await f.directory.claimMirrorOwner(bob, 'acme')).toMatchObject({ ok: false, status: 409 });
    f.state.organizationRole = 'member';
    expect(await f.directory.claimStatus(alice, 'acme')).toMatchObject({ claimable: false, link: true, reason: 'Only a GitHub organization admin can claim this owner.' });
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: false, status: 403 });
    expect(await f.directory.resolveMirror(alice, 'acme', 'repo', 'network')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('mirror security review: claims of a name the viewer already owns', () => {
  it('offers no claim of your own name, and only turns on its read-only mirrors', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'alice')).toMatchObject({ ok: true });
    expect(await f.directory.claimStatus(alice, 'alice')).toMatchObject({ claimable: false, owned: true });
    expect(await (await f.request('/api/owners/alice/claim', alice)).json()).toEqual({ claimable: false, owned: true, reason: 'You already own this name on Braid.' });
    // A GitHub repository opened under the name later is a read-only mirror until its owner turns it on.
    requireMirror(await f.directory.resolveMirror(alice, 'alice', 'later', 'network'));
    expect(await (await f.request('/api/owners/alice/claim', alice)).json()).toEqual({ claimable: true, kind: 'user', owned: true });
    expect(await f.directory.claimMirrorOwner(alice, 'alice')).toMatchObject({ ok: true, role: 'owner' });
    expect(await f.directory.claimStatus(alice, 'alice')).toMatchObject({ claimable: false, owned: true });
  });
  it('treats an organization its admin already owns the same way', async () => {
    const f = fixture();
    expect(await f.directory.claimMirrorOwner(alice, 'acme')).toMatchObject({ ok: true });
    expect(await f.directory.claimStatus(alice, 'acme')).toMatchObject({ claimable: false, owned: true });
  });
});
