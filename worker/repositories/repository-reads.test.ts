import { afterEach, describe, expect, it, vi } from 'vitest';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import { organizationWithRepository } from '../test/organization';
import { digest, sessionToken } from '../http/auth';
import type { BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';

/*
 * The gateway keeps a public repository's trees and files at the edge by commit and remembers its head briefly.
 * The repository object below pins `ref` to its head when none is named and says which commit it read.
 */
const alice: AccountIdentity = { id: 'alice', email: 'alice@example.com', name: 'Alice' };
const commit = 'c'.repeat(40), moved = 'd'.repeat(40);
function fixture(visibility: 'public' | 'private' = 'public') {
  const directory = new Directory(storageFixture().ctx, {} as BraidEnv), security = new Security(storageFixture().ctx, {} as BraidEnv);
  const team = organizationWithRepository(directory, alice, 'Team', visibility), workspace = team.workspaces[0].id;
  let head = commit;
  const reads: { path: string; ref: string | null; cursor: string | null }[] = [];
  const env = {
    AUTH_MODE: 'github', SESSION_SECRET: 'strong-session-secret-for-tests-123456789', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example', BUILD_ID: 'build-1',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      // As the repository object does, a branch name or no name at all pins to the head; a commit is read as named.
      const url = new URL(request.url), named = url.searchParams.get('ref') ?? '', ref = /^[0-9a-f]{40}$/.test(named) ? named : head, path = url.searchParams.get('path') ?? '';
      reads.push({ path: url.pathname, ref: url.searchParams.get('ref'), cursor: url.searchParams.get('cursor') });
      if (url.pathname === '/api/repository/tree') return Response.json({ ref, path, entries: [{ name: 'README.md', path: 'README.md', kind: 'file', mode: '100644', hash: 'r' }], nextCursor: null }, { headers: { 'x-braid-ref': ref, 'server-timing': 'handle;dur=1' } });
      if (url.pathname === '/api/repository') return Response.json({ path, ref, content: `${path} at ${ref}`, kind: 'text' }, { headers: { 'x-braid-ref': ref, 'server-timing': 'handle;dur=1' } });
      return Response.json({ capabilities: { mode: 'live' }, project: { head } });
    } }) },
    ASSETS: { fetch: () => Response.json({}) },
  } as unknown as BraidEnv;
  const call = (path: string, options: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) =>
    api.fetch(new Request(`https://braid.example${path}`, { method: options.method ?? 'GET', headers: { 'x-braid-workspace': workspace, ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers } }), env);
  const login = async () => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, alice); return `__Host-braid-session=${token}`; };
  return { env, directory, team, workspace, reads, call, login, move: (to: string) => { head = to; } };
}
/** The repository entries in the data center's cache, without the lease the public read keeps beside them. */
const keysOf = (kept: Map<string, Response>) => [...kept.keys()].filter(key => key.startsWith('https://repository.braid.invalid/')).map(key => key.replace(/^https:\/\/repository\.braid\.invalid\/build-1\/[^/]+/, ''));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('public repository reads at the edge', () => {
  it('answers conditional file and tree reads without another object call and revalidates when the branch moves', async () => {
    const cache = edgeCache(), f = fixture();
    for (const path of ['/api/repository?path=README.md', '/api/repository/tree?path=']) {
      const first = await f.call(path), etag = first.headers.get('etag')!;
      expect(first.status).toBe(200); expect(etag).toBeTruthy();
      const before = f.reads.length;
      for (const validator of [etag, `W/${etag}`, `"old", W/${etag}`, '*']) {
        const response = await f.call(path, { headers: { 'if-none-match': validator } });
        expect(response.status).toBe(304); expect(await response.text()).toBe(''); expect(response.headers.get('etag')).toBe(etag);
      }
      expect(f.reads).toHaveLength(before);
    }
    const path = '/api/repository?path=README.md', first = await f.call(path), etag = first.headers.get('etag')!;
    f.move(moved);
    for (const key of cache.keys()) if (key.includes('/head?')) cache.delete(key);
    const changed = await f.call(path, { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200); expect(changed.headers.get('etag')).not.toBe(etag);
    expect(await changed.json()).toMatchObject({ ref: moved });
  });

  it('keeps a listing and a file under the commit the repository pinned, and answers them again without the repository', async () => {
    const kept = edgeCache(), f = fixture();
    const first = await f.call('/api/repository/tree?ref=&path=');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ref: commit });
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('server-timing')).toContain('do-handle');
    expect(f.reads).toEqual([{ path: '/api/repository/tree', ref: '', cursor: null }]);
    expect(keysOf(kept).sort()).toEqual([`/at/${commit}/api/repository/tree?ref=${commit}&path=`, '/head?ref=']);
    const head = kept.get([...kept.keys()].find(key => key.includes('/head?'))!)!;
    expect(await head.clone().text()).toBe(commit);
    expect(head.headers.get('cache-control')).toBe('public, max-age=10');
    const entry = kept.get([...kept.keys()].find(key => key.includes('/at/'))!)!;
    expect(entry.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(entry.headers.has('server-timing')).toBe(false);
    // The same listing by the head, or by its commit: served here, told apart from a repository answer by its timing.
    for (const path of ['/api/repository/tree?ref=&path=', `/api/repository/tree?ref=${commit}&path=`]) {
      const again = await f.call(path);
      expect(await again.json()).toMatchObject({ ref: commit });
      expect(again.headers.get('cache-control')).toBe('no-store');
      expect(again.headers.get('server-timing')).toMatch(/edge;dur=/);
      expect(again.headers.get('server-timing')).not.toContain('do-handle');
    }
    expect(f.reads).toHaveLength(1);
    // A file at the remembered head is asked for at that commit, so its answer is kept under it; another page of a listing is its own entry.
    expect(await (await f.call('/api/repository?ref=&path=README.md')).json()).toMatchObject({ content: `README.md at ${commit}` });
    expect(f.reads.at(-1)).toEqual({ path: '/api/repository', ref: commit, cursor: null });
    await f.call('/api/repository?ref=&path=README.md');
    await f.call(`/api/repository/tree?ref=${commit}&path=&cursor=200`);
    expect(f.reads).toHaveLength(3);
    expect(f.reads.at(-1)).toEqual({ path: '/api/repository/tree', ref: commit, cursor: '200' });
    expect(keysOf(kept)).toContain(`/at/${commit}/api/repository?ref=${commit}&path=README.md`);
  });

  it('resolves the branch head again once its window passed, so a push shows within seconds while old commits stay', async () => {
    const kept = edgeCache(), f = fixture();
    await f.call('/api/repository/tree?ref=&path=');
    f.move(moved);
    // Within the window the remembered head answers; once it lapses the repository names the new one.
    expect(await (await f.call('/api/repository/tree?ref=&path=')).json()).toMatchObject({ ref: commit });
    for (const key of [...kept.keys()]) if (key.includes('/head?')) kept.delete(key);
    expect(await (await f.call('/api/repository/tree?ref=&path=')).json()).toMatchObject({ ref: moved });
    expect(f.reads.map(read => read.ref)).toEqual(['', '']);
    expect(await kept.get([...kept.keys()].find(key => key.includes('/head?'))!)!.clone().text()).toBe(moved);
    expect(await (await f.call(`/api/repository/tree?ref=${commit}&path=`)).json()).toMatchObject({ ref: commit });
    expect(await (await f.call('/api/repository?ref=&path=README.md')).json()).toMatchObject({ content: `README.md at ${moved}` });
    expect(f.reads).toHaveLength(3);
    // A branch named in the request has its own head entry.
    expect(await (await f.call('/api/repository/tree?ref=main&path=')).json()).toMatchObject({ ref: moved });
    expect(keysOf(kept)).toContain('/head?ref=main');
  });

  it('shares a public repository\'s entries with its members and never a private repository\'s with anyone', async () => {
    edgeCache();
    const f = fixture(), cookie = await f.login();
    await f.call('/api/repository/tree?ref=&path=');
    expect(await (await f.call('/api/repository/tree?ref=&path=', { cookie })).json()).toMatchObject({ ref: commit });
    expect(f.reads).toHaveLength(1);
    const kept2 = edgeCache(), closed = fixture('private'), owner = await closed.login();
    expect((await closed.call('/api/repository/tree?ref=&path=')).status).toBe(404);
    for (let index = 0; index < 2; index++) expect((await closed.call('/api/repository/tree?ref=&path=', { cookie: owner })).status).toBe(200);
    expect(closed.reads).toHaveLength(2);
    expect(keysOf(kept2)).toEqual([]);
  });

  it('stops sharing a repository that went private, for visitors and members alike', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kept = edgeCache(), f = fixture(), cookie = await f.login();
    await f.call('/api/repository/tree?ref=&path=');
    expect(keysOf(kept)).toHaveLength(2);
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.workspace, visibility: 'private' });
    // Visibility lookups last five seconds.
    vi.setSystemTime(Date.now() + 6_000);
    expect((await f.call('/api/repository/tree?ref=&path=')).status).toBe(404);
    f.move(moved);
    expect(await (await f.call('/api/repository/tree?ref=&path=', { cookie })).json()).toMatchObject({ ref: moved });
    expect(f.reads).toHaveLength(2);
    expect(keysOf(kept)).toHaveLength(2);
  });

  it('leaves downloads, README media and anything but a listing or file to the repository', async () => {
    const kept = edgeCache(), f = fixture();
    for (let index = 0; index < 2; index++) await f.call('/api/repository?ref=&path=README.md&download=1');
    for (let index = 0; index < 2; index++) await f.call('/api/repository?ref=&path=logo.svg&media=1');
    await f.call('/api/state');
    expect(f.reads.map(read => read.path)).toEqual(['/api/repository', '/api/repository', '/api/repository', '/api/repository', '/api/state']);
    expect(keysOf(kept)).toEqual([]);
  });
});
