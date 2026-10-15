import { describe, expect, it } from 'vitest';
import { ChangeShard } from './shard';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

describe('change list summaries', () => {
  it('upgrades an existing row once and then lists without loading its file metadata', () => {
    const { ctx, storage } = storageFixture(), shard = new ChangeShard(ctx, {} as BraidEnv);
    const value = { id: 'ch_1', number: 1, title: 'Large pull request', revision: 1, status: 'open', author: { id: 'owner', name: 'Owner', kind: 'human' },
      files: Array.from({ length: 1000 }, (_, i) => ({ path: `file-${i}.txt` })), additions: 1000, deletions: 0, checks: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    storage.sql.exec('INSERT INTO changes (id, number, status, author_id, created_at, updated_at, value) VALUES (?, ?, ?, ?, ?, ?, ?)', value.id, value.number, value.status, value.author.id, value.createdAt, value.updatedAt, JSON.stringify(value));
    const first = shard.list({ limit: 20 });
    expect(first.items[0]).toMatchObject({ files: 1000, additions: 1000, revision: 1 });
    const kept = storage.sql.exec<{ summary: string }>('SELECT summary FROM changes').one().summary;
    expect(JSON.parse(kept)).toEqual(first.items[0]);
    // A chunk reference has no inline file list. The list must never try to hydrate it.
    storage.sql.exec('UPDATE changes SET value = ?', '{"contentKey":"not-read-for-lists"}');
    expect(shard.list({ limit: 20 })).toEqual(first);
  });
});
