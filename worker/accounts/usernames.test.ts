import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unoccupiedGitHubNames } from '../test/github-names';
beforeEach(() => { unoccupiedGitHubNames(); });
import type { AccountIdentity, Account, Organization } from '../../shared/account';
import { RESERVED_OWNERS, usernameSuggestion } from '../../shared/routes';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { Directory } from './directory';
import type { BraidEnv } from '../env';
import { ownerOf, personName } from '../repositories/provenance';
import { accountUsername, parse } from '../schemas';
import { Security } from './security';
import { storageFixture } from '../test/storage';

vi.mock('../changes/router', () => ({ changesRoute: async (_request: Request, _env: unknown, gateway: { person?: unknown }) => Response.json({ person: gateway.person }) }));
const alice = { id: 'alice', name: 'alice@example.com', email: 'alice@example.com' };
const bob = { id: 'bob', name: 'Bob', email: 'bob@example.com' };
const stores: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); vi.restoreAllMocks(); });
async function fixture() {
  const db = storageFixture(), store = storageFixture(); stores.push(db, store);
  const directory = new Directory(db.ctx, {} as BraidEnv), security = new Security(store.ctx, {} as BraidEnv);
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', SESSION_SECRET: 'username-tests-session-secret-at-least-32', PUBLIC_ORIGIN: 'https://braid.example',
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: () => Response.json({}) }) },
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
  } as unknown as BraidEnv;
  const login = async (user: AccountIdentity) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, user); return `__Host-braid-session=${token}`; };
  const cookie = await login(alice);
  const call = (path: string, options: { cookie?: string; method?: string; body?: unknown; workspace?: string } = {}) => api.fetch(new Request(`https://braid.example${path}`, {
    method: options.method ?? 'GET', headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.workspace ? { 'x-braid-workspace': options.workspace } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined,
  }), env);
  const choose = (username: string, token = cookie) => call('/api/account/username', { method: 'PATCH', cookie: token, body: { username } });
  return { db, directory, security, env, cookie, call, choose, login };
}

describe('username boundary and suggestions', () => {
  it.each(['a', '9', 'a-b', 'a'.repeat(39), 'Mixed-Case'])('accepts and canonicalizes %s', value => {
    expect(parse(accountUsername, { username: value })).toEqual({ username: value.toLowerCase() });
  });
  it.each(['', '-a', 'a-', 'a--b', 'a_b', 'a.b', 'a b', ' a ', 'é', 'a'.repeat(40), 'alice@example.com'])('rejects %s', value => {
    expect(() => parse(accountUsername, { username: value })).toThrow();
  });
  it('reserves all application owners case-insensitively', () => {
    for (const word of RESERVED_OWNERS) expect(() => parse(accountUsername, { username: word.toUpperCase() })).toThrow();
  });
  it('suggests from only the local part and handles reserved and empty names', () => {
    expect(usernameSuggestion('Maya.Chen+work@example.com')).toBe('maya-chen-work');
    expect(usernameSuggestion('API@example.com')).toBe('api-2');
    expect(usernameSuggestion('你好@example.com')).toBe('person');
  });
});

