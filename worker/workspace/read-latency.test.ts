import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace';
import { seedWorkspace } from './seed';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

const head = 'a'.repeat(40), next = 'b'.repeat(40);
const stores: ReturnType<typeof storageFixture>[] = [];
const pause = async () => { if (process.env.BRAID_READ_BENCHMARK === '1') await new Promise(resolve => setTimeout(resolve, 40)); };
async function fixture() {
  const store = storageFixture(); stores.push(store);
  const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
  seed.project = { ...seed.project, id: 'repo', branch: 'main', head, remote: 'https://git.example/repo' };
  await store.storage.put('workspace', seed);
  let branch = head;
  const dispose = vi.fn(), log = vi.fn(async () => { await pause(); return [{ hash: branch, treeHash: `tree-${branch}` }]; });
  const readCommit = vi.fn(async (hash: string) => { await pause(); return { treeHash: `tree-${hash}` }; });
  const readTree = vi.fn(async (hash: string) => [{ name: 'README.md', mode: '100644', type: 'blob', hash: `blob-${hash}` }]);
  const readBlob = vi.fn(async (hash: string) => new Blob([hash]));
  const get = vi.fn(async () => {
    await pause();
    return { log, readCommit, readTree, readBlob, [Symbol.dispose]: dispose };
  });
  const workspace = new Workspace(store.ctx, { ARTIFACTS: { get } } as unknown as BraidEnv);
  await store.ready();
  const read = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': 'live', 'x-braid-public': 'true' } }));
  return { read, get, log, readCommit, readTree, readBlob, dispose, move: () => branch = next };
}
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.db.close(); });

describe('immutable repository reads', () => {
  it.each(['/api/repository/tree?ref=main', '/api/repository?ref=main&path=README.md'])('reuses resolved commit metadata for a first %s read and still observes branch movement', async path => {
    const f = await fixture(), start = performance.now();
    const response = await f.read(path), data = await response.json(), elapsed = performance.now() - start;
    expect(response.status).toBe(200); expect(data).toMatchObject({ ref: head });
    if (process.env.BRAID_READ_BENCHMARK === '1') console.info(`FIRST_CODE_TIMING ${path} ms=${elapsed.toFixed(2)} readCommit=${f.readCommit.mock.calls.length}`);
    expect(f.readCommit).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledExactlyOnceWith({ ref: 'main', limit: 1 });
    expect(f.readTree).toHaveBeenCalledExactlyOnceWith(`tree-${head}`);
    expect(f.get).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    f.move();
    expect(await (await f.read(path)).json()).toMatchObject({ ref: next });
    expect(f.log).toHaveBeenCalledTimes(2); expect(f.readTree).toHaveBeenLastCalledWith(`tree-${next}`);
    expect(f.readCommit).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledTimes(2);
    f.log.mockResolvedValue([]);
    expect((await f.read(path)).status).toBe(404);
    expect(f.readTree).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledTimes(3);
  });

  it('reads a cached commit without opening Artifacts, while still resolving a mutable branch again', async () => {
    const f = await fixture(), start = performance.now();
    const first = await f.read(`/api/repository?ref=${head}&path=README.md`);
    const data = await first.json(), cold = performance.now() - start;
    expect(first.status).toBe(200); expect(data).toMatchObject({ content: `blob-tree-${head}`, ref: head });
    expect(f.get).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    const warmStart = performance.now();
    expect(await (await f.read(`/api/repository?ref=${head}&path=README.md`)).json()).toEqual(data);
    const warm = performance.now() - warmStart;
    expect(await (await f.read(`/api/repository/tree?ref=${head}`)).json()).toMatchObject({ ref: head, entries: [{ name: 'README.md' }] });
    if (process.env.BRAID_READ_BENCHMARK === '1') console.info(`OBJECT_TIMING cold=${cold.toFixed(2)}ms warm=${warm.toFixed(2)}ms artifacts=${f.get.mock.calls.length}`);
    expect(f.get).toHaveBeenCalledOnce(); expect(f.readCommit).toHaveBeenCalledOnce(); expect(f.readTree).toHaveBeenCalledOnce(); expect(f.readBlob).toHaveBeenCalledOnce();
    f.move();
    expect(await (await f.read('/api/repository?ref=main&path=README.md')).json()).toMatchObject({ ref: next, content: `blob-tree-${next}` });
    expect(f.log).toHaveBeenCalledOnce(); expect(f.get).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledTimes(2);
  });

  it('retries a failed object read and logs its typed cause without upstream text', async () => {
    const f = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.readBlob.mockRejectedValueOnce(Object.assign(new Error('credential-bearing upstream diagnostic'), { code: 'UPSTREAM_UNAVAILABLE' }));
    const failed = await f.read(`/api/repository?ref=${head}&path=README.md`);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('credential-bearing');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace_request_failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UPSTREAM_UNAVAILABLE'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('credential-bearing');
    expect(f.dispose).toHaveBeenCalledOnce();
    expect((await f.read(`/api/repository?ref=${head}&path=README.md`)).status).toBe(200);
    expect(f.readBlob).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledTimes(2);
  });
});
