import { afterEach, expect, it, vi } from 'vitest';
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

const alice = { id: 'alice', name: 'Alice', email: 'alice@example.test' };
let db: ReturnType<typeof storageFixture>;
afterEach(async () => { await db?.settled(); db?.db.close(); vi.restoreAllMocks(); });

it('backfills old repositories from actual heads once, keeps empty rows, and leaves discovery free of workspace calls', async () => {
  db = storageFixture();
  const before = new Directory(db.ctx, {} as BraidEnv);
  const owner = before.createOrganization(alice, 'Archive');
  const ready = before.createWorkspace(alice.id, owner.id, 'Ready', 'public');
  const empty = before.createWorkspace(alice.id, owner.id, 'Empty', 'public');
  db.storage.sql.exec('UPDATE workspaces SET has_commits = NULL');
  const repository = vi.fn(async (key: string) => key.endsWith(ready.id) ? { head: 'a'.repeat(40) } : null);
  const env = { WORKSPACES: { getByName: (key: string) => ({ repository: () => repository(key) }) } } as unknown as BraidEnv;
  let directory = new Directory(db.ctx, env);
  await db.settled();
  expect(repository).toHaveBeenCalledTimes(2);
  expect((await directory.publicRepositories(20)).items.map(repo => repo.repo.name)).toEqual(['Ready']);
  expect(directory.list(alice)[0].workspaces.map(repo => repo.id)).toContain(empty.id);
  repository.mockClear();
  directory = new Directory(db.ctx, env); await db.settled();
  await directory.publicRepositories(20);
  expect(repository).not.toHaveBeenCalled();
});

it('does not let a delayed readiness migration hide an import that finished meanwhile', async () => {
  db = storageFixture();
  const before = new Directory(db.ctx, {} as BraidEnv);
  const owner = before.createOrganization(alice, 'Archive');
  const copy = before.createWorkspace(alice.id, owner.id, 'Copy', 'public');
  db.storage.sql.exec('UPDATE workspaces SET has_commits = NULL');
  let finish!: (value: null) => void;
  const pending = new Promise<null>(resolve => { finish = resolve; });
  const directory = new Directory(db.ctx, { WORKSPACES: { getByName: () => ({ repository: () => pending }) } } as unknown as BraidEnv);
  directory.repositoryImported(copy.id, true, '', true);
  finish(null); await db.settled();
  expect((await directory.publicRepositories(20)).items.map(repo => repo.repo.name)).toEqual(['Copy']);
});
