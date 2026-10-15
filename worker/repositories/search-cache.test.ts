import { describe, expect, it } from 'vitest';
import { SearchIndexStore } from './search-cache';
import { SEARCH_LIMITS, type SearchIndex } from './search';
import { storageFixture } from '../test/storage';

const indexOf = (hash = 'blob', content: string | null = 'needle'): SearchIndex => ({
  files: [{ path: 'src/file.ts', hash, searchable: true }],
  blobs: new Map([[hash, { content, size: content?.length ?? 20, limited: false }]]), truncated: false,
});

describe('durable search index bounds', () => {
  it('evicts the least recently read commit and collects only unreferenced blobs', () => {
    const fixture = storageFixture(), cache = new SearchIndexStore(fixture.storage, SEARCH_LIMITS.cachedHeads);
    try {
      cache.write('one', indexOf('shared')); cache.write('two', indexOf('old')); cache.write('three', indexOf('shared'));
      cache.read('one'); cache.write('four', indexOf('new'));
      expect(new SearchIndexStore(fixture.storage, SEARCH_LIMITS.cachedHeads).read('one')).toEqual(indexOf('shared'));
      expect(cache.read('two')).toBeNull();
      expect(cache.blob('old')).toBeUndefined();
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM search_files_v2').get()).toEqual({ count: 3 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM search_heads_v2').get()).toEqual({ count: 3 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM search_blobs_v2').get()).toEqual({ count: 2 });
    } finally { fixture.db.close(); }
  });

  it('stores a maximum-size index in file-sized rows, retaining skips and the scan boundary', () => {
    const fixture = storageFixture(), cache = new SearchIndexStore(fixture.storage, SEARCH_LIMITS.cachedHeads);
    const index: SearchIndex = { files: [], blobs: new Map(), truncated: true };
    for (let i = 0; i < SEARCH_LIMITS.bytes / SEARCH_LIMITS.fileBytes; i++) {
      const hash = `blob-${i}`;
      index.files.push({ path: `file-${i}.ts`, hash, searchable: true });
      index.blobs.set(hash, { content: 'x'.repeat(SEARCH_LIMITS.fileBytes), size: SEARCH_LIMITS.fileBytes, limited: false });
    }
    index.files.push({ path: 'unread.ts', hash: null, searchable: false }, { path: 'too-big.txt', hash: 'large', searchable: false });
    index.blobs.set('large', { content: null, size: 8_000_000, limited: false });
    try { cache.write('one', index); expect(cache.read('one')).toEqual(index); }
    finally { fixture.db.close(); }
  });

  it('does not accumulate overwritten manifests or their old blobs', () => {
    const fixture = storageFixture(), cache = new SearchIndexStore(fixture.storage, 3);
    try {
      cache.write('one', indexOf('old')); cache.write('one', indexOf('new'));
      expect(cache.read('one')).toEqual(indexOf('new'));
      expect(cache.blob('old')).toBeUndefined();
    } finally { fixture.db.close(); }
  });

  it('discards legacy indexes without blob identities and can rebuild after workspace reset', async () => {
    const fixture = storageFixture(), cache = new SearchIndexStore(fixture.storage, SEARCH_LIMITS.cachedHeads);
    try {
      fixture.db.exec('CREATE TABLE search_heads_v1 (head TEXT); CREATE TABLE search_files_v1 (content TEXT)');
      expect(cache.has('one')).toBe(false);
      expect(fixture.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'search_%_v1'").all()).toEqual([]);
      cache.write('one', indexOf());
      await fixture.storage.deleteAll();
      expect(cache.read('one')).toBeNull();
      cache.write('two', indexOf()); expect(cache.read('two')).toEqual(indexOf());
    } finally { fixture.db.close(); }
  });
});
