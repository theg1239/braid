import { expect, it } from 'vitest';
import { storageFixture } from '../test/storage';
import { Trunk } from './trunk';
import type { BraidEnv } from '../env';

it('bounds waiting entries in insertion order and preserves counts without changing queue state', async () => {
  const f = storageFixture(), trunk = new Trunk(f.ctx, {} as BraidEnv);
  try {
    for (let i = 0; i < 101; i++) await trunk.enqueue('queue-test', { changeId: `ch_${i}`, shard: 0, number: 101 - i, revision: 1, title: `Change ${i}` });
    const before = f.db.prepare('SELECT * FROM queue ORDER BY seq').all();
    const status = await trunk.status('queue-test');
    expect(status).toMatchObject({ queued: 101, waiting: 101, waitingEntriesTruncated: true, enabled: false });
    expect(status.waitingEntries?.map(entry => entry.number)).toEqual(Array.from({ length: 100 }, (_, i) => 101 - i));
    expect(f.db.prepare('SELECT * FROM queue ORDER BY seq').all()).toEqual(before);
  } finally { f.db.close(); }
});
