import { organizationWithRepository } from '../test/organization';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unoccupiedGitHubNames } from '../test/github-names';
beforeEach(() => { unoccupiedGitHubNames(); });
import type { AccountIdentity } from '../../shared/account';
import type { OwnerRepositories } from '../../shared/owners';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { Directory } from './directory';
import type { BraidEnv } from '../env';
import { Security } from './security';
import { storageFixture } from '../test/storage';

const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' };
const bob = { id: 'bob', email: 'bob@example.com', name: 'Bob' };
const outsider = { id: 'outside', email: 'outside@example.com', name: 'Outside' };

function fixture() {
  const db = storageFixture(), store = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv), security = new Security(store.ctx, {} as BraidEnv);
  const workspace = vi.fn(() => { throw new Error('Owner listings must not read workspaces.'); });
  const env = {
    AUTH_MODE: 'github', SESSION_SECRET: 'owner-pages-test-session-secret-123456789',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { get: workspace, getByName: workspace },
  } as unknown as BraidEnv;
  const team = organizationWithRepository(directory, alice, 'ACM VIT');
  const publicRepo = directory.createWorkspace(alice.id, team.id, 'ExamCooker', 'public');
  directory.repositoryActivity(publicRepo.id, '2099-10-11T10:00:00.000Z', 'Past papers');
  const call = (slug: string, cookie?: string, method = 'GET', extra: Record<string, string> = {}) => api.fetch(new Request(`https://braid.example/api/owners/${slug}`, {
    method, headers: { 'cf-connecting-ip': '198.51.100.7', ...(cookie ? { cookie } : {}), ...extra },
  }), env);
  const login = async (user: AccountIdentity) => {
    const token = await sessionToken(env.SESSION_SECRET);
    await security.issue(await digest(token), Date.now() + 86_400_000, user);
    return `__Host-braid-session=${token}`;
  };
  return { db, store, directory, security, env, workspace, team, publicRepo, call, login };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.db.db.close(); f.store.db.close(); vi.restoreAllMocks(); });

