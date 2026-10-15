import { afterEach, expect, it } from 'vitest';
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

let db: ReturnType<typeof storageFixture>;
afterEach(async () => { await db?.settled(); db?.db.close(); });

it('does not discard conflicting GitHub identity evidence from an account awaiting a username', () => {
  db = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv);
  const other = { id: 'other', name: 'Other person', email: 'other@example.test' };
  directory.account(other);
  directory.setUsername(other, 'original-login');
  const original = { id: 'original', name: 'Original person', email: 'original@example.test' };
  // The GitHub login cannot be auto-claimed because the other account already has it.
  expect(directory.account(original, { id: 42, login: 'original-login' }, true).user.username).toBeNull();
  expect(directory.gitPeople([{ name: original.name, email: original.email, github: 'original-login' }])).toEqual([
    { name: original.name, github: 'original-login' },
  ]);
});

it('lists every account for the operator', () => {
  db = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv);
  const person = { id: 'maya', name: 'Maya Chen', email: 'maya@example.test' };
  directory.account(person);
  directory.setUsername(person, 'maya-chen');
  expect(directory.people()).toEqual([expect.objectContaining({ id: 'maya', username: 'maya-chen', name: 'Maya Chen', email: 'maya@example.test', createdAt: expect.any(String) })]);
});