describe('personal account directory and API', () => {
  it('upgrades old accounts on read without claiming a name, then saves the first choice once', async () => {
    const f = await fixture();
    const before = await (await f.call('/api/account', { cookie: f.cookie })).json() as Account;
    expect(before).toMatchObject({ user: { username: null, avatarUrl: null, name: 'alice' }, usernameSuggestion: 'alice', personalOwner: null, organizations: [] });
    const chosen = await f.choose('Alice'); expect(chosen.status).toBe(200);
    const personal = await chosen.json() as { personalOwner: Organization };
    expect(personal.personalOwner).toMatchObject({ slug: 'alice', kind: 'user', role: 'owner', workspaces: [] });
    expect((await f.choose('ALICE')).status).toBe(200);
    const after = await (await f.call('/api/account', { cookie: f.cookie })).json() as Account & { teams: Organization[] };
    expect(after.user?.username).toBe('alice'); expect(after.organizations).toEqual([]);
    expect(after.teams).toEqual([after.personalOwner]);
    expect(new Directory(f.db.ctx, f.env).personalOwner(alice.id)?.id).toBe(personal.personalOwner.id);
  });
  it('claims a free GitHub login, suggests a collision, and keeps a deliberate rename on future sign-ins', async () => {
    const f = await fixture();
    const org = f.directory.createOrganization(bob, 'Maya');
    expect(f.directory.account(alice, { id: 123, login: 'Maya' }, true)).toMatchObject({ user: { username: null }, usernameSuggestion: 'maya-2' });
    const free = f.directory.account(bob, { id: 234, login: 'BOB' }, true);
    expect(free.user).toMatchObject({ username: 'bob', avatarUrl: '/api/owners/bob/avatar' });
    f.directory.setUsername(bob, 'bob-new');
    expect(f.directory.account(bob, { id: 234, login: 'BOB' }, true).user.username).toBe('bob-new');
    expect(f.directory.ownerRepositories(null, org.slug).ok).toBe(false);
  });
  it('reserves one namespace for people, organizations, existing slugs and every old address', async () => {
    const f = await fixture(); const org = f.directory.createOrganization(bob, 'Acme');
    expect((await f.choose('ACME')).status).toBe(409);
    f.directory.updateTeam(bob.id, { teamId: org.id, slug: 'acme-new' });
    expect((await f.choose('acme')).status).toBe(409);
    expect((await f.choose('alice')).status).toBe(200);
    expect(f.directory.createOrganization(bob, 'Alice').slug).toBe('alice-2');
    expect(() => f.directory.updateTeam(bob.id, { teamId: org.id, slug: 'alice' })).toThrow(/already/);
    expect((await f.choose('alice-new')).status).toBe(200);
    expect((await f.choose('ALICE', await f.login(bob))).status).toBe(409);
  });
  it('creates repositories directly under a personal owner and excludes it from organization limits', async () => {
    const f = await fixture(); await f.choose('alice');
    const owner = f.directory.personalOwner(alice.id)!;
    const response = await f.call(`/api/owners/${owner.id}/workspaces`, { method: 'POST', cookie: f.cookie, body: { name: 'App', visibility: 'private' } });
    expect(response.status).toBe(201);
    const repo = await response.json() as { id: string };
    expect(f.directory.authorize(alice.id, repo.id, true).role).toBe('owner');
    expect(() => f.directory.authorize(bob.id, repo.id, false)).toThrow(/not found/);
    for (const name of ['One', 'Two', 'Three']) f.directory.createOrganization(alice, name);
    expect(f.directory.list(alice)).toHaveLength(3);
    expect(() => f.directory.createOrganization(alice, 'Four')).toThrow(/three/);
  });
  it('does not allow personal owners to acquire people, teams or invitations through legacy APIs', async () => {
    const f = await fixture(); await f.choose('alice'); const id = f.directory.personalOwner(alice.id)!.id;
    const requests = [f.call(`/api/orgs/${id}/teams`, { cookie: f.cookie }), f.call(`/api/orgs/${id}/teams`, { cookie: f.cookie, method: 'POST', body: { name: 'Engineering' } }),
      f.call(`/api/teams/${id}/members`, { cookie: f.cookie }), f.call(`/api/orgs/${id}/invites`, { cookie: f.cookie, method: 'POST', body: { email: bob.email, role: 'owner' } }),
      f.call(`/api/orgs/${id}`, { cookie: f.cookie, method: 'PATCH', body: { slug: 'hijack' } }), f.call(`/api/teams/${id}/members/alice`, { cookie: f.cookie, method: 'DELETE' })];
    for (const response of await Promise.all(requests)) expect(response.status).toBe(404);
    expect(f.directory.personalOwner(alice.id)?.slug).toBe('alice');
  });
  it('shows public repositories to visitors, all to their owner, and retains profile and repository aliases', async () => {
    const f = await fixture(); await f.choose('alice'); const owner = f.directory.personalOwner(alice.id)!;
    f.directory.createWorkspace(alice.id, owner.id, 'Secret', 'private');
    f.directory.createWorkspace(alice.id, owner.id, 'Public', 'public');
    for (const cookie of [undefined, await f.login(bob)]) {
      const profile = await (await f.call('/api/owners/alice', { cookie })).json() as { owner: { kind: string }; repositories: { slug: string }[] };
      expect(profile.owner.kind).toBe('user'); expect(profile.repositories.map(r => r.slug)).toEqual(['public']);
      expect(JSON.stringify(profile)).not.toContain(alice.email);
      expect((await f.call('/api/repos/alice/secret', { cookie })).status).toBe(404);
    }
    expect(f.directory.ownerRepositories(alice.id, 'alice')).toMatchObject({ ok: true, data: { repositories: expect.arrayContaining([expect.objectContaining({ slug: 'secret' })]) } });
    await f.choose('alice-new');
    expect(await (await f.call('/api/owners/alice')).json()).toMatchObject({ owner: { kind: 'user', slug: 'alice-new' } });
    expect(await (await f.call('/api/repos/alice/public')).json()).toMatchObject({ owner: { slug: 'alice-new', kind: 'user' } });
    expect((await (await f.call('/api/account', { cookie: f.cookie })).json() as Account).user?.username).toBe('alice-new');
  });
  it('allows an empty or private-only personal profile without revealing private repositories', async () => {
    const f = await fixture(); await f.choose('alice');
    for (const createPrivate of [false, true]) {
      if (createPrivate) f.directory.createWorkspace(alice.id, f.directory.personalOwner(alice.id)!.id, 'Secret');
      expect(await (await f.call('/api/owners/alice')).json()).toMatchObject({ owner: { slug: 'alice', kind: 'user' }, repositories: [] });
    }
  });
  it('hydrates linked email account avatars without deriving anything from the account id', async () => {
    const f = await fixture(); await f.choose('alice'); await f.security.recordGitHubIdentity(alice.id, { id: 123, login: 'different-login' }, 'sign-in');
    expect(await (await f.call('/api/account', { cookie: f.cookie })).json()).toMatchObject({ user: { id: 'alice', username: 'alice', avatarUrl: '/api/owners/alice/avatar' } });
    const fetchAvatar = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image-bytes', { headers: { 'content-type': 'image/png' } }));
    const response = await f.call('/api/owners/alice/avatar'); expect(response.status).toBe(200);
    expect(fetchAvatar).toHaveBeenCalledWith('https://avatars.githubusercontent.com/u/123?s=192', expect.objectContaining({ redirect: 'manual' }));
    expect(response.headers.get('cache-control')).toContain('max-age');
  });
  it('uses handles in comments, members, Access and audit records without exposing emails', async () => {
    const f = await fixture(); await f.choose('alice'); f.directory.setUsername(bob, 'bob');
    const org = f.directory.createOrganization(alice, 'Acme'), repo = f.directory.createWorkspace(alice.id, org.id, 'App');
    await f.directory.accept(bob, (await f.directory.invite(alice.id, org.id, { email: bob.email, role: 'member' })).token);
    for (const data of [f.directory.members(alice.id, org.id), f.directory.repositoryAccess(alice.id, org.id, repo.id), f.directory.auditLog(alice.id, org.id, Number.MAX_SAFE_INTEGER)]) {
      expect(JSON.stringify(data)).toContain('@alice'); expect(JSON.stringify(data)).not.toMatch(/alice@example|bob@example/);
    }
    const comment = await f.call('/api/changes/ch_123456789abcd/comments', { cookie: f.cookie, method: 'POST', workspace: repo.id, body: { body: 'Hello' } });
    expect(comment.status).toBe(200); expect(await comment.json()).toMatchObject({ person: { name: '@alice', owner: { name: '@alice' } } });
  });
  it('requires sign-in, validates payloads and keeps existing names on rejection', async () => {
    const f = await fixture();
    expect((await f.choose('alice', '')).status).toBe(401);
    for (const name of ['api', 'a--b', 'a'.repeat(40)]) expect((await f.choose(name)).status).toBe(400);
    await f.choose('alice');
    expect((await f.call('/api/account/username', { method: 'PATCH', cookie: f.cookie, body: { username: 'changed', id: bob.id } })).status).toBe(400);
    expect(f.directory.personalOwner(alice.id)?.slug).toBe('alice');
  });
  it('migrates old Directory rows without changing existing slugs or memberships', async () => {
    const db = storageFixture(); stores.push(db);
    db.storage.sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL)');
    db.storage.sql.exec('INSERT INTO users VALUES (?, ?, ?)', alice.id, alice.email, alice.name);
    db.storage.sql.exec('CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, slug TEXT)');
    db.storage.sql.exec("INSERT INTO teams VALUES ('org', 'Alice', '2026-01-01', 'alice')");
    const directory = new Directory(db.ctx, {} as BraidEnv);
    expect(directory.account(alice)).toMatchObject({ user: { username: null }, usernameSuggestion: 'alice-2', personalOwner: null });
    expect(() => directory.setUsername(alice, 'alice')).toThrow(/taken/);
    directory.setUsername(alice, 'alice-2');
    const restarted = new Directory(db.ctx, {} as BraidEnv);
    expect(restarted.account(alice).user.username).toBe('alice-2');
    expect(db.storage.sql.exec<{ kind: string; slug: string }>("SELECT kind, slug FROM teams WHERE id = 'org'").one()).toEqual({ kind: 'organization', slug: 'alice' });
  });
});

it('uses the username for provenance without a GitHub login, preserving no-reply Git authors', () => {
  expect(ownerOf({ ...alice, username: 'alice' }, null)).toMatchObject({ name: '@alice' });
  expect(personName('@alice')).toBe('@alice');
  expect(ownerOf({ ...alice, username: 'alice' }, { id: 12, login: 'gh-alice' })).toMatchObject({ github: 'gh-alice', email: '12+gh-alice@users.noreply.github.com' });
});
