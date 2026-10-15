import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentity, Organization } from '../../shared/account';
import type { GlobalSearch } from '../../shared/search';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { mintAccess } from '../http/agent-token';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import type { BraidEnv } from '../env';
import { seedWorkspace } from '../workspace/seed';
import { GLOBAL_SEARCH_LIMITS } from './search-all';
import { recordedSearch } from './search';
import { storageFixture } from '../test/storage';
import { startGitServer } from '../test/git-server';
import { edgeCache } from '../test/edge-cache';

const alice = { id: 'alice', email: 'alice@example.test', name: 'Alice' };
const bob = { id: 'bob', email: 'bob@example.test', name: 'Bob' };
const head = 'a'.repeat(40);
type SearchRepo = Pick<ArtifactsRepo, 'log' | 'readTree' | 'readBlob'>;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.restoreAllMocks(); });

async function fixture() {
  const env = {} as BraidEnv;
  const storage = () => { const store = storageFixture(); cleanups.push(() => store.db.close()); return store; };
  const db = storage(), directory = new Directory(db.ctx, env), securityDb = storage(), security = new Security(securityDb.ctx, env);
  const workspaces = new Map<string, Workspace>(), repositories = new Map<string, SearchRepo>();
  const read = vi.fn(async (key: string, request: Request) => {
    let workspace = workspaces.get(key);
    if (!workspace) { const store = storage(); workspace = new Workspace(store.ctx, env); await store.ready(); workspaces.set(key, workspace); }
    return workspace.fetch(request);
  });
  const get = vi.fn(async (id: string) => ({ ...repositories.get(id)!, [Symbol.dispose]: () => {} }));
  Object.assign(env, { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SESSION_SECRET: 'search-session-secret-for-testing-only-123456',
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: (key: string) => ({ fetch: (request: Request) => read(key, request) }) },
    // Public cold searches now ask the repository's Trunk for a build allowance.
    TRUNKS: { getByName: () => ({ publicBuild: async () => ({ allowed: true, retryAfter: 0 }) }) },
    ARTIFACTS: { get },
  });
  const login = async (person: AccountIdentity) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, person); return `__Host-braid-session=${token}`; };
  const cookie = await login(alice), bobCookie = await login(bob);
  const add = async (owner: Organization, name: string, visibility: 'public' | 'private' = 'private', person = alice, git?: SearchRepo) => {
    const repo = directory.createWorkspace(person.id, owner.id, name, visibility), store = storage();
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
    seed.project = { ...seed.project, id: repo.id, head, branch: 'main' };
    await store.storage.put('workspace', seed);
    const workspace = new Workspace(store.ctx, env); await store.ready();
    workspaces.set(`team:${owner.id}:repository:${repo.id}`, workspace);
    const reader = git ?? { log: vi.fn(async () => [{ hash: head, treeHash: head }]), readTree: vi.fn(async () => [{ name: 'code.ts', type: 'blob', hash: 'blob' }]), readBlob: vi.fn(async () => new Blob([`needle ${owner.slug}/${name}\nContact private@example.test\n`])) } as unknown as ArtifactsRepo;
    repositories.set(repo.id, reader);
    return repo;
  };
  const call = (q: string, headers: Record<string, string> = {}) => api.fetch(new Request(`https://braid.test/api/search?${new URLSearchParams({ q })}`, { headers }), env);
  const search = async (q: string, headers: Record<string, string> = {}) => {
    const response = await call(q, headers); expect(response.status).toBe(200); return await response.json() as GlobalSearch;
  };
  return { env, directory, db, add, read, get, repositories, cookie, bobCookie, call, search };
}

