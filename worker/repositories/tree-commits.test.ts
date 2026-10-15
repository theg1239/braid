import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGitServer } from '../test/git-server';
import { demoEntries, directoryCommits, ObjectMemory, recordedDirectoryCommits, TREE_COMMIT_LIMITS, treePage } from './repository';
import { exampleMain, recordedExample } from '../changes/demo';
import { recordedTree } from './compare';

const hash = (n: number) => n.toString(16).padStart(40, '0');
const file = (name: string, id = name, mode = '100644'): ArtifactsTreeEntry => ({ name, hash: id, mode, type: mode === '40000' ? 'tree' : 'blob' });
const commit = (n: number, treeHash: string, parents: string[] = []): ArtifactsCommitMetadata => ({ hash: hash(n), treeHash, parents,
  message: `Commit ${n}\n\nBody`, authoredAt: 1_700_000_000 - 600, committedAt: 1_700_000_000 + n,
  author: { name: 'Author', email: 'private@example.test' }, committer: { name: 'Committer', email: 'private@example.test' } });
const cached = (repo: Pick<ArtifactsRepo, 'readCommit' | 'readTree'>, memory = new ObjectMemory()) => ({
  ...memory.historyReader(async () => repo as ArtifactsRepo),
  readHistory: async (hash: string) => { const found = await repo.readCommit(hash); return found ? [found] : []; },
});
afterEach(() => vi.restoreAllMocks());

