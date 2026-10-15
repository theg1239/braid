import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { Directory } from '../accounts/directory';
import { Workspace } from '../workspace/workspace';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

const origin = 'https://braid.example';
const githubToken = `gho_${'a'.repeat(36)}`;
const stores: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.db.close(); });

/** GitHub as the GitHub CLI's token sees it: `/user`, and `/user/emails` only when the token has the user:email scope. */
function github({ status = 200, email = null as string | null, emails = [{ email: 'octo@example.test', verified: true, primary: true }] as { email: string; verified: boolean; primary: boolean }[] | null } = {}) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    if (url === 'https://api.github.com/user') return status === 200 ? Response.json({ id: 4242, login: 'Octo', name: 'Octo Cat', email }) : new Response(null, { status });
    if (url === 'https://api.github.com/user/emails') return emails ? Response.json(emails) : new Response(null, { status: 404 });
    throw new Error(`Unexpected request to ${url}`);
  }));
  return seen;
}

async function fixture(overrides: Partial<BraidEnv> = {}) {
  const people = storageFixture(), secrets = storageFixture();
  stores.push(people, secrets);
  const send = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: 'sent' }));
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: origin, SESSION_SECRET: 'agent-signup-session-secret-of-32-chars', GITHUB_CLIENT_ID: 'Iv1.braid',
    EMAIL: { send }, EMAIL_FROM: 'braid@braid.example', ...overrides } as unknown as BraidEnv;
  const directory = new Directory(people.ctx, env), security = new Security(secrets.ctx, env);
  Object.assign(env, { DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } });
  const post = (path: string, body: object, ip = '203.0.113.9') => api.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), env);
  const json = async <T = Record<string, unknown>>(response: Response) => await response.json() as T;
  return { env, directory, security, secrets, send, post, json };
}
type Connection = { accessToken: string; tokenType: string; expiresAt: string; workspaceId: string; scope: string; repository: string; account: { username: string | null } };

async function setupStorage(f: Awaited<ReturnType<typeof fixture>>) {
  const workspaces = new Map<string, Workspace>();
  let imported = false;
  const head = 'a'.repeat(40);
  const repo = { [Symbol.dispose]() {}, info: async () => ({ remote: 'https://git.example/repo', defaultBranch: 'main' }),
    log: async () => imported ? [{ hash: head }] : [], revokeToken: vi.fn(async () => {}),
    readCommit: async () => ({ treeHash: 'b'.repeat(40) }), readTree: async () => [] };
  const artifacts = { get: vi.fn(async () => repo), create: vi.fn(async () => ({ remote: 'https://git.example/repo', defaultBranch: 'main', token: 'secret' })),
    import: vi.fn(async () => { imported = true; return { remote: 'https://git.example/repo', defaultBranch: 'main', token: 'secret' }; }) };
  Object.assign(f.env, { ARTIFACTS: artifacts, WORKSPACES: { getByName: (key: string) => {
    let workspace = workspaces.get(key);
    if (!workspace) { const store = storageFixture(); stores.push(store); workspace = new Workspace(store.ctx, f.env); workspaces.set(key, workspace); }
    return workspace;
  } } });
  return { artifacts, workspaces };
}