describe('global code search authorization and scope', () => {
  it('searches the person and their organizations; a different person and visitors see no private names or content', async () => {
    const f = await fixture();
    const personal = f.directory.setUsername(alice, 'alice').personalOwner!;
    const org = f.directory.createOrganization(alice, 'Acme'), other = f.directory.createOrganization(bob, 'Other');
    await f.add(personal, 'notes'); await f.add(org, 'internal'); await f.add(org, 'site', 'public'); await f.add(other, 'private', 'private', bob);
    const own = await f.search('needle', { cookie: f.cookie });
    expect(own.searched.map(repo => `${repo.owner}/${repo.name}`).sort()).toEqual(['acme/internal', 'acme/site', 'alice/notes']);
    expect((await f.search('needle', { cookie: f.bobCookie })).searched.map(repo => repo.name)).toEqual(['private']);
    expect(await f.search('needle')).toMatchObject({ searched: [], repositories: [], truncated: false });
    for (const headers of [{}, { cookie: f.bobCookie }] as Record<string, string>[]) {
      f.read.mockClear();
      const result = await f.search('org:acme repo:acme/internal repo:acme/site needle', headers);
      expect(result.searched.map(repo => repo.name)).toEqual(['site']);
      expect(JSON.stringify(result)).not.toContain('internal');
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.read.mock.calls[0][1].headers.get('x-braid-public')).toBe('true');
    }
  });
  it('supports named public owners and repositories, deduplicates aliases and intersects owner/repo qualifiers', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme');
    await f.add(org, 'app', 'public');
    f.directory.updateTeam(alice.id, { teamId: org.id, slug: 'renamed' });
    expect((await f.search('user:acme needle')).searched.map(repo => repo.owner)).toEqual(['renamed']);
    expect((await f.search('repo:acme/app repo:renamed/app needle')).searched).toHaveLength(1);
    expect((await f.search('org:acme repo:renamed/app needle')).searched).toHaveLength(1);
    expect((await f.search('org:other repo:renamed/app needle')).searched).toEqual([]);
  });
  it('does not reuse another viewer’s authorization with a warm index, or a removed membership', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme');
    await f.add(org, 'secret');
    expect((await f.search('needle', { cookie: f.cookie })).matchCount).toBe(1);
    f.read.mockClear();
    expect((await f.search('repo:acme/secret needle', { cookie: f.bobCookie })).searched).toEqual([]);
    f.db.db.prepare('DELETE FROM members WHERE user_id = ?').run(alice.id);
    expect((await f.search('repo:acme/secret needle', { cookie: f.cookie })).searched).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('rechecks authorization after discovery, immediately before opening a repository object', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme'); await f.add(org, 'secret');
    const resolve = f.directory.resolveRepository.bind(f.directory);
    vi.spyOn(f.directory, 'resolveRepository').mockImplementation(async (...args) => {
      const result = await resolve(...args); f.db.db.prepare('DELETE FROM members WHERE user_id = ?').run(alice.id); return result;
    });
    expect((await f.search('repo:acme/secret needle', { cookie: f.cookie })).searched).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('keeps agent tokens inside their authorized repository and ignores forged internal headers', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme');
    const first = await f.add(org, 'one'); await f.add(org, 'two');
    const token = await mintAccess(f.env, { grant: 'grant', user: alice, workspace: first.id, team: org.id, scope: 'read', agent: 'agent', name: 'Test', exp: Date.now() + 60_000 });
    const result = await f.search('needle', { authorization: `Bearer ${token}` });
    expect(result.searched.map(repo => repo.name)).toEqual(['one']);
    expect((await f.search('repo:acme/two needle', { authorization: `Bearer ${token}` })).searched).toEqual([]);
    f.read.mockClear();
    expect((await f.search('org:acme needle', { 'x-braid-role': 'owner', 'x-braid-user-id': alice.id, 'x-braid-public': 'false' })).searched).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('rejects malformed queries before reading repositories', async () => {
    const f = await fixture();
    for (const query of ['', ' ', 'x'.repeat(257), 'a\nb', 'repo:owner', 'path:', '"unfinished']) expect((await f.call(query)).status).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('lets organization members read private code without exposing another organization', async () => {
    const f = await fixture(), shared = f.directory.createOrganization(alice, 'Shared'), separate = f.directory.createOrganization(alice, 'Separate');
    await f.add(shared, 'internal'); await f.add(separate, 'internal');
    f.db.db.prepare('INSERT INTO members (team_id, user_id, role) VALUES (?, ?, ?)').run(shared.id, bob.id, 'member');
    const result = await f.search('needle', { cookie: f.bobCookie });
    expect(result.searched).toEqual([{ owner: 'shared', name: 'internal', visibility: 'private' }]);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0][1].headers.get('x-braid-role')).toBe('viewer');
  });
});

describe('global search bounds, cache and example', () => {
  it('caps repository reads and concurrency and only reports real truncation', async () => {
    const f = await fixture();
    const owners = Array.from({ length: 3 }, (_, i) => f.directory.createOrganization(alice, `Owner ${i}`));
    for (let i = 0; i < 20; i++) await f.add(owners[Math.floor(i / 10)], `repo-${i}`);
    const original = f.read.getMockImplementation()!;
    let active = 0, peak = 0;
    f.read.mockImplementation(async (...args) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); try { return await original(...args); } finally { active--; } });
    expect((await f.search('needle', { cookie: f.cookie })).truncated).toBe(false);
    await f.add(owners[2], 'extra'); f.read.mockClear();
    const result = await f.search('needle', { cookie: f.cookie });
    expect(result.truncated).toBe(true); expect(result.searched).toHaveLength(GLOBAL_SEARCH_LIMITS.repositories);
    expect(f.read).toHaveBeenCalledTimes(20); expect(peak).toBe(4);
    expect((await f.search('org:owner-2 needle', { cookie: f.cookie })).truncated).toBe(false);
  });
  it('shares the per-commit cache with repository search and keeps literal highlights intact', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme'), repo = await f.add(org, 'app');
    const headers = { cookie: f.cookie, 'x-braid-workspace': repo.id };
    expect((await api.fetch(new Request('https://braid.test/api/repository/search?q=needle', { headers }), f.env)).status).toBe(200);
    const reader = f.repositories.get(repo.id)!; vi.mocked(reader.readBlob).mockClear(); vi.mocked(reader.readTree).mockClear();
    const result = await f.search('"Contact private@example.test" language:ts path:code', { cookie: f.cookie });
    expect(result.matchCount).toBe(1);
    expect(result.repositories[0].results[0].matches[0]).toEqual({ line: 2, content: 'Contact private@example.test', highlights: [{ start: 0, end: 28 }] });
    expect(reader.readBlob).not.toHaveBeenCalled(); expect(reader.readTree).not.toHaveBeenCalled();
    expect((await f.search('needle language:python', { cookie: f.cookie })).repositories).toEqual([]);
    expect((await f.search('path:code language:typescript', { cookie: f.cookie })).repositories[0].files[0].path).toBe('code.ts');
  });
  it('marks incomplete repositories and result caps instead of claiming a complete search', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme');
    await f.add(org, 'app'); await f.add(org, 'broken');
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async () => Response.json(recordedSearch({ 'many.ts': 'needle\n'.repeat(101) }, head, 'needle')));
    f.read.mockImplementationOnce(async () => Response.json({ error: 'upstream failed' }, { status: 503 }));
    const result = await f.search('needle', { cookie: f.cookie });
    expect(result).toMatchObject({ truncated: true, matchCount: 100 }); expect(result.searched).toHaveLength(1); expect(result.unavailable).toHaveLength(1);
    f.read.mockImplementation(original);
  });
  it('charges every public repository to the content budget', async () => {
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Acme'); await f.add(org, 'app', 'public');
    f.env.PUBLIC_EXPENSIVE_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const result = await f.call('org:acme needle'); expect(result.status).toBe(429); expect(result.headers.get('retry-after')).toBe('60'); expect(f.read).not.toHaveBeenCalled();
  });
  it('searches the visitor’s recorded example and clearly labels it', async () => {
    const f = await fixture();
    const demo = await sessionToken(f.env.SESSION_SECRET);
    const result = await f.search('repo:example/relay delivery path:src/ language:typescript', { cookie: `braid-demo=${demo}` });
    expect(result.searched).toEqual([{ owner: 'example', name: 'relay', visibility: 'public', recorded: true }]);
    expect(result.matchCount).toBeGreaterThan(0); expect(result.repositories[0].results.every(file => file.path.startsWith('src/'))).toBe(true);
    expect(f.get).not.toHaveBeenCalled();
  });
  it('searches a visitor\u2019s regional copy of the example, the one their other reads use', async () => {
    const f = await fixture(), opened: [string, unknown][] = [], get = f.env.WORKSPACES.get;
    edgeCache();
    f.env.WORKSPACES = { ...f.env.WORKSPACES, get: (name: DurableObjectId, options?: unknown) => { opened.push([String(name), options]); return get(name, options as never); } } as never;
    const visit = (path: string) => {
      const request = new Request(`https://braid.test${path}`, { headers: { 'x-braid-workspace': 'demo', 'cf-connecting-ip': '198.51.100.7' } });
      Object.defineProperty(request, 'cf', { value: { continent: 'AS', country: 'IN', longitude: '72.8' } });
      return api.fetch(request, f.env);
    };
    expect((await visit('/api/state')).status).toBe(200);
    const response = await visit(`/api/search?${new URLSearchParams({ q: 'repo:example/relay delivery' })}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as GlobalSearch).matchCount).toBeGreaterThan(0);
    const hour = Math.floor(Date.now() / 3_600_000);
    expect(opened).toEqual([[`demo:shared:apac:${hour}`, { locationHint: 'apac' }], [`demo:shared:apac:${hour}`, { locationHint: 'apac' }]]);
    // The example's own timings join the search's, so a slow answer says whether the copy or the cache answered.
    expect(response.headers.get('server-timing')).toMatch(/cache;dur=\d+.*workspace;dur=\d+/);
  });
  // Run timings alone: concurrent suites deliberately saturate the fixture's synchronous Git subprocesses.
  it.runIf(process.env.BRAID_SEARCH_BENCHMARK === '1')('measures cold and warm API queries across ten repository objects backed by real Git', async () => {
    const git = await startGitServer(); cleanups.push(() => git.close());
    const f = await fixture(), org = f.directory.createOrganization(alice, 'Ten repositories');
    const ref = git.commitTree(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`src/file-${i}.ts`, `// file ${i}\nexport const needle = ${i};\n${'// ordinary content\n'.repeat(90)}`])));
    git.native(['update-ref', 'refs/heads/main', ref]);
    const readBlob = vi.fn(git.repository.readBlob), readTree = vi.fn(git.repository.readTree);
    for (let i = 0; i < 10; i++) await f.add(org, `repo-${i}`, 'private', alice, { ...git.repository, readBlob, readTree });
    const cold = performance.now(); const result = await f.search('needle', { cookie: f.cookie }); const coldMs = performance.now() - cold;
    expect(result.searched).toHaveLength(10); expect(result.matchCount).toBe(800);
    readBlob.mockClear(); readTree.mockClear();
    const warm: number[] = [];
    for (let i = 0; i < 7; i++) { const start = performance.now(); await f.search(`ordinary ${i}`, { cookie: f.cookie }); warm.push(performance.now() - start); }
    expect(readBlob).not.toHaveBeenCalled(); expect(readTree).not.toHaveBeenCalled();
    const median = [...warm].sort((a, b) => a - b)[3];
    console.info('Global search benchmark (10 Durable Object instances, real Git, 80 files each):', JSON.stringify({ coldMs, warmMs: warm, warmMedianMs: median }));
    expect(median).toBeLessThan(300);
  }, 60_000);
});
