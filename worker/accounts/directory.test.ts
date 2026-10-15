import { organizationWithRepository } from '../test/organization';
import { describe, expect, it } from 'vitest';
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';
const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' };
const bob = { id: 'bob', email: 'bob@example.com', name: 'Bob' };
describe('team authorization and invitations', () => {
  it('isolates teams, enforces owner writes and revokes membership immediately across restarts', async () => {
    const db = storageFixture();
    const directory = new Directory(db.ctx, {} as BraidEnv);
    const a = organizationWithRepository(directory, alice, 'A'), b = organizationWithRepository(directory, bob, 'B');
    expect(() => directory.authorize(bob.id, a.workspaces[0].id, false)).toThrow(/not found/);
    expect(directory.list(alice).map(t => t.id)).toEqual([a.id]);
    const invitation = await directory.invite(alice.id, a.id, { email: bob.email, role: 'member' });
    await expect(directory.accept(alice, invitation.token)).rejects.toThrow(/email address/);
    await directory.accept(bob, invitation.token);
    await expect(directory.accept(bob, invitation.token)).rejects.toThrow(/already been accepted/);
    expect(directory.authorize(bob.id, a.workspaces[0].id, false).role).toBe('member');
    expect(() => directory.authorize(bob.id, a.workspaces[0].id, true)).toThrow(/owner/);
    expect(() => directory.createWorkspace(bob.id, a.id, 'Forbidden')).toThrow(/owner/);
    const restarted = new Directory(db.ctx, {} as BraidEnv);
    restarted.removeMember(alice.id, a.id, bob.id);
    expect(() => restarted.authorize(bob.id, a.workspaces[0].id, false)).toThrow(/not found/);
    expect(restarted.authorize(bob.id, b.workspaces[0].id, true).role).toBe('owner');
    expect(() => restarted.removeMember(alice.id, a.id, alice.id)).toThrow(/at least one owner/);
    expect(restarted.auditLog(alice.id, a.id, Number.MAX_SAFE_INTEGER).map(r => r.action)).toContain('member.removed');
  });
  it('revokes invitations, rejects duplicate consumption and never returns invitation secrets in listings', async () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    const team = organizationWithRepository(directory, alice, 'A');
    const invitation = await directory.invite(alice.id, team.id, { email: bob.email, role: 'owner' });
    expect(JSON.stringify(directory.members(alice.id, team.id))).not.toContain(invitation.token);
    directory.revokeInvite(alice.id, team.id, invitation.id);
    await expect(directory.accept(bob, invitation.token)).rejects.toThrow(/revoked/);
    const next = await directory.invite(alice.id, team.id, { email: bob.email, role: 'owner' });
    const results = await Promise.allSettled([directory.accept(bob, next.token), directory.accept(bob, next.token)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(directory.authorize(bob.id, team.workspaces[0].id, true).role).toBe('owner');
  });
});

describe('repository addresses and discovery', () => {
  it('creates private defaults and explicit public repositories, derives slugs, and resolves team-wide and repository collisions', async () => {
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv);
    const first = organizationWithRepository(directory, alice, 'Hello, World!'), second = organizationWithRepository(directory, bob, 'Hello World');
    expect([first.slug, second.slug]).toEqual(['hello-world', 'hello-world-2']);
    expect(first.workspaces[0]).toMatchObject({ slug: 'repository', visibility: 'private' });
    const next = directory.createWorkspace(alice.id, first.id, 'Repository', 'public');
    expect(next.slug).toBe('repository-2');
    expect(directory.createWorkspace(alice.id, first.id, 'Repository').slug).toBe('repository-3');
    expect(directory.createWorkspace(alice.id, first.id, 'Private', 'private').visibility).toBe('private');
    expect(await directory.resolveRepository(null, first.slug, next.slug)).toEqual({ ok: true, data: {
      workspaceId: next.id, owner: { slug: first.slug, name: first.name, kind: 'organization' }, repo: { slug: next.slug, name: next.name }, visibility: 'public', canWrite: false,
    } });
  });
  it('never assigns a reserved owner, including collisions of 39-character names', async () => {
    const { RESERVED_OWNERS, SLUG } = await import('../../shared/routes');
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv);
    for (const [index, name] of [...RESERVED_OWNERS].entries()) {
      const team = organizationWithRepository(directory, { ...alice, id: `user-${index}` }, name);
      expect(RESERVED_OWNERS.has(team.slug)).toBe(false);
      expect(team.slug).toMatch(SLUG);
    }
    const long = 'a'.repeat(39);
    const a = organizationWithRepository(directory, alice, long), b = organizationWithRepository(directory, bob, long);
    expect(a.slug).toBe(long); expect(b.slug).toBe(`${'a'.repeat(37)}-2`); expect(b.slug).toMatch(SLUG);
    expect(organizationWithRepository(directory, { ...alice, id: 'unicode' }, '你好').slug).toMatch(/^organization-[a-z0-9]{6}$/);
  });
  it('migrates old rows privately, using only retained public import evidence, and is idempotent', async () => {
    const db = storageFixture();
    db.storage.sql.exec('CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.storage.sql.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)');
    for (const [id, name] of [['t1', 'API'], ['t2', 'API']]) db.storage.sql.exec('INSERT INTO teams VALUES (?, ?, ?)', id, name, '2026-01-01T00:00:00.000Z');
    for (const id of ['unknown', 'url', 'github-public', 'github-private']) db.storage.sql.exec('INSERT INTO workspaces VALUES (?, ?, ?, ?)', id, 't1', 'Same name', '2026-01-01T00:00:00.000Z');
    const env = { WORKSPACES: { getByName: (key: string) => ({ publicationMetadata: async () => ({ description: 'Imported',
      ...(key.endsWith(':url') || key.endsWith(':github-public') ? { sourcePublic: true } : key.endsWith(':github-private') ? { sourcePublic: false } : {}),
    }) }) } } as unknown as BraidEnv;
    let directory = new Directory(db.ctx, env);
    db.storage.sql.exec("INSERT INTO members VALUES ('t1', 'alice', 'owner')");
    expect(directory.list(alice)[0].workspaces.every(repo => repo.visibility === 'private')).toBe(true);
    await directory.dispatch(alice, 'list', {});
    const team = directory.list(alice)[0];
    expect(team.slug).toBe('api-2');
    expect(db.storage.sql.exec<{ slug: string }>("SELECT slug FROM teams WHERE id = 't2'").one().slug).toBe('api-3');
    expect(new Set(team.workspaces.map(repo => repo.slug)).size).toBe(4);
    expect(Object.fromEntries(team.workspaces.map(repo => [repo.id, repo.visibility]))).toEqual({ unknown: 'private', url: 'public', 'github-public': 'public', 'github-private': 'private' });
    directory.updateWorkspace(alice.id, { teamId: 't1', workspaceId: 'url', visibility: 'private' });
    directory = new Directory(db.ctx, env);
    await directory.dispatch(alice, 'list', {});
    expect(directory.list(alice)[0].workspaces.find(repo => repo.id === 'url')!.visibility).toBe('private');
    expect(directory.list(alice)[0].workspaces.map(repo => repo.slug)).toEqual(team.workspaces.map(repo => repo.slug));
  });
  it('keeps private choices and forces private GitHub imports private even after publication', () => {
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv), team = organizationWithRepository(directory, alice, 'Imports');
    const defaultRepo = team.workspaces[0], privateRepo = directory.createWorkspace(alice.id, team.id, 'Private choice', 'private');
    const publicRepo = directory.createWorkspace(alice.id, team.id, 'Public choice', 'public');
    directory.repositoryImported(defaultRepo.id, false, 'Private upstream');
    directory.repositoryImported(privateRepo.id, true, 'Public upstream');
    directory.repositoryImported(publicRepo.id, false, 'Private upstream, explicitly published');
    expect(Object.fromEntries(directory.list(alice)[0].workspaces.map(repo => [repo.id, repo.visibility]))).toEqual({ [defaultRepo.id]: 'private', [privateRepo.id]: 'private', [publicRepo.id]: 'private' });
  });
  it('lists public repositories by actual activity, pages ties once, and hides private repositories', async () => {
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv), team = organizationWithRepository(directory, alice, 'Explore', 'public');
    const repos = [team.workspaces[0], directory.createWorkspace(alice.id, team.id, 'Second', 'public'), directory.createWorkspace(alice.id, team.id, 'Third', 'public')];
    const privateRepo = directory.createWorkspace(alice.id, team.id, 'Secret', 'private');
    for (const repo of [...repos, privateRepo]) {
      directory.repositoryImported(repo.id, undefined, undefined, true);
      directory.repositoryActivity(repo.id, '2099-01-01T00:00:00.000Z', `About ${repo.slug}`);
    }
    directory.repositoryActivity(repos[0].id, '2099-01-02T00:00:00.000Z');
    directory.repositoryActivity(repos[0].id, '2000-01-01T00:00:00.000Z');
    const first = await directory.publicRepositories(2), second = await directory.publicRepositories(2, JSON.parse(atob(first.nextCursor!)));
    expect(first.items[0]).toEqual({ owner: { slug: team.slug, name: team.name }, repo: { slug: repos[0].slug, name: repos[0].name }, description: `About ${repos[0].slug}`, updatedAt: '2099-01-02T00:00:00.000Z' });
    expect(second.nextCursor).toBeNull();
    const slugs = [...first.items, ...second.items].map(repo => repo.repo.slug);
    expect(slugs).toHaveLength(3); expect(new Set(slugs).size).toBe(3); expect(slugs).not.toContain(privateRepo.slug);
  });
  it('requires an owner to edit and invalidates renamed addresses without changing the workspace ID', async () => {
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv), team = organizationWithRepository(directory, alice, 'Address');
    const repo = team.workspaces[0];
    await directory.accept(bob, (await directory.invite(alice.id, team.id, { email: bob.email, role: 'member' })).token);
    expect(() => directory.updateWorkspace(bob.id, { teamId: team.id, workspaceId: repo.id, visibility: 'private' })).toThrow(/owner/);
    const renamed = directory.updateWorkspace(alice.id, { teamId: team.id, workspaceId: repo.id, slug: 'new-address', name: 'New name', visibility: 'private' });
    expect(renamed).toMatchObject({ id: repo.id, slug: 'new-address', name: 'New name', visibility: 'private' });
    expect(await directory.resolveRepository(null, team.slug, repo.slug)).toEqual({ ok: false, status: 404, error: 'Repository not found.' });
    expect(await directory.resolveRepository(null, team.slug, renamed.slug)).toEqual(await directory.resolveRepository(null, team.slug, 'unknown'));
    expect(await directory.resolveRepository(bob.id, team.slug, renamed.slug)).toMatchObject({ ok: true, data: { canWrite: false } });
    expect(await directory.resolveRepository(alice.id, team.slug, renamed.slug)).toMatchObject({ ok: true, data: { canWrite: true } });
    const second = directory.createWorkspace(alice.id, team.id, 'Another');
    expect(() => directory.updateWorkspace(alice.id, { teamId: team.id, workspaceId: repo.id, slug: second.slug })).toThrow(/already/);
  });
});

