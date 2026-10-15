import { describe, expect, it, vi } from 'vitest';
import { storageFixture } from '../test/storage';
import { ObjectCache } from './cache';

const MB = 1024 * 1024;

describe('the Git object cache', () => {
  it('passes large blobs through without buffering or keeping them in memory', async () => {
    const cache = new ObjectCache(storageFixture().ctx.storage.sql);
    const blob = new Blob([new Uint8Array(5 * MB)]);
    const copy = vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Do not buffer a streamed blob'));
    const readBlob = vi.fn(async () => blob);
    const reader = cache.reader({ readCommit: vi.fn(), readTree: vi.fn(), readBlob });
    expect(await reader.readBlob('large')).toBe(blob);
    expect(await reader.readBlob('large')).toBe(blob);
    expect(readBlob).toHaveBeenCalledTimes(2);
    expect(copy).not.toHaveBeenCalled();
  });

  it('serves small objects from storage once memory let them go', async () => {
    const cache = new ObjectCache(storageFixture().ctx.storage.sql);
    const readTree = vi.fn(async () => [{ mode: '100644', type: 'blob', name: 'a.ts', hash: 'b'.repeat(40) }] as ArtifactsTreeEntry[]);
    const readBlob = vi.fn(async () => new Blob([new Uint8Array(MB)]));
    const reader = cache.reader({ readCommit: vi.fn(), readTree, readBlob });
    await reader.readTree('t');
    for (let i = 0; i < 25; i++) await reader.readBlob(String(i));
    expect(await reader.readTree('t')).toEqual([expect.objectContaining({ name: 'a.ts' })]);
    expect(readTree).toHaveBeenCalledTimes(1);
  });
});
