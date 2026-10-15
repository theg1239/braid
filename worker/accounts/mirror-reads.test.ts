import { afterEach, expect, it } from 'vitest';
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

const alice = { id: 'github:101', email: 'alice@example.test', name: 'Alice' };
let db: ReturnType<typeof storageFixture>;
afterEach(async () => { await db?.settled(); db?.db.close(); });

/** An unclaimed copy of the private GitHub repository alice/repo, whose readers prove access with their own GitHub token. */
function privateMirror(githubAccessToken: () => Promise<unknown>) {
  db = storageFixture();
  const directory = new Directory(db.ctx, { SECURITY: { idFromName: (name: string) => name, get: () => ({ githubAccessToken }) } } as unknown as BraidEnv);
  const sql = db.ctx.storage.sql, time = '2026-10-14T00:00:00.000Z';
  sql.exec("INSERT INTO teams (id, name, search_name, slug, created_at, mirror, github_namespace_id) VALUES ('owner', 'alice', 'alice', 'alice', ?, 1, 101)", time);
  sql.exec("INSERT INTO team_addresses VALUES ('alice', 'owner')");
  sql.exec("INSERT INTO workspaces (id, team_id, name, slug, visibility, visibility_explicit, legacy_visibility, created_at, updated_at, description, search_name, search_description) VALUES ('mirror', 'owner', 'repo', 'repo', 'private', 1, 0, ?, ?, '', 'repo', '')", time, time);
  sql.exec("INSERT INTO repository_addresses VALUES ('owner', 'repo', 'mirror')");
  sql.exec("INSERT INTO mirrors (workspace, full_name, branch, head, private, repository_id) VALUES ('mirror', 'alice/repo', 'main', ?, 1, 99)", 'a'.repeat(40));
  return directory;
}

it('reads a private mirror its viewer cannot prove access to as not found, without naming it', async () => {
  const directory = privateMirror(async () => ({ ok: false, status: 409, error: 'Connect GitHub to choose a repository.' }));
  for (const viewer of [null, alice.id]) expect(await directory.resolveRepository(viewer, 'alice', 'repo')).toEqual({ ok: false, status: 404, error: 'Repository not found.' });
  expect(await directory.mirrorOwnerRepositories(alice, 'alice')).toEqual({ ok: true, data: { owner: { slug: 'alice', name: 'alice', kind: 'organization' }, repositories: [], mirror: true } });
});

it('surfaces a failure to check a mirror instead of answering that it does not exist', async () => {
  const unavailable = new Error('Security is overloaded.');
  const directory = privateMirror(async () => { throw unavailable; });
  await expect(directory.resolveRepository(alice.id, 'alice', 'repo')).rejects.toBe(unavailable);
  expect(await directory.mirrorOwnerRepositories(alice, 'alice')).toEqual({ ok: false, status: 502, error: 'The owner could not be loaded. Try again shortly.' });
});
