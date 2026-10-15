import { afterEach, describe, expect, it, vi } from 'vitest';
import { directoryCommits, ObjectMemory, TREE_COMMIT_LIMITS } from './repository';

const hash = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number): ArtifactsCommitMetadata => ({ hash: hash(n), treeHash: `tree-${n}`, parents: n > 1 ? [hash(n - 1)] : [],
  message: `Commit ${n}`, committedAt: 1_700_000_000 + n, authoredAt: 1_700_000_000 + n,
  author: { name: 'Author', email: 'private@example.test' }, committer: { name: 'Author', email: 'private@example.test' } });
const file = (name: string, hash: string): ArtifactsTreeEntry => ({ name, hash, type: 'blob', mode: '100644' });
const delay = async () => { if (process.env.BRAID_TREE_BENCHMARK === '1') await new Promise(resolve => setTimeout(resolve, 8)); };
function fixture() {
  const readCommit = vi.fn(async (sha: string) => { await delay(); return commit(parseInt(sha, 16)); });
  const readTree = vi.fn(async (sha: string) => {
    await delay();
    const n = Number(sha.slice(5));
    return [file('ancient.txt', 'same'), file('recent.txt', n >= 235 ? 'new' : 'old'), file('noise.txt', sha)];
  });
  const log = vi.fn(async ({ ref, limit }: { ref: string; limit: number }) => {
    await delay();
    const n = parseInt(ref, 16);
    return Array.from({ length: Math.min(n, limit) }, (_, i) => commit(n - i));
  });
  const open = vi.fn(async () => ({ readCommit, readTree, log }) as unknown as ArtifactsRepo), memory = new ObjectMemory();
  return { readCommit, readTree, log, open, memory, reader: memory.historyReader(open) };
}
afterEach(() => vi.restoreAllMocks());

describe('batched directory history', () => {
  it('reads 200 ancestors in seven bounded calls, preserves attribution, and reuses history and trees', async () => {
    const f = fixture(), start = performance.now();
    const result = await directoryCommits(f.reader, hash(250), '');
    const elapsed = performance.now() - start;
    expect(result.entries.find(item => item.name === 'recent.txt')?.lastCommit?.hash).toBe(hash(235));
    expect(result.entries.find(item => item.name === 'noise.txt')?.lastCommit?.hash).toBe(hash(250));
    expect(result.entries.find(item => item.name === 'ancient.txt')?.lastCommit).toBeUndefined();
    expect(result.cacheable).toBe(true);
    expect(result.historyComplete).toBe(false);
    if (process.env.BRAID_TREE_BENCHMARK === '1') console.info(`TREE_HISTORY_TIMING ms=${elapsed.toFixed(2)} readCommit=${f.readCommit.mock.calls.length} log=${f.log.mock.calls.length} readTree=${f.readTree.mock.calls.length}`);
    expect(f.readCommit).toHaveBeenCalledOnce();
    expect(f.log.mock.calls.map(([options]) => options.limit)).toEqual([32, 32, 32, 32, 32, 32, 8]);
    expect(f.log.mock.calls.at(-1)?.[0].ref).toBe(hash(57));
    expect(f.readTree).toHaveBeenCalledTimes(TREE_COMMIT_LIMITS.commits + 1);
    expect(await directoryCommits(f.reader, hash(250), '')).toEqual(result);
    expect(f.log).toHaveBeenCalledTimes(7); expect(f.readCommit).toHaveBeenCalledOnce();
    expect(f.readTree).toHaveBeenCalledTimes(TREE_COMMIT_LIMITS.commits + 1);
  });

  it('stops comparing after attribution without fetching another history page or unrelated trees', async () => {
    const f = fixture(); f.readTree.mockImplementation(async sha => [file('only.txt', sha)]);
    expect(await directoryCommits(f.reader, hash(250), '')).toMatchObject({ entries: [{ lastCommit: { hash: hash(250) } }] });
    expect(f.log).toHaveBeenCalledExactlyOnceWith({ ref: hash(249), limit: 32 });
    expect(f.readTree).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent history pages and bounds their memory', async () => {
    const f = fixture();
    const pages = await Promise.all([f.reader.readHistory(hash(200), 32), f.reader.readHistory(hash(200), 32)]);
    expect(pages[0]).toEqual(pages[1]); expect(f.log).toHaveBeenCalledOnce();
    expect(pages[0][0]).not.toHaveProperty('author'); expect(pages[0][0]).not.toHaveProperty('committer');
    const tiny = new ObjectMemory(1).historyReader(f.open);
    await tiny.readHistory(hash(200), 32); await tiny.readHistory(hash(200), 32);
    expect(f.log).toHaveBeenCalledTimes(3);
  });

  it('retries short shallow pages, missing pages and typed NOT_FOUND after history arrives', async () => {
    const f = fixture(); let complete = false;
    f.readTree.mockImplementation(async () => [file('old.txt', 'unchanged')]);
    f.log.mockImplementation(async ({ ref, limit }) => {
      const n = parseInt(ref, 16), floor = complete ? 1 : 3;
      if (n < floor) throw Object.assign(new Error('missing parent'), { code: 'NOT_FOUND' });
      return Array.from({ length: Math.min(n - floor + 1, limit) }, (_, i) => commit(n - i));
    });
    const read = () => f.memory.directoryCommits(hash(5), '', () => directoryCommits(f.reader, hash(5), ''));
    expect(await read()).toMatchObject({ cacheable: false, entries: [{ name: 'old.txt' }] });
    expect((await read()).entries[0].lastCommit).toBeUndefined();
    complete = true;
    expect(await read()).toMatchObject({ cacheable: true, entries: [{ lastCommit: { hash: hash(1) } }] });
    expect(f.log.mock.calls.filter(([options]) => options.ref === hash(4))).toHaveLength(3);
    const calls = f.log.mock.calls.length;
    await read(); expect(f.log).toHaveBeenCalledTimes(calls);
  });

  it('retries failed history pages without treating an upstream outage as missing ancestry', async () => {
    const f = fixture(), failed = Object.assign(new Error('unavailable'), { code: 'UPSTREAM_UNAVAILABLE' });
    f.log.mockRejectedValueOnce(failed);
    await expect(directoryCommits(f.reader, hash(250), '')).rejects.toBe(failed);
    expect((await directoryCommits(f.reader, hash(250), '')).cacheable).toBe(true);
    expect(f.log).toHaveBeenCalledTimes(8);
  });
});