describe('last commits in a directory', () => {
  it('matches Git on a merge-heavy fixture, including no-op merges, deletions inside folders and pinned older trees', async () => {
    const git = await startGitServer();
    try {
      const base = git.commitTree({ 'stable.txt': 'same', 'a.txt': 'base', 'dir/a.txt': 'old', 'dir/b.txt': 'kept' }, undefined, 'Initial');
      const sides: string[] = [], merges: string[] = [];
      let tip = base;
      const patches: Record<string, string | null>[] = [{ 'a.txt': 'new' }, { 'dir/a.txt': 'new' }, {}, { 'dir/a.txt': null }];
      for (const [i, patch] of patches.entries()) {
        const side = git.commitTree(patch, tip, `Side ${i}`); sides.push(side);
        const tree = (await git.repository.readCommit(side))!.treeHash;
        tip = git.native(['commit-tree', tree, '-p', tip, '-p', side], `Merge ${i}\n`).trim(); merges.push(tip);
      }
      const readCommit = vi.fn(git.repository.readCommit), readTree = vi.fn(git.repository.readTree), log = vi.fn(git.repository.log);
      const reader = new ObjectMemory().historyReader(async () => ({ readCommit, readTree, log }) as unknown as ArtifactsRepo);
      const result = await directoryCommits(reader, tip, '');
      expect(result.historyComplete).toBe(true);
      for (const item of result.entries) {
        const expected = git.native(['log', '--first-parent', '-1', '--format=%H', tip, '--', item.path]).trim();
        expect(item.lastCommit?.hash, item.path).toBe(expected);
      }
      expect(result.entries.find(item => item.name === 'dir')?.lastCommit?.hash).toBe(merges[3]);
      expect(result.entries.find(item => item.name === 'stable.txt')?.lastCommit?.hash).toBe(base);
      expect(result.entries.find(item => item.name === 'a.txt')?.lastCommit?.hash).toBe(merges[0]);
      expect(readCommit.mock.calls.some(([sha]) => sides.includes(sha))).toBe(false);
      expect(log.mock.calls.every(([options]) => options.limit! <= 32)).toBe(true);
      expect(await directoryCommits(reader, tip, 'dir')).toMatchObject({ entries: [{ name: 'b.txt', lastCommit: { hash: base } }] });
      expect((await directoryCommits(reader, merges[1], 'dir')).entries.find(item => item.name === 'a.txt')?.lastCommit).toMatchObject({ hash: merges[1], title: 'Merge 1' });
      const childTree = (await git.repository.readTree((await git.repository.readCommit(tip))!.treeHash))!.find(item => item.name === 'dir')!.hash;
      // The root listing compares folder hashes; it only opened that subtree for the later explicit directory read.
      expect(readTree.mock.calls.filter(([sha]) => sha === childTree)).toHaveLength(1);
    } finally { await git.close(); }
  });

  it('detects mode-only edits and directory introductions, uses the commit subject and committer ISO time, and stops when resolved', async () => {
    const commits = new Map([[hash(3), commit(3, 'head', [hash(2), hash(99)])], [hash(2), commit(2, 'parent', [hash(1)])]]);
    const readCommit = vi.fn(async (sha: string) => commits.get(sha) ?? null);
    const readTree = vi.fn(async (sha: string) => sha === 'head' ? [file('run', 'blob', '100755'), file('src', 'src', '40000')] : sha === 'parent' ? [file('run', 'blob')] : [file('new.ts')]);
    const result = await directoryCommits(cached({ readCommit, readTree }), hash(3), '');
    expect(result.entries.map(item => item.lastCommit)).toEqual(Array(2).fill({ hash: hash(3), title: 'Commit 3', at: '2023-11-14T22:13:23.000Z' }));
    expect(readCommit.mock.calls.map(([sha]) => sha)).toEqual([hash(3), hash(2)]);
    expect(readTree.mock.calls.map(([sha]) => sha)).toEqual(['head', 'parent']);
    expect((await directoryCommits(cached({ readCommit, readTree }), hash(3), 'src')).entries[0].lastCommit?.hash).toBe(hash(3));
  });

  it('stops at 200 first-parent comparisons and leaves older entries unresolved', async () => {
    const readCommit = vi.fn(async (sha: string) => { const n = parseInt(sha, 16); return commit(n, 'same', n ? [hash(n - 1)] : []); });
    const readTree = vi.fn(async () => [file('ancient.txt')]);
    const result = await directoryCommits(cached({ readCommit, readTree }), hash(250), '');
    expect(result.entries).toEqual([{ name: 'ancient.txt', path: 'ancient.txt', mode: '100644', kind: 'file', hash: 'ancient.txt' }]);
    expect(result.historyComplete).toBe(false);
    expect(readCommit).toHaveBeenCalledTimes(TREE_COMMIT_LIMITS.commits + 1);
    expect(readCommit.mock.calls.at(-1)).toEqual([hash(50)]);
    expect(readTree).toHaveBeenCalledOnce();
  });

  it('bounds wide-tree comparisons independently of the history limit', async () => {
    const readCommit = vi.fn(async (sha: string) => { const n = parseInt(sha, 16); return commit(n, `tree-${n}`, n ? [hash(n - 1)] : []); });
    const wide = Array.from({ length: 25_000 }, (_, i) => file(`f${i}`));
    const readTree = vi.fn(async () => wide);
    const result = await directoryCommits(cached({ readCommit, readTree }), hash(250), '');
    expect(result.entries.every(item => !item.lastCommit)).toBe(true);
    expect(result.historyComplete).toBe(false);
    expect(readTree.mock.calls.length).toBeLessThanOrEqual(TREE_COMMIT_LIMITS.entries / wide.length);
    expect(readCommit.mock.calls.length).toBeLessThan(12);
  });

  it('bounds ancestor tree lookups for deeply nested directories', async () => {
    const depth = 64, path = Array(depth).fill('src').join('/');
    const readCommit = vi.fn(async (sha: string) => { const n = parseInt(sha, 16); return commit(n, `${n}:0`, n ? [hash(n - 1)] : []); });
    const readTree = vi.fn(async (sha: string) => {
      const [n, level] = sha.split(':').map(Number);
      return level === depth ? [file('unchanged.txt')] : [file('src', `${n}:${level + 1}`, '40000')];
    });
    const result = await directoryCommits(cached({ readCommit, readTree }), hash(250), path);
    expect(result.entries[0].lastCommit).toBeUndefined();
    expect(result.historyComplete).toBe(false);
    expect(readTree).toHaveBeenCalledTimes(depth + 1 + TREE_COMMIT_LIMITS.trees);
    expect(readCommit.mock.calls.length).toBeLessThan(20);
  });

  it('shares immutable commit-directory work across concurrent reads and pages, isolates paths and refs, and evicts by size', async () => {
    const memory = new ObjectMemory(), load = vi.fn(async () => ({ entries: demoEntries({ 'a': '', 'b': '' }, ''), cacheable: true, historyComplete: false }));
    const [first, second] = await Promise.all([memory.directoryCommits(hash(1), '', load), memory.directoryCommits(hash(1), '', load)]);
    expect(second).toBe(first);
    expect(await memory.directoryCommits(hash(1), '', load)).toBe(first); expect(load).toHaveBeenCalledOnce();
    await memory.directoryCommits(hash(1), 'src', load); await memory.directoryCommits(hash(2), '', load); expect(load).toHaveBeenCalledTimes(3);
    const tiny = new ObjectMemory(1);
    await tiny.directoryCommits(hash(1), '', load); await tiny.directoryCommits(hash(1), '', load); expect(load).toHaveBeenCalledTimes(5);
    const entries = Array.from({ length: 451 }, (_, i) => ({ name: `f${i}`, path: `f${i}`, kind: 'file' as const, mode: '100644', hash: hash(i), lastCommit: { hash: hash(1), title: 'Initial', at: '2026-10-14T00:00:00Z' } }));
    const pages = [null, '200', '400'].map(cursor => treePage(hash(1), '', entries, cursor));
    expect(pages.map(page => [page.entries.length, page.nextCursor])).toEqual([[200, '200'], [200, '400'], [51, null]]);
    expect(new Set(pages.flatMap(page => page.entries.map(item => item.path))).size).toBe(451);
    expect(pages.flatMap(page => page.entries).every(item => item.lastCommit?.hash === hash(1))).toBe(true);
  });

  it('retries failed and shallow reads instead of freezing missing mirror history in the object cache', async () => {
    let available = false;
    const readCommit = vi.fn(async (sha: string) => sha === hash(2) ? commit(2, 'new', [hash(1)]) : available ? commit(1, 'old') : null);
    const readTree = vi.fn(async (sha: string) => [file('a', sha)]), memory = new ObjectMemory(), reader = cached({ readCommit, readTree }, memory);
    const load = () => memory.directoryCommits(hash(2), '', () => directoryCommits(reader, hash(2), ''));
    expect(await load()).toMatchObject({ cacheable: false, historyComplete: false, entries: [{ name: 'a' }] });
    expect((await load()).entries[0].lastCommit).toBeUndefined();
    available = true;
    expect(await load()).toMatchObject({ cacheable: true, historyComplete: true, entries: [{ lastCommit: { hash: hash(2) } }] });
    const failing = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ entries: [], cacheable: true });
    await expect(memory.directoryCommits(hash(3), '', failing)).rejects.toThrow('unavailable');
    await memory.directoryCommits(hash(3), '', failing); expect(failing).toHaveBeenCalledTimes(2);
  });

  it('uses recorded ancestry for main, an older pin and the unlanded tour branch', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [], since: Date.now() }, main = exampleMain(), project = { branch: 'main', head: main.head };
    for (const ref of ['main', example.change('23').landedCommit!, 'refund-rounding']) {
      const tree = recordedTree(example, state, project, main.files, ref);
      const result = await recordedDirectoryCommits(example, state, tree.ref, demoEntries(tree.files, ''));
      const src = result.entries.find(item => item.name === 'src')!;
      if (ref === 'refund-rounding') expect(src.lastCommit?.hash).toBe(example.branch(ref, state)!.tip.hash);
      else if (ref === 'main') expect(src.lastCommit).toMatchObject({ hash: main.head, title: 'Add structured delivery logging' });
      else {
        expect(result.entries.find(item => item.name === 'public')?.lastCommit?.hash).toBe(ref);
        expect(src.lastCommit?.hash).not.toBe(main.head);
      }
      expect(result.entries.find(item => item.name === 'tsconfig.json')?.lastCommit).toBeUndefined();
      expect(result.historyComplete).toBe(false);
      for (const item of result.entries) if (item.lastCommit) expect(new Date(item.lastCommit.at).toISOString()).toBe(item.lastCommit.at);
    }
  });
});