describe('team display names', () => {
  it('renames without changing addresses, membership or repositories and requires an owner', async () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    const team = organizationWithRepository(directory, alice, 'Original', 'public');
    const invitation = await directory.invite(alice.id, team.id, { email: bob.email, role: 'member' });
    await directory.accept(bob, invitation.token);
    expect(() => directory.updateTeam(bob.id, { teamId: team.id, name: 'Forbidden' })).toThrow(/owner/);
    const renamed = directory.updateTeam(alice.id, { teamId: team.id, name: 'New team name' });
    expect(renamed).toEqual({ ...team, name: 'New team name' });
    const restarted = new Directory(db.ctx, {} as BraidEnv);
    expect(restarted.list(alice)[0].name).toBe('New team name');
    expect(restarted.auditLog(alice.id, team.id, Number.MAX_SAFE_INTEGER).map(entry => entry.action)).toContain('organization.name-changed');
    expect(await restarted.resolveRepository(null, team.slug, team.workspaces[0].slug)).toMatchObject({ ok: true, data: { owner: { slug: team.slug, name: 'New team name' } } });
    expect(restarted.authorize(bob.id, team.workspaces[0].id, false).role).toBe('member');
  });
  it('rejects a conflicting address without partially changing the name', () => {
    const directory = new Directory(storageFixture().ctx, {} as BraidEnv);
    const team = organizationWithRepository(directory, alice, 'Original'), other = organizationWithRepository(directory, bob, 'Other');
    expect(() => directory.updateTeam(alice.id, { teamId: team.id, name: 'Not saved', slug: other.slug })).toThrow(/already has/);
    expect(directory.list(alice)[0]).toEqual({ ...team, workspaces: team.workspaces.map(repo => ({ ...repo, canWrite: true })) });
  });
});
