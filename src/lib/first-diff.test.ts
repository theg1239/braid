import { afterEach, expect, it, vi } from 'vitest';
import type { Change, ChangeDiff } from '../../shared/types';
import { changes, resetWorkspaceCaches } from './api';
import { prefetchDiff, readFilesPull } from './resources';
vi.mock('./live', () => ({ useLive: vi.fn() }));
const change = { id: 'ch_1234', number: 23, revision: 2, files: [{ path: 'a.ts', additions: 1, deletions: 1 }] } as Change;
const diff: ChangeDiff = { path: 'a.ts', revision: 2, before: 'one', after: 'two', binary: false };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; };
afterEach(() => { vi.restoreAllMocks(); resetWorkspaceCaches(); });

it('starts the first diff before detail resolves and shares the in-flight revision read', async () => {
  const detail = deferred<Change>(), first = deferred<ChangeDiff>();
  const get = vi.spyOn(changes, 'get').mockReturnValue(detail.promise);
  const read = vi.spyOn(changes, 'diff').mockReturnValue(first.promise);
  const opening = readFilesPull('23', null);
  expect(get).toHaveBeenCalledWith('23');
  expect(read.mock.calls).toEqual([['23', '']]);
  detail.resolve(change);
  await opening;
  prefetchDiff(change.id, 2, 'a.ts');
  first.resolve(diff);
  await first.promise;
  await Promise.resolve();
  prefetchDiff(change.id, 2, 'a.ts');
  expect(read).toHaveBeenCalledOnce();
});

it('uses a focused file from the URL', async () => {
  vi.spyOn(changes, 'get').mockResolvedValue(change);
  const read = vi.spyOn(changes, 'diff').mockResolvedValue(diff);
  await readFilesPull('23', 'a.ts');
  prefetchDiff(change.id, 2, 'a.ts');
  expect(read.mock.calls).toEqual([['23', 'a.ts']]);
});

it.each([[3, 'a.ts', undefined], [2, 'b.ts', undefined], [2, 'a.ts', 1]] as const)('never aliases another revision, file or comparison: %s %s %s', async (revision, path, since) => {
  vi.spyOn(changes, 'get').mockResolvedValue(change);
  const read = vi.spyOn(changes, 'diff').mockResolvedValue(diff);
  await readFilesPull('23', null);
  prefetchDiff(change.id, revision, path, since);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenLastCalledWith(change.id, path, revision, since);
});

it('retries normally if the speculative diff failed', async () => {
  vi.spyOn(changes, 'get').mockResolvedValue(change);
  const read = vi.spyOn(changes, 'diff').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(diff);
  await readFilesPull('23', null);
  prefetchDiff(change.id, 2, 'a.ts');
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenLastCalledWith(change.id, 'a.ts', 2, undefined);
});

it('drops detail and diff from the previous workspace even when they finish late', async () => {
  const detail = deferred<Change>(), first = deferred<ChangeDiff>();
  vi.spyOn(changes, 'get').mockReturnValue(detail.promise);
  const read = vi.spyOn(changes, 'diff').mockReturnValueOnce(first.promise).mockResolvedValue(diff);
  const opening = readFilesPull('23', null);
  resetWorkspaceCaches();
  detail.resolve(change);
  first.resolve(diff);
  await opening;
  prefetchDiff(change.id, 2, 'a.ts');
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(change.id, 'a.ts', 2, undefined);
});

it('surfaces a stalled first diff once, then lets the next attempt read again', async () => {
  const first = deferred<ChangeDiff>();
  vi.spyOn(changes, 'get').mockResolvedValue(change);
  const read = vi.spyOn(changes, 'diff').mockReturnValueOnce(first.promise).mockResolvedValue(diff);
  await readFilesPull('23', null);
  prefetchDiff(change.id, 2, 'a.ts');
  first.reject(new Error('The request timed out. Try again.'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read).toHaveBeenCalledOnce();
  prefetchDiff(change.id, 2, 'a.ts');
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(change.id, 'a.ts', 2, undefined);
});


it('reads other files and later revisions without waiting for a slow first diff', async () => {
  const first = deferred<ChangeDiff>();
  vi.spyOn(changes, 'get').mockResolvedValue(change);
  const read = vi.spyOn(changes, 'diff').mockReturnValueOnce(first.promise).mockResolvedValue(diff);
  await readFilesPull('23', null);
  prefetchDiff(change.id, 2, 'b.ts');
  prefetchDiff(change.id, 3, 'a.ts');
  expect(read.mock.calls).toEqual([['23', ''], [change.id, 'b.ts', 2, undefined], [change.id, 'a.ts', 3, undefined]]);
  first.resolve(diff);
});
