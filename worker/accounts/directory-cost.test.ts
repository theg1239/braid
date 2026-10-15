import { afterEach, expect, it, vi } from 'vitest';
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

let db: ReturnType<typeof storageFixture>;
afterEach(async () => { vi.restoreAllMocks(); await db?.settled(); db?.db.close(); });

it('looks up unmatched Git authors through indexes instead of scanning every account on each public read', () => {
  db = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv);
  const insert = db.db.prepare('INSERT INTO users (id, email, name, username, github_login) VALUES (?, ?, ?, ?, ?)');
  db.storage.transactionSync(() => {
    for (let i = 0; i < 5_000; i++) insert.run(`id-${i}`, `fixture-${i}@example.test`, `Name ${i}`, `user-${i}`, `github-${i}`);
  });
  const exec = vi.spyOn(db.storage.sql, 'exec');
  directory.gitPeople([{ name: 'unmatched-author', email: 'unmatched@example.test' }]);
  const lookups = exec.mock.calls.filter(([sql]) => /SELECT.+FROM users/i.test(sql));
  expect(lookups.length).toBeGreaterThan(0);
  const plans = lookups.flatMap(([sql, ...bindings]) => db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings as string[]));
  expect(plans.map(row => row.detail).join('\n')).not.toMatch(/SCAN users/i);
});
