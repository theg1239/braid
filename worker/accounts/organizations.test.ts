import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unoccupiedGitHubNames } from '../test/github-names';
beforeEach(() => { unoccupiedGitHubNames(); });
afterEach(() => vi.restoreAllMocks());
import { Directory } from './directory';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';
import { checkAuthorization } from '../http/authorization';

const owner = { id: 'owner', name: 'Owner', email: 'owner@example.com' };
const member = { id: 'member', name: 'Member', email: 'member@example.com' };
const other = { id: 'other', name: 'Other', email: 'other@example.com' };
async function fixture() {
  const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
  const org = directory.createOrganization(owner, 'Acme');
  const repo = directory.createWorkspace(owner.id, org.id, 'App');
  await directory.accept(member, (await directory.invite(owner.id, org.id, { email: member.email, role: 'member' })).token);
  const team = directory.createOrgTeam(owner.id, { orgId: org.id, name: 'Engineering', description: 'Build the app' }).team;
  return { db, directory, org, repo, team, input: { orgId: org.id, teamId: team.id } };
}
describe('organizations and people', () => {
  it('creates no repositories through the canonical action or the legacy alias', async () => {
    const db = storageFixture(), directory = new Directory(db.ctx, {} as BraidEnv);
    for (const action of ['createOrganization', 'createTeam'] as const) {
      const result = await directory.dispatch(owner, action, { name: action });
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.parse(result.data).workspaces).toEqual([]);
    }
    expect(db.storage.sql.exec('SELECT * FROM workspaces').toArray()).toEqual([]);
  });
  it('keeps existing repositories, addresses and permissions across repeated migrations', async () => {
    const f = await fixture();
    let directory = new Directory(f.db.ctx, {} as BraidEnv);
    directory = new Directory(f.db.ctx, {} as BraidEnv);
    expect(directory.list(owner)[0].workspaces[0]).toMatchObject({ id: f.repo.id, organizationId: f.org.id, slug: 'app', visibility: 'private' });
    expect(directory.ownerRepositories(null, f.org.slug)).toMatchObject({ ok: false, status: 404 });
    expect(directory.ownerRepositories(owner.id, f.org.slug)).toMatchObject({ ok: true, data: { memberCount: 2 } });
  });
  it('never returns another person’s email in people, team details, invitations or repository access', async () => {
    const f = await fixture();
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'member' });
    const invite = await f.directory.invite(owner.id, f.org.id, { email: other.email, role: 'member' });
    for (const user of [owner, member]) {
      const roster = f.directory.members(user.id, f.org.id);
      expect(roster.members.find(person => person.self)?.email).toBeUndefined();
      expect(roster.members.find(person => !person.self)?.email).toBeUndefined();
      expect(JSON.stringify(roster)).not.toContain(other.email);
    }
    expect(JSON.stringify(invite)).not.toContain(other.email);
    expect(JSON.stringify(f.directory.teamDetail(owner.id, f.org.id, f.team.id))).not.toContain(member.email);
    expect(JSON.stringify(f.directory.repositoryAccess(member.id, f.org.id, f.repo.id))).not.toContain(owner.email);
    const replaced = await f.directory.replaceInvite(owner.id, f.org.id, invite.id);
    await expect(f.directory.accept(other, invite.token)).rejects.toThrow();
    await f.directory.accept(other, replaced.token);
  });
  it('hides email-shaped legacy account IDs and accepts opaque IDs for membership changes', async () => {
    const f = await fixture(), legacy = { id: 'email:private@example.com', email: 'private@example.com', name: 'private@example.com' };
    await f.directory.accept(legacy, (await f.directory.invite(owner.id, f.org.id, { email: legacy.email, role: 'member' })).token);
    const person = f.directory.members(owner.id, f.org.id).members.find(person => person.id === `person:${f.directory.publicPerson(legacy.id)}`)!;
    expect(person).toBeDefined(); expect(JSON.stringify(person)).not.toContain(legacy.email);
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: person.id, role: 'maintainer' });
    expect(JSON.stringify(f.directory.teamDetail(owner.id, f.org.id, f.team.id))).not.toContain(legacy.email);
    f.directory.updateMember(owner.id, { teamId: f.org.id, memberId: person.id, role: 'owner' });
    expect(JSON.stringify(f.directory.auditLog(owner.id, f.org.id, Number.MAX_SAFE_INTEGER))).not.toContain(legacy.email);
    f.directory.removeMember(owner.id, f.org.id, person.id);
    expect(() => f.directory.authorize(legacy.id, f.repo.id, false)).toThrow(/not found/);
  });
  it('requires organization owners to change roles and retains at least one owner', async () => {
    const f = await fixture();
    expect(() => f.directory.updateMember(member.id, { teamId: f.org.id, memberId: member.id, role: 'owner' })).toThrow(/organization owner/);
    expect(() => f.directory.updateMember(owner.id, { teamId: f.org.id, memberId: owner.id, role: 'member' })).toThrow(/at least one owner/);
    f.directory.updateMember(owner.id, { teamId: f.org.id, memberId: member.id, role: 'owner' });
    f.directory.updateMember(owner.id, { teamId: f.org.id, memberId: owner.id, role: 'member' });
    expect(f.directory.list(owner)[0].role).toBe('member');
  });
});
describe('teams and repository grants', () => {
  it('denies a member without a grant, denies Read, permits Write and revokes it immediately', async () => {
    const f = await fixture();
    expect(f.directory.authorize(member.id, f.repo.id, false).role).toBe('member');
    expect(() => f.directory.authorize(member.id, f.repo.id, true)).toThrow(/write access/);
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'member' });
    f.directory.setTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id, permission: 'read' });
    expect(() => f.directory.authorize(member.id, f.repo.id, true)).toThrow(/write access/);
    f.directory.setTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id, permission: 'write' });
    expect(f.directory.authorize(member.id, f.repo.id, true)).toMatchObject({ role: 'owner', organizationRole: 'member' });
    expect(await f.directory.resolveRepository(member.id, f.org.slug, f.repo.slug)).toMatchObject({ ok: true, data: { canWrite: true } });
    expect(f.directory.list(member)[0].workspaces[0].canWrite).toBe(true);
    f.directory.removeTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id });
    expect(() => f.directory.authorize(member.id, f.repo.id, true)).toThrow(/write access/);
    expect(f.directory.list(member)[0].workspaces[0].canWrite).toBe(false);
  });
  it('does not turn repository Write into organization administration', async () => {
    const f = await fixture();
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'maintainer' });
    f.directory.setTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id, permission: 'write' });
    expect(() => f.directory.createWorkspace(member.id, f.org.id, 'No')).toThrow(/organization owner/);
    expect(() => f.directory.updateWorkspace(member.id, { teamId: f.org.id, workspaceId: f.repo.id, visibility: 'public' })).toThrow(/organization owner/);
    expect(() => f.directory.updateWorkspace(member.id, { teamId: f.org.id, workspaceId: f.repo.id, name: 'No', slug: 'no' })).toThrow(/organization owner/);
    expect(() => f.directory.updateTeam(member.id, { teamId: f.org.id, name: 'No' })).toThrow(/organization owner/);
    await expect(f.directory.invite(member.id, f.org.id, { email: other.email, role: 'owner' })).rejects.toThrow(/organization owner/);
    expect(() => f.directory.deleteOrgTeam(member.id, f.input)).toThrow(/organization owner/);
    expect(() => f.directory.setTeamRepository(member.id, { ...f.input, workspaceId: f.repo.id, permission: 'write' })).toThrow(/organization owner/);
  });
  it('allows maintainers to manage their team members but not another team', async () => {
    const f = await fixture();
    await f.directory.accept(other, (await f.directory.invite(owner.id, f.org.id, { email: other.email, role: 'member' })).token);
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'maintainer' });
    expect(f.directory.setTeamMember(member.id, { ...f.input, memberId: other.id, role: 'member' }).members).toHaveLength(2);
    const second = f.directory.createOrgTeam(owner.id, { orgId: f.org.id, name: 'Design' }).team;
    expect(() => f.directory.setTeamMember(member.id, { ...f.input, teamId: second.id, memberId: other.id, role: 'member' })).toThrow(/maintainer/);
    f.directory.removeTeamMember(member.id, { ...f.input, memberId: other.id });
    expect(f.directory.teamDetail(member.id, f.org.id, f.team.id).members).toHaveLength(1);
  });
  it('never grants across organizations even when a person belongs to both', async () => {
    const f = await fixture();
    const foreign = f.directory.createOrganization(other, 'Other organization');
    const repo = f.directory.createWorkspace(other.id, foreign.id, 'Other app');
    await f.directory.accept(member, (await f.directory.invite(other.id, foreign.id, { email: member.email, role: 'member' })).token);
    expect(() => f.directory.setTeamMember(owner.id, { ...f.input, memberId: other.id, role: 'member' })).toThrow(/not found/);
    expect(() => f.directory.setTeamRepository(owner.id, { ...f.input, workspaceId: repo.id, permission: 'write' })).toThrow(/not found/);
    expect(() => f.directory.teamDetail(other.id, foreign.id, f.team.id)).toThrow(/not found/);
    // Even inconsistent persisted grant rows cannot bypass the organization joins.
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'member' });
    f.db.storage.sql.exec("INSERT INTO org_team_repositories VALUES (?, ?, 'write')", f.team.id, repo.id);
    expect(() => f.directory.authorize(member.id, repo.id, true)).toThrow(/write access/);
    expect(f.directory.teamDetail(owner.id, f.org.id, f.team.id).repositories).toEqual([]);
  });
  it.each(['grant', 'membership', 'organization', 'team'] as const)('revokes %s access across restarts and the landing authorization recheck', async revoke => {
    const f = await fixture();
    f.directory.setTeamMember(owner.id, { ...f.input, memberId: member.id, role: 'member' });
    f.directory.setTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id, permission: 'write' });
    let directory = f.directory;
    const env = { LIVE_ENABLED: 'true', DIRECTORY: { idFromName: (name: string) => name, get: () => directory } } as unknown as BraidEnv;
    const authorization = { user: member, workspaceId: f.repo.id, teamId: f.org.id };
    await expect(checkAuthorization(env, authorization)).resolves.toBeUndefined();
    if (revoke === 'grant') directory.setTeamRepository(owner.id, { ...f.input, workspaceId: f.repo.id, permission: 'read' });
    if (revoke === 'membership') directory.removeTeamMember(owner.id, { ...f.input, memberId: member.id });
    if (revoke === 'organization') directory.removeMember(owner.id, f.org.id, member.id);
    if (revoke === 'team') directory.deleteOrgTeam(owner.id, f.input);
    directory = new Directory(f.db.ctx, {} as BraidEnv);
    await expect(checkAuthorization(env, authorization)).rejects.toThrow(/no longer/);
    if (revoke === 'organization') {
      await directory.accept(member, (await directory.invite(owner.id, f.org.id, { email: member.email, role: 'member' })).token);
      expect(() => directory.authorize(member.id, f.repo.id, true)).toThrow(/write access/);
    }
    expect(directory.auditLog(owner.id, f.org.id, Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(5);
  });
});