describe('owner repository listings', () => {
  it('shows only public repositories to visitors and signed-in nonmembers', async () => {
    organizationWithRepository(f.directory, outsider, 'Another team', 'public');
    for (const cookie of [undefined, await f.login(outsider)]) {
      const response = await f.call(f.team.slug, cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        owner: { slug: 'acm-vit', name: 'ACM VIT', kind: 'organization' },
        repositories: [{ slug: 'examcooker', name: 'ExamCooker', description: 'Past papers', visibility: 'public', updatedAt: '2099-10-11T10:00:00.000Z' }],
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it('shows all repositories to owners and members, newest activity first', async () => {
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'member' })).token);
    for (const user of [alice, bob]) {
      const response = await f.call(f.team.slug, await f.login(user));
      expect(response.status).toBe(200);
      const page = await response.json() as OwnerRepositories;
      expect(page.repositories.map(repo => [repo.slug, repo.visibility])).toEqual([['examcooker', 'public'], ['repository', 'private']]);
      expect(page.repositories[1].description).toBe('');
      expect(page.repositories[1].updatedAt).toBe(f.team.workspaces[0].createdAt);
    }
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it('returns the same 404 for unknown, private-only and empty teams to nonmembers', async () => {
    const hidden = organizationWithRepository(f.directory, alice, 'Hidden');
    const empty = organizationWithRepository(f.directory, alice, 'Empty');
    f.db.storage.sql.exec('DELETE FROM workspaces WHERE team_id = ?', empty.id);
    for (const cookie of [undefined, await f.login(outsider)]) {
      for (const slug of ['unknown', hidden.slug, empty.slug]) {
        const response = await f.call(slug, cookie);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Owner not found.', requestId: expect.any(String) });
      }
    }
    const response = await f.call(empty.slug, await f.login(alice));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ owner: { slug: empty.slug, name: empty.name, kind: 'organization' }, repositories: [], memberCount: 1 });
    expect((await f.call(hidden.slug, await f.login(alice))).status).toBe(200);
  });

  it('honours membership revocation immediately, including after a directory restart', async () => {
    await f.directory.accept(bob, (await f.directory.invite(alice.id, f.team.id, { email: bob.email, role: 'member' })).token);
    const cookie = await f.login(bob);
    expect((await (await f.call(f.team.slug, cookie)).json() as OwnerRepositories).repositories).toHaveLength(2);
    f.directory.removeMember(alice.id, f.team.id, bob.id);
    expect((await (await f.call(f.team.slug, cookie)).json() as OwnerRepositories).repositories.map(repo => repo.slug)).toEqual(['examcooker']);
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.publicRepo.id, visibility: 'private' });
    expect((await f.call(f.team.slug, cookie)).status).toBe(404);
    const restarted = new Directory(f.db.ctx, {} as BraidEnv);
    expect(restarted.ownerRepositories(bob.id, f.team.slug)).toEqual({ ok: false, status: 404, error: 'Owner not found.' });
  });

  it('resolves old team slugs to canonical team and repository names', async () => {
    f.directory.updateTeam(alice.id, { teamId: f.team.id, slug: 'acmvit', name: 'ACM at VIT' });
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.publicRepo.id, slug: 'past-papers', name: 'Past Papers' });
    const response = await f.call(f.team.slug);
    expect(await response.json()).toMatchObject({ owner: { slug: 'acmvit', name: 'ACM at VIT' }, repositories: [{ slug: 'past-papers', name: 'Past Papers' }] });
  });

  it('redacts emails and credentials in all metadata even for members', async () => {
    const secret = 'braid_agent_' + 'a1b2c3d4'.repeat(8);
    f.directory.updateTeam(alice.id, { teamId: f.team.id, name: 'ACM alice@example.com' });
    f.directory.updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.publicRepo.id, name: 'Contact bob@example.com' });
    f.directory.repositoryActivity(f.publicRepo.id, '2099-10-11T10:00:00.000Z', `Ask alice@example.com with ${secret}`);
    for (const cookie of [undefined, await f.login(alice)]) {
      const response = await f.call(f.team.slug, cookie);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toMatch(/alice@example|bob@example|braid_agent_/);
      expect(body).toContain('[private email]');
      expect(body).not.toMatch(/"(?:id|teamId|workspaceId|members|email|canWrite)":/);
    }
  });

  it.each(['UPPERCASE', 'two--hyphens', '-start', 'end-', 'a'.repeat(40), '%2fprivate', '%E0%A4%A'])('rejects invalid slug %s before the directory read', async slug => {
    const read = vi.spyOn(f.directory, 'ownerRepositories');
    const response = await f.call(slug);
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('accepts an encoded valid slug and HEAD without returning a body', async () => {
    expect((await f.call('acm%2Dvit')).status).toBe(200);
    const response = await f.call(f.team.slug, undefined, 'HEAD');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect((await f.call('unknown', undefined, 'HEAD')).status).toBe(404);
  });

  it('ignores forged membership and repository selection headers', async () => {
    const response = await f.call(f.team.slug, undefined, 'GET', { 'x-braid-role': 'owner', 'x-braid-team': f.team.id, 'x-braid-workspace': f.team.workspaces[0].id });
    expect(response.status).toBe(200);
    expect((await response.json() as OwnerRepositories).repositories.map(repo => repo.visibility)).toEqual(['public']);
  });

  it('charges the same anonymous binding before lookup, including signed-in callers and missing teams', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    f.env.ANONYMOUS_LIMITER = { limit } as unknown as RateLimit;
    const read = vi.spyOn(f.directory, 'ownerRepositories');
    for (const cookie of [undefined, await f.login(alice), await f.login(outsider)]) {
      for (const slug of [f.team.slug, 'unknown']) {
        const response = await f.call(slug, cookie);
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('60');
      }
    }
    expect(limit).toHaveBeenCalledTimes(6);
    expect(read).not.toHaveBeenCalled();
  });

  it('shares the fallback public budget with /api/repos', async () => {
    const listing = await api.fetch(new Request('https://braid.example/api/repos?limit=20', { headers: { 'cf-connecting-ip': '198.51.100.7' } }), f.env);
    expect(listing.status).toBe(200);
    const key = `public:${await digest('198.51.100.7')}`;
    for (let i = 1; i < 300; i++) expect((await f.security.consume(key, 300, 60_000)).allowed).toBe(true);
    const read = vi.spyOn(f.directory, 'ownerRepositories');
    expect((await f.call(f.team.slug)).status).toBe(429);
    expect(read).not.toHaveBeenCalled();
  });
});
