import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryFile, RepositoryTree } from '../../shared/repository';
import { api, ApiError, resetWorkspaceCaches } from './api';
import { blames, files, primeHead, reader, readGeneration, subscribeReads, trees } from './reads';

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkspaceCaches();
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('cached reads', () => {
  it('shares one request between callers, keeps the answer and tells subscribers once', async () => {
    const answer = deferred<{ text: string }>();
    const read = vi.fn((_path: string, _head: string) => answer.promise);
    const files = reader((path: string, head: string) => `${head}:${path}`, read);
    const heard = vi.fn();
    const stop = subscribeReads(heard);
    const first = files.load('a.ts', 'h1'), second = files.load('a.ts', 'h1');
    expect(read).toHaveBeenCalledTimes(1);
    answer.resolve({ text: 'one' });
    expect(await first).toEqual({ text: 'one' });
    expect(await second).toBe(await first);
    expect(files.values.get(files.key('a.ts', 'h1'))).toEqual({ text: 'one' });
    expect(heard).toHaveBeenCalledTimes(1);
    await files.load('a.ts', 'h1');
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drops an answer that arrives after the workspace changed and reads again', async () => {
    const stale = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce('fresh');
    const notes = reader((id: string) => id, read);
    const pending = notes.load('n1');
    resetWorkspaceCaches();
    stale.resolve('stale');
    expect(await pending).toBe('stale');
    expect(notes.values.has('n1')).toBe(false);
    expect(await notes.load('n1')).toBe('fresh');
    expect(notes.values.get('n1')).toBe('fresh');
  });

  it('keeps no failure, so the next load asks again', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('back');
    const pages = reader((id: string) => id, read);
    await expect(pages.load('p')).rejects.toThrow('offline');
    expect(await pages.load('p')).toBe('back');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('puts an answer read elsewhere only for the same workspace and only once', () => {
    const trees = reader((path: string) => path, async () => 'read');
    const startedIn = readGeneration();
    trees.put('', 'first', startedIn);
    trees.put('', 'second', startedIn);
    expect(trees.values.get('')).toBe('first');
    resetWorkspaceCaches();
    trees.put('', 'late', startedIn);
    expect(trees.values.has('')).toBe(false);
  });
});

describe('the home read before the snapshot', () => {
  const head = 'a'.repeat(40);
  const page: RepositoryTree = { ref: head, path: '', entries: [], nextCursor: null };
  const readme = { ref: head, path: 'README.md', content: '# Relay' } as RepositoryFile;

  it('starts the actual README when the tree arrives, before a screen requests it, and shares that request', async () => {
    const tree = deferred<RepositoryTree>(), body = deferred<RepositoryFile>();
    vi.spyOn(api, 'readTree').mockReturnValue(tree.promise);
    const readFile = vi.spyOn(api, 'readFile').mockReturnValue(body.promise);
    primeHead();
    tree.resolve({ ...page, entries: [{ kind: 'file', name: 'README.md', path: 'README.md', hash: 'blob', mode: '100644' }] });
    await tree.promise;
    expect(readFile.mock.calls).toEqual([['README.md', head]]);
    const opened = files.load('README.md', head, head);
    body.resolve(readme);
    expect(await opened).toBe(readme);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it('does not prefetch a README from a tree that arrives after a workspace reset', async () => {
    const tree = deferred<RepositoryTree>();
    vi.spyOn(api, 'readTree').mockReturnValue(tree.promise);
    const readFile = vi.spyOn(api, 'readFile');
    primeHead(); resetWorkspaceCaches();
    tree.resolve({ ...page, entries: [{ kind: 'file', name: 'README.md', path: 'README.md', hash: 'blob', mode: '100644' }] });
    await tree.promise;
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['README', null])('does not guess a README filename before the tree names %s', async name => {
    const tree = deferred<RepositoryTree>();
    const readTree = vi.spyOn(api, 'readTree').mockReturnValue(tree.promise);
    const readFile = vi.spyOn(api, 'readFile').mockResolvedValue({ ...readme, path: name ?? '' });
    primeHead();
    expect(readFile).not.toHaveBeenCalled();
    const listing = trees.load('', head);
    tree.resolve({ ...page, entries: name ? [{ kind: 'file', name, path: name, hash: 'blob', mode: '100644' }] : [] });
    const entry = (await listing).entries[0];
    if (entry) await files.load(entry.path, head, head);
    expect(readTree).toHaveBeenCalledOnce();
    expect(readFile.mock.calls).toEqual(name ? [[name, head]] : []);
  });

  it('recovers a missing default branch with one shared read at the known commit', async () => {
    const branch = deferred<RepositoryTree>();
    const read = vi.spyOn(api, 'readTree').mockReturnValueOnce(branch.promise).mockResolvedValue(page);
    primeHead({ trees: [''] });
    const first = trees.load('', head), second = trees.load('', head);
    branch.reject(new ApiError(404, 'Repository revision not found.'));
    expect(await first).toEqual(page);
    expect(await second).toBe(await first);
    expect(read.mock.calls).toEqual([['', ''], ['', head, undefined]]);
    expect(trees.values.get(trees.key('', head))).toEqual(page);
  });

  it('recovers a file at the snapshot commit when the speculative branch read is missing', async () => {
    const branch = deferred<RepositoryFile>();
    const read = vi.spyOn(api, 'readFile').mockReturnValueOnce(branch.promise).mockResolvedValue(readme);
    primeHead({ trees: [], file: 'README.md' });
    const opened = files.load('README.md', head, head);
    branch.reject(new ApiError(404, 'Repository revision not found.'));
    expect(await opened).toEqual(readme);
    expect(read.mock.calls).toEqual([['README.md', ''], ['README.md', head]]);
  });

  it.each([401, 403, 429])('does not follow a denied or throttled early read with another request: %s', async status => {
    const branch = deferred<RepositoryFile>();
    const read = vi.spyOn(api, 'readFile').mockReturnValueOnce(branch.promise);
    primeHead({ trees: [], file: 'README.md' });
    const opened = files.load('README.md', head, head);
    branch.reject(new ApiError(status, 'Unavailable'));
    await expect(opened).rejects.toMatchObject({ status });
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not retry a missing branch in a different workspace after a reset', async () => {
    const branch = deferred<RepositoryFile>();
    const read = vi.spyOn(api, 'readFile').mockReturnValueOnce(branch.promise);
    primeHead({ trees: [], file: 'README.md' });
    const opened = files.load('README.md', head, head);
    resetWorkspaceCaches();
    branch.reject(new ApiError(404, 'Repository revision not found.'));
    await expect(opened).rejects.toMatchObject({ status: 404 });
    expect(read).toHaveBeenCalledOnce();
  });

  it('shows a stalled early read as an error once, then retries with a new request', async () => {
    const stalled = deferred<RepositoryFile>();
    const read = vi.spyOn(api, 'readFile').mockReturnValueOnce(stalled.promise).mockResolvedValue(readme);
    primeHead({ trees: [], file: 'README.md' });
    const pending = files.load('README.md', head, head);
    stalled.reject(new Error('The request timed out. Try again.'));
    await expect(pending).rejects.toThrow('timed out');
    expect(read).toHaveBeenCalledTimes(1);
    expect(await files.load('README.md', head, head)).toEqual(readme);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('answers the screen that asks for the same commit while it is still on its way', async () => {
    const tree = deferred<RepositoryTree>(), file = deferred<RepositoryFile>();
    const readTree = vi.spyOn(api, 'readTree').mockReturnValueOnce(tree.promise);
    const readFile = vi.spyOn(api, 'readFile').mockReturnValueOnce(file.promise);
    primeHead({ trees: [''], file: 'README.md' });
    const listing = trees.load('', head), opened = files.load('README.md', head, head);
    tree.resolve(page);
    file.resolve(readme);
    expect(await listing).toBe(page);
    expect(await opened).toBe(readme);
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('reads a path\'s listing or file and its blame beside the root, and answers the screen\'s head-keyed reads from them', async () => {
    const readTree = vi.spyOn(api, 'readTree').mockImplementation(async (path, ref) => ({ ...page, path, ref: ref || head }));
    const readFile = vi.spyOn(api, 'readFile').mockResolvedValue({ ...readme, path: 'src/a.ts' });
    const readBlame = vi.spyOn(api, 'blame').mockResolvedValue({ path: 'src/a.ts', ref: head, lines: 1, ranges: [] });
    primeHead({ trees: [''], file: 'src/a.ts', blame: 'src/a.ts' });
    expect(readTree.mock.calls).toEqual([['', '']]);
    expect(readFile.mock.calls).toEqual([['src/a.ts', '']]);
    expect(readBlame.mock.calls).toEqual([['src/a.ts', '']]);
    expect((await trees.load('', head)).ref).toBe(head);
    expect((await files.load('src/a.ts', head, head)).path).toBe('src/a.ts');
    expect((await blames.load('src/a.ts', head)).lines).toBe(1);
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readBlame).toHaveBeenCalledTimes(1);
    // Another path, or a directory's listing beside the root, is read as usual.
    await blames.load('src/b.ts', head);
    primeHead({ trees: ['', 'src'] });
    expect((await trees.load('src', head)).path).toBe('src');
    expect(readBlame.mock.calls.at(-1)).toEqual(['src/b.ts', head]);
    expect(readTree.mock.calls.slice(1)).toEqual([['', ''], ['src', '']]);
  });

  it('reads again when main moved before the screen asked, or when it asks for a branch', async () => {
    const moved = 'b'.repeat(40);
    const readTree = vi.spyOn(api, 'readTree').mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, ref: moved }).mockResolvedValueOnce({ ...page, ref: 'feature' });
    vi.spyOn(api, 'readFile').mockResolvedValue(readme);
    primeHead();
    expect((await trees.load('', moved)).ref).toBe(moved);
    expect((await trees.load('', 'feature')).ref).toBe('feature');
    expect(readTree.mock.calls).toEqual([['', ''], ['', moved, undefined], ['', 'feature', undefined]]);
  });
});
