import { describe, expect, it } from 'vitest';
import { storageFixture } from '../test/storage';
import { ContentStore } from '../workspace/content';
import { ChangeRecords } from './records';

describe('large change metadata', () => {
  it('round-trips metadata above SQLite’s 2 MB row limit through bounded chunks and keeps indexed fields', () => {
    const { storage } = storageFixture(), records = new ChangeRecords(new ContentStore(storage));
    const change = { id: 'ch_1', revision: 2, headCommit: 'a'.repeat(40), files: Array.from({ length: 12_000 }, (_, i) => ({ path: `${i}/${'文'.repeat(100)}`, additions: 1 })) };
    expect(new TextEncoder().encode(JSON.stringify(change)).length).toBeGreaterThan(2 * 1024 * 1024);
    const row = storage.transactionSync(() => records.write(change));
    expect(JSON.parse(row)).toMatchObject({ id: change.id, revision: 2, headCommit: change.headCommit, contentKey: 'record:ch_1' });
    expect(records.read(row)).toEqual(change);
    for (const chunk of storage.sql.exec<{ value: string }>('SELECT value FROM content_chunks'))
      expect(new TextEncoder().encode(chunk.value).length).toBeLessThan(128 * 1024);
    const smaller = { ...change, revision: 3, files: [] };
    expect(records.read(records.write(smaller))).toEqual(smaller);
    expect(storage.sql.exec('SELECT * FROM content_chunks').toArray()).toHaveLength(0);
  });

  it('reads existing inline records without migration', () => {
    const records = new ChangeRecords(new ContentStore(storageFixture().storage));
    expect(records.read('{"id":"old","revision":1}')).toEqual({ id: 'old', revision: 1 });
  });
});