describe('agents that sign the person up with the GitHub CLI', () => {
  it('creates the account by the GitHub sign-in rules, then connects once the person has a repository', async () => {
    const f = await fixture();
    const seen = github();
    const first = await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' });
    expect(first.status).toBe(409);
    expect(await f.json(first)).toMatchObject({ code: 'repository_required', repositories: [], account: { username: 'octo' } });
    expect(seen.every(header => header === `Bearer ${githubToken}`)).toBe(true);
    const person = await f.security.profile({ id: 'github:4242', email: 'octo@example.test', name: 'Octo Cat' });
    expect(await f.security.githubIdentity(person.id)).toEqual({ id: 4242, login: 'Octo' });
    const owner = f.directory.personalOwner(person.id)!;
    const web = f.directory.createWorkspace(person.id, owner.id, 'web');

    const connected = await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' });
    expect(connected.status).toBe(201);
    const connection = await f.json<Connection>(connected);
    expect(connection).toMatchObject({ tokenType: 'Bearer', workspaceId: web.id, scope: 'work', repository: 'octo/web', account: { username: 'octo' } });
    expect(connection.accessToken).toMatch(/^braid_agent_/);
    expect(Date.parse(connection.expiresAt) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // The connection works as an approved one does, and nothing kept the GitHub token.
    const session = await api.fetch(new Request(`${origin}/api/agent/session`, { method: 'POST', headers: { authorization: `Bearer ${connection.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5' }) }), f.env);
    expect(session.status).toBe(200);
    expect(await f.json(session)).toMatchObject({ workspaceId: web.id, agent: { name: 'Claude Code' } });
    for (const table of f.secrets.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      expect(JSON.stringify(f.secrets.db.prepare(`SELECT * FROM "${table.name}"`).all())).not.toContain(githubToken);
  });

  it('asks which repository when there are several, and refuses one the person cannot write', async () => {
    const f = await fixture();
    github();
    const person = await f.security.profile({ id: 'github:4242', email: 'octo@example.test', name: 'Octo Cat' });
    await f.directory.account(person, { id: 4242, login: 'Octo' }, true);
    const owner = f.directory.personalOwner(person.id)!;
    const [web, docs] = ['web', 'docs'].map(name => f.directory.createWorkspace(person.id, owner.id, name));
    const several = await f.post('/api/agent/github', { token: githubToken, name: 'Codex', scope: 'setup' });
    expect(several.status).toBe(409);
    const listed = await f.json<{ code: string; repositories: string[] }>(several);
    expect(listed.code).toBe('repository_required');
    expect(listed.repositories.sort()).toEqual(['octo/docs', 'octo/web']);
    const named = await f.json<Connection>(await f.post('/api/agent/github', { token: githubToken, name: 'Codex', scope: 'setup', repository: 'octo/docs' }));
    expect(named).toMatchObject({ workspaceId: docs.id, scope: 'setup', repository: 'octo/docs' });
    expect(Date.parse(named.expiresAt) - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(await f.json<Connection>(await f.post('/api/agent/github', { token: githubToken, name: 'Codex', workspaceId: web.id }))).toMatchObject({ repository: 'octo/web' });
    const stranger = { id: 'someone', email: 'someone@example.test', name: 'Someone' };
    const theirs = f.directory.createWorkspace(stranger.id, f.directory.createOrganization(stranger, 'Elsewhere').id, 'private-repo', 'private');
    expect((await f.post('/api/agent/github', { token: githubToken, name: 'Codex', workspaceId: theirs.id })).status).toBe(404);
    expect((await f.post('/api/agent/github', { token: githubToken, name: 'Codex', scope: 'fleet', workspaceId: web.id })).status).toBe(400);
  });

  it('uses immutable identity without trusting a profile email or requiring email scope', async () => {
    const f = await fixture();
    github({ emails: null, email: 'Octo@Example.test' });
    expect((await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' })).status).toBe(409);
    expect((await f.security.profile({ id: 'github:4242', email: 'unused@example.test', name: 'Octo' })).email).toBe('');
    github({ emails: null, email: null });
    const silent = await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' }, '203.0.113.10');
    expect(silent.status).toBe(409);
    expect(await f.json(silent)).toMatchObject({ code: 'repository_required' });
    github({ status: 401 });
    const refused = await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' }, '203.0.113.11');
    expect(refused.status).toBe(401);
    expect(await f.json(refused)).toMatchObject({ code: 'github_token' });
  });

  it('creates a private imported repo for a new GitHub identity without email and reconnects to it', async () => {
    const f = await fixture(), setup = await setupStorage(f);
    github({ emails: null });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === 'https://api.github.com/repos/acme/web'
      ? Promise.resolve(Response.json({ private: false })) : original(input, init)));
    const body = { token: githubToken, name: 'Codex', checkout: { name: 'web', github: { owner: 'acme', repo: 'web' } } };
    const response = await f.post('/api/agent/github', body);
    expect(response.status, await response.clone().text()).toBe(201);
    const first = await f.json<Connection & { created: boolean; initialization?: unknown; url: string }>(response);
    expect(first).toMatchObject({ created: true, repository: 'octo/web', url: `${origin}/octo/web` });
    expect(first.initialization).toBeUndefined();
    const person = f.security.profile({ id: 'github:4242', email: '', name: 'Octo' });
    expect(person.email).toBe('');
    expect(f.directory.personalOwner(person.id)?.workspaces[0].visibility).toBe('private');
    expect(setup.artifacts.import).toHaveBeenCalledOnce();
    const second = await f.json<Connection & { created: boolean }>(await f.post('/api/agent/github', body));
    expect(second).toMatchObject({ workspaceId: first.workspaceId, created: false });
    expect(setup.artifacts.import).toHaveBeenCalledOnce();
  });

  it('preserves a verified email-linked account when GitHub reconnects without email permission', async () => {
    const f = await fixture();
    const emailUser = f.security.profile({ id: 'email:octo@example.test', email: 'octo@example.test', name: 'Octo' });
    github();
    await f.post('/api/agent/github', { token: githubToken, name: 'Codex' });
    github({ emails: null });
    await f.post('/api/agent/github', { token: githubToken, name: 'Codex' });
    const reconnected = f.security.profile({ id: 'github:4242', email: '', name: 'Octo' });
    expect(reconnected).toMatchObject({ id: emailUser.id, email: 'octo@example.test' });
  });

  it('prepares a genuinely empty local repository and distinct email-less people never merge', async () => {
    const f = await fixture(), setup = await setupStorage(f);
    github({ emails: null });
    const response = await f.post('/api/agent/github', { token: githubToken, name: 'Codex', checkout: { name: 'local-work' } });
    expect(response.status, await response.clone().text()).toBe(201);
    const result = await f.json<Connection & { initialization: { accessToken: string; branch: string } }>(response);
    expect(result).toMatchObject({ repository: 'octo/local-work', initialization: { branch: 'main' } });
    expect(setup.artifacts.create).toHaveBeenCalledOnce();
    expect(setup.artifacts.import).not.toHaveBeenCalled();
    expect(await [...setup.workspaces.values()][0].repository()).toMatchObject({ head: '' });
    const first = f.security.profile({ id: 'github:4242', email: '', name: 'Octo' });
    const second = f.security.profile({ id: 'github:4243', email: '', name: 'Other' });
    expect(second.id).not.toBe(first.id);
  });

  it('limits GitHub sign-ins by network and stays off where GitHub sign-in or accounts are off', async () => {
    const f = await fixture();
    github({ status: 401 });
    for (let attempt = 0; attempt < 10; attempt++) expect((await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' })).status).toBe(401);
    expect((await f.post('/api/agent/github', { token: githubToken, name: 'Claude Code' })).status).toBe(429);
    expect((await (await fixture({ GITHUB_CLIENT_ID: '' })).post('/api/agent/github', { token: githubToken, name: 'Claude Code' })).status).toBe(404);
    expect((await (await fixture({ AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' })).post('/api/agent/github', { token: githubToken, name: 'Claude Code' })).status).toBe(404);
  });
});

describe('agents that sign the person up with an emailed code', () => {
  it('sends a code that names the access, keeps it until a connection follows, and spends it then', async () => {
    const f = await fixture();
    const started = await f.post('/api/agent/email/start', { email: 'Maya@Example.test', scope: 'work' });
    expect(started.status).toBe(201);
    const { flowId, scope } = await f.json<{ flowId: string; expiresAt: string; scope: string }>(started);
    expect(scope).toBe('work');
    const message = f.send.mock.calls[0][0];
    expect(message.to).toBe('maya@example.test');
    const code = /^([A-Z2-9]{8}) is your Braid code for a coding agent$/.exec(message.subject)![1];
    expect(message.text).toContain(`give it this code: ${code}`);
    expect(message.text).toContain('open pull requests there for seven days');
    expect(message.text).toContain('It cannot approve or merge pull requests');

    expect((await f.post('/api/agent/email/verify', { flowId, code: 'AAAAAAAA', name: 'Codex' })).status).toBe(401);
    const empty = await f.post('/api/agent/email/verify', { flowId, code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`, name: 'Codex' });
    expect(empty.status).toBe(409);
    expect(await f.json(empty)).toMatchObject({ code: 'repository_required', account: { username: null } });
    const person = await f.security.profile({ id: 'email:maya@example.test', email: 'maya@example.test', name: 'maya' });
    const team = f.directory.createOrganization(person, 'Acme');
    const repository = f.directory.createWorkspace(person.id, team.id, 'Relay');
    const connected = await f.post('/api/agent/email/verify', { flowId, code, name: 'Codex' });
    expect(connected.status).toBe(201);
    expect(await f.json(connected)).toMatchObject({ workspaceId: repository.id, scope: 'work', repository: `${team.slug}/relay` });
    expect((await f.post('/api/agent/email/verify', { flowId, code, name: 'Codex' })).status).toBe(401);
  });

  it('creates a private repository from an email code without a browser', async () => {
    const f = await fixture();
    const setup = await setupStorage(f);
    const started = await f.json<{ flowId: string }>(await f.post('/api/agent/email/start', { email: 'new@example.test' }));
    const code = /^([A-Z2-9]{8}) is your Braid code for a coding agent$/.exec(f.send.mock.calls[0][0].subject)![1];
    const result = await f.post('/api/agent/email/verify', { flowId: started.flowId, code, name: 'Codex', checkout: { name: 'local-work' } });
    expect(result.status, await result.clone().text()).toBe(201);
    expect(await f.json(result)).toMatchObject({ created: true, repository: expect.stringMatching(/^new[^/]*\/local-work$/), initialization: { branch: 'main' } });
    expect(setup.artifacts.create).toHaveBeenCalledOnce();
  });

  it('keeps browser codes and agent codes apart, and stops after five wrong codes', async () => {
    const f = await fixture();
    const browser = await api.fetch(new Request(`${origin}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' }, body: JSON.stringify({ email: 'maya@example.test' }) }), f.env);
    const { flowId: browserFlow } = await f.json<{ flowId: string }>(browser);
    const browserCode = /^([A-Z2-9]{8}) is your Braid sign-in code$/.exec(f.send.mock.calls[0][0].subject)![1];
    expect((await f.post('/api/agent/email/verify', { flowId: browserFlow, code: browserCode, name: 'Codex' })).status).toBe(401);

    const { flowId } = await f.json<{ flowId: string }>(await f.post('/api/agent/email/start', { email: 'maya@example.test', scope: 'read' }));
    const code = /^([A-Z2-9]{8})/.exec(f.send.mock.calls[1][0].subject)![1];
    expect(f.send.mock.calls[1][0].text).toContain('read one of your repositories for one hour');
    const signIn = await api.fetch(new Request(`${origin}/api/auth/email/verify`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `__Host-braid-email=${flowId}` }, body: JSON.stringify({ flowId, code }) }), f.env);
    expect(signIn.status).toBe(401);
    for (let attempt = 0; attempt < 4; attempt++) expect((await f.post('/api/agent/email/verify', { flowId, code: 'ZZZZZZZZ', name: 'Codex' })).status).toBe(401);
    expect((await f.post('/api/agent/email/verify', { flowId, code, name: 'Codex' })).status).toBe(401);
  });

  it('shares the email limits with browsers and needs a configured sender', async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 3; attempt++) expect((await f.post('/api/agent/email/start', { email: 'maya@example.test' })).status).toBe(201);
    expect((await f.post('/api/agent/email/start', { email: 'maya@example.test' })).status).toBe(429);
    expect((await (await fixture({ EMAIL: undefined })).post('/api/agent/email/start', { email: 'maya@example.test' })).status).toBe(503);
  });
});
