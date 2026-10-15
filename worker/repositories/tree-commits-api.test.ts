import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryTree } from '../../shared/repository';
import type { BraidEnv } from '../env';
import { withheldFixture } from '../test/withheld';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';
import { cachedRepositoryRead } from '../http/repository-cache';
import { edgeCache } from '../test/edge-cache';
import { Timings } from '../http/timing';
import { seedWorkspace } from '../workspace/seed';

const query = (ref: string, path = '', cursor?: string) => `/api/repository/tree/commits?${new URLSearchParams({ ref, path, ...(cursor ? { cursor } : {}) })}`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('directory commit API', () => {
  it('serves an anonymous public read and reuses the immutable edge response while still charging the expensive budget', async () => {
    const f = await withheldFixture();
    try {
      const expensive = vi.fn(async () => ({ success: true }));
      f.env.PUBLIC_EXPENSIVE_LIMITER = { limit: expensive } as unknown as RateLimit;
      const path = query(f.base), first = await f.call(path), etag = first.headers.get('etag');
      expect(first.status).toBe(200);
      const page = await first.json() as RepositoryTree;
      expect(page).toHaveProperty('historyComplete', true);
      expect(page.entries.map(item => item.lastCommit)).toEqual(Array(2).fill({ hash: f.base, title: 'Fixture', at: expect.any(String) }));
      expect(etag).toBeTruthy();
      f.calls.length = 0;
      expect(await (await f.call(path)).json()).toEqual(page);
      expect(f.calls).toEqual([]);
      expect(expensive).toHaveBeenCalledTimes(2);
      expensive.mockResolvedValueOnce({ success: false });
      expect((await f.call(path)).status).toBe(429);
      f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
      expect((await f.call(path)).status).toBe(404);
      expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it('rejects hidden and unpublished revisions, duplicate selectors and invalid paths before returning metadata', async () => {
    const f = await withheldFixture();
    try {
      // Even a member-warmed immutable response must not authorize the same anonymous commit read.
      expect((await f.call(query(f.tip), true)).status).toBe(200);
      for (const path of [query(f.tip), query('refs/braid/incoming/secret'), `${query(f.base)}&ref=${f.tip}`, query(f.base, '../x'), query(f.base, '', '-1')]) {
        const answer = await f.call(path);
        expect([400, 403, 404], path).toContain(answer.status);
        expect(await answer.text()).not.toContain('Withheld tip');
      }
    } finally { await f.close(); }
  });

  it('redacts commit metadata but keeps Git filenames verbatim, including names containing emails', async () => {
    const f = await withheldFixture();
    try {
      const filename = 'private@example.test.txt';
      const sha = f.h.git.commitTree({ [filename]: 'safe' }, f.base, 'Ask private@example.test about the release');
      f.h.git.native(['update-ref', 'refs/heads/feature', sha]);
      const response = await f.call(query('feature'));
      expect(response.status).toBe(200);
      const entry = (await response.json() as RepositoryTree).entries.find(item => item.name === filename)!;
      expect(entry.path).toBe(filename);
      expect(entry.lastCommit?.hash).toBe(sha);
      expect(entry.lastCommit?.title).not.toContain('private@example.test');
    } finally { await f.close(); }
  });

  it('returns files before slow history and reuses object-cached metadata without reopening Artifacts', async () => {
    const store = storageFixture(), head = 'a'.repeat(40), parent = 'b'.repeat(40);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const readCommit = vi.fn(async (hash: string) => {
      if (hash === parent) await barrier;
      return { hash, treeHash: hash, parents: hash === head ? [parent] : [], message: 'Update', committedAt: 1_700_000_000 };
    });
    const readTree = vi.fn(async (hash: string) => [{ name: 'README.md', hash, type: 'blob', mode: '100644' }]);
    const log = vi.fn(async ({ ref }: { ref: string }) => [await readCommit(ref)]);
    const dispose = vi.fn(), get = vi.fn(async () => ({ readCommit, readTree, log, [Symbol.dispose]: dispose }));
    try {
      const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
      seed.project = { ...seed.project, id: 'repo', head, branch: 'main' };
      await store.storage.put('workspace', seed);
      const workspace = new Workspace(store.ctx, { ARTIFACTS: { get } } as unknown as BraidEnv); await store.ready();
      const read = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': 'live', 'x-braid-public': 'true' } }));
      const first = await read(`/api/repository/tree?ref=${head}`);
      expect(first.status).toBe(200); expect((await first.json() as RepositoryTree).entries[0].name).toBe('README.md');
      expect(readCommit.mock.calls).toEqual([[head]]);
      let finished = false;
      const metadata = read(query(head)).then(response => { finished = true; return response; });
      await vi.waitFor(() => expect(readCommit.mock.calls.some(([sha]) => sha === parent)).toBe(true));
      expect(finished).toBe(false);
      // A second tree read can finish while that history read is held.
      expect((await read(`/api/repository/tree?ref=${head}`)).status).toBe(200);
      release();
      expect(await (await metadata).json()).toMatchObject({ historyComplete: true, entries: [{ lastCommit: { hash: head } }] });
      const opened = get.mock.calls.length;
      expect(await (await read(query(head))).json()).toMatchObject({ entries: [{ lastCommit: { hash: head } }] });
      expect(get).toHaveBeenCalledTimes(opened); expect(dispose).toHaveBeenCalledTimes(opened);
    } finally { release(); store.db.close(); }
  });

  it('does not edge-cache incomplete shallow history, then caches the completed result', async () => {
    edgeCache();
    const hash = 'a'.repeat(40), request = new Request(`https://braid.test${query(hash)}`);
    let ready = false;
    const read = vi.fn(async () => Response.json({ ref: hash, path: '', entries: [], nextCursor: null }, { headers: { 'x-braid-ref': hash, ...(!ready ? { 'cache-control': 'no-store' } : {}) } }));
    const call = () => cachedRepositoryRead(request, 'repo', 'build', new Timings(), true, read);
    await call(); ready = true; await call(); await call();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves the recorded tour history without acquiring a live repository', async () => {
    const store = storageFixture(), get = vi.fn();
    try {
      const workspace = new Workspace(store.ctx, { ARTIFACTS: { get } } as unknown as BraidEnv); await store.ready();
      const response = await workspace.fetch(new Request(`https://braid.test${query('main')}`));
      expect(response.status).toBe(200);
      const page = await response.json() as RepositoryTree;
      expect(page).toHaveProperty('historyComplete', false);
      expect(page.entries.find(item => item.name === 'src')?.lastCommit).toMatchObject({ hash: page.ref, title: 'Add structured delivery logging' });
      expect(get).not.toHaveBeenCalled();
    } finally { store.db.close(); }
  });
});
