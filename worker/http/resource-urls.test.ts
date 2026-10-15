import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { digest, sessionToken } from './auth';
import { mintAccess } from './agent-token';
import type { BraidEnv } from '../env';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import { changesRoute } from '../changes/router';

const change = { id: 'ch_0123456789abc', number: 12, title: 'A pull request', revision: 1, status: 'open', author: { id: 'agent:a', name: 'Agent', kind: 'agent' }, checks: [], reviews: [], conflicts: [], comments: [] };
const mission = { id: 'mission-one', title: 'A task', status: 'running', source: 'live', execution: 'local', agents: [{ id: 'coder', change: { id: change.id, number: change.number, status: 'open' } }] };
vi.mock('../changes/router', () => ({ changesRoute: vi.fn(async (request: Request) => {
  const path = new URL(request.url).pathname;
  if (path === '/api/coordination') return Response.json({ 'src/main.ts': [change] });
  if (!path.startsWith('/api/changes') && !path.startsWith('/api/instructions')) return null;
  if (path === '/api/changes' && request.method === 'GET') return Response.json({ items: [change, { ...change, number: 13 }], nextCursor: null });
  return Response.json(change, { status: request.method === 'POST' ? 201 : 200 });
}) }));

const alice = { id: 'alice', name: 'Alice', email: 'alice@example.test' };
const outsider = { id: 'other', name: 'Other', email: 'other@example.test' };
const origin = 'https://braid.example';
function fixture() {
  const cache = edgeCache();
  const db = storageFixture(), store = storageFixture();
  const directory = new Directory(db.ctx, {} as BraidEnv), security = new Security(store.ctx, {} as BraidEnv);
  const workspace = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/state') return Response.json({ missions: [mission], files: {}, capabilities: {} }, { headers: { etag: '"snapshot-1"' } });
    if (['/api/missions', '/api/tasks'].includes(path)) return Response.json(request.method === 'POST' ? { missionId: mission.id } : [mission]);
    if (path.endsWith('/checkout') || path.endsWith('/update')) return Response.json({ missionId: mission.id, pullRequest: change, token: 'checkout-only-secret' });
    if (path.endsWith('/submit')) return Response.json({ commit: 'a'.repeat(40) });
    if (path.endsWith('/progress') || path.endsWith('/cancel')) return Response.json({ ok: true });
    if (path.endsWith('/merge')) return Response.json({ missionId: mission.id, change }, { status: 202 });
    return Response.json(mission);
  });
  const env = { AUTH_MODE: 'github', SESSION_SECRET: 'browser-url-tests-secret-12345678901234567890',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: workspace }) },
  } as unknown as BraidEnv;
  const org = directory.createOrganization(alice, 'Acme');
  const repo = directory.createWorkspace(alice.id, org.id, 'Widgets', 'public');
  const login = async (user = alice) => {
    const token = await sessionToken(env.SESSION_SECRET);
    await security.issue(await digest(token), Date.now() + 86_400_000, user);
    return `__Host-braid-session=${token}`;
  };
  const call = (path: string, { workspaceId = repo.id, cookie, method = 'GET', origin: host = origin, headers = {} }: { workspaceId?: string; cookie?: string; method?: string; origin?: string; headers?: Record<string, string> } = {}) => api.fetch(new Request(`${host}${path}`, {
    method, headers: { 'cf-connecting-ip': '198.51.100.25', 'x-braid-workspace': workspaceId, 'content-type': 'application/json', origin: host, ...(cookie ? { cookie } : {}), ...headers },
    ...(!['GET', 'HEAD'].includes(method) ? { body: '{}' } : {}),
  }), env);
  return { db, store, directory, security, env, org, repo, login, call, workspace, cache };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.db.db.close(); f.store.db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function body(response: Response) { expect(response.status).toBeLessThan(300); return response.json() as Promise<any>; }

describe('browser links on API resources', () => {
  it('uses an organization address for visitors and owners without an address lookup per item', async () => {
    const access = vi.spyOn(f.directory, 'access'), published = vi.spyOn(f.directory, 'publicRead'), resolve = vi.spyOn(f.directory, 'resolveRepository');
    const page = await body(await f.call('/api/changes'));
    expect(page.items.map((item: any) => item.html_url)).toEqual([`${origin}/acme/widgets/pull/12`, `${origin}/acme/widgets/pull/13`]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    const own = await body(await f.call('/api/changes', { cookie: await f.login() }));
    expect(own).toEqual(page);
    expect(access).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    for (const path of ['/api/missions', '/api/tasks']) expect((await body(await f.call(path)))[0]).toMatchObject({ html_url: `${origin}/acme/widgets/tasks/mission-one`, agents: [{ change: { html_url: `${origin}/acme/widgets/pull/12` } }] });
    for (const path of ['/api/missions/mission-one', '/api/tasks/mission-one']) expect(await body(await f.call(path))).toMatchObject({ html_url: `${origin}/acme/widgets/tasks/mission-one` });
    expect(await body(await f.call('/api/state'))).toMatchObject({ missions: [{ html_url: `${origin}/acme/widgets/tasks/mission-one` }] });
  });

  it('uses a personal repository’s current owner and repository slugs and the request origin', async () => {
    f.directory.setUsername(alice, 'alice');
    const owner = f.directory.personalOwner(alice.id)!;
    const repo = f.directory.createWorkspace(alice.id, owner.id, 'Notes', 'private');
    const cookie = await f.login(), workspaceId = repo.id;
    expect(await body(await f.call('/api/changes/12', { cookie, workspaceId }))).toMatchObject({ html_url: `${origin}/alice/notes/pull/12` });
    const before = await f.call('/api/state', { cookie, workspaceId }), etag = before.headers.get('etag')!;
    await before.arrayBuffer();
    expect((await f.call('/api/state', { cookie, workspaceId, headers: { 'if-none-match': etag } })).status).toBe(304);
    f.directory.setUsername(alice, 'alicia');
    f.directory.updateWorkspace(alice.id, { teamId: owner.id, workspaceId, slug: 'journal' });
    expect(await body(await f.call('/api/repos/alice/notes', { cookie, workspaceId }))).toMatchObject({ workspaceId, owner: { slug: 'alicia' }, repo: { slug: 'journal' } });
    expect(await body(await f.call('/api/state', { cookie, workspaceId, headers: { 'if-none-match': etag } }))).toMatchObject({ missions: [{ html_url: `${origin}/alicia/journal/tasks/mission-one` }] });
    expect(await body(await f.call('/api/changes/12', { cookie, workspaceId, origin: 'https://another.example' }))).toMatchObject({ html_url: 'https://another.example/alicia/journal/pull/12' });
  });

  it('keeps public links current immediately after organization and repository renames', async () => {
    const before = await f.call('/api/state'), etag = before.headers.get('etag')!;
    expect(await before.json()).toMatchObject({ missions: [{ html_url: `${origin}/acme/widgets/tasks/mission-one` }] });
    f.directory.updateTeam(alice.id, { teamId: f.org.id, slug: 'acme-now' });
    f.directory.updateWorkspace(alice.id, { teamId: f.org.id, workspaceId: f.repo.id, slug: 'gadgets' });
    expect(await body(await f.call('/api/repos/acme/widgets'))).toMatchObject({ workspaceId: f.repo.id, owner: { slug: 'acme-now' }, repo: { slug: 'gadgets' } });
    const published = vi.spyOn(f.directory, 'publicRead');
    const response = await f.call('/api/state', { headers: { 'if-none-match': etag } });
    expect(await body(response)).toMatchObject({ missions: [{ html_url: `${origin}/acme-now/gadgets/tasks/mission-one` }] });
    expect(response.headers.get('etag')).not.toBe(etag);
    expect(published).toHaveBeenCalledTimes(1);
    expect(await body(await f.call('/api/changes/12', { origin: 'http://127.0.0.1:5208' }))).toMatchObject({ html_url: 'http://127.0.0.1:5208/acme-now/gadgets/pull/12' });
  });

  it('adds links to every pull request write answer', async () => {
    const cookie = await f.login();
    for (const path of ['/api/changes', '/api/changes/12/revisions', '/api/changes/12/restack', '/api/changes/12/reviews', '/api/changes/12/comments', '/api/changes/12/comments/rc_one/resolve', '/api/changes/12/approve', '/api/changes/12/close', '/api/changes/12/revert', '/api/instructions']) {
      expect(await body(await f.call(path, { cookie, method: 'POST' }))).toMatchObject({ number: 12, html_url: `${origin}/acme/widgets/pull/12` });
    }
    expect(await body(await f.call('/api/instructions/one', { cookie, method: 'DELETE' }))).toMatchObject({ number: 12, html_url: `${origin}/acme/widgets/pull/12` });
  });

  it('adds task links to create, checkout, progress, submit, update and merge receipts', async () => {
    const cookie = await f.login();
    for (const path of ['/api/missions', '/api/missions/mission-one', ...['checkout', 'progress', 'submit', 'update'].map(action => `/api/missions/mission-one/agents/coder/${action}`), ...['finish', 'cancel', 'resolve', 'merge'].map(action => `/api/missions/mission-one/${action}`)]) {
      const result = await body(await f.call(path, { cookie, method: 'POST' }));
      expect(result.html_url).toBe(`${origin}/acme/widgets/tasks/mission-one`);
      if (result.change) expect(result.change.html_url).toBe(`${origin}/acme/widgets/pull/12`);
      if (result.pullRequest) expect(result.pullRequest.html_url).toBe(`${origin}/acme/widgets/pull/12`);
      if (path.endsWith('/checkout')) expect(result.token).toBe('checkout-only-secret');
    }
  });

  it('keeps the example address and origin correct even when its body comes from the shared cache', async () => {
    for (const host of [origin, 'https://another.example']) {
      const page = await body(await f.call('/api/changes', { workspaceId: 'demo', origin: host }));
      expect(page.items[0].html_url).toBe(`${host}/example/relay/pull/12`);
      const result = await body(await f.call('/api/state', { workspaceId: 'demo', origin: host }));
      expect(result.missions[0].html_url).toBe(`${host}/example/relay/tasks/mission-one`);
    }
    expect(f.workspace).toHaveBeenCalledTimes(1);
    for (const [key, response] of f.cache) if (key.startsWith('https://example.braid.invalid/')) expect(await response.clone().text()).not.toContain('html_url');
  });

  it('varies conditional reads by origin and keeps public HEAD responses bodyless', async () => {
    const response = await f.call('/api/state'), etag = response.headers.get('etag')!;
    await response.arrayBuffer();
    expect((await f.call('/api/state', { headers: { 'if-none-match': etag } })).status).toBe(304);
    const head = await f.call('/api/state', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect(await head.text()).toBe('');
    const elsewhere = await f.call('/api/state', { origin: 'https://another.example', headers: { 'if-none-match': etag } });
    expect(await body(elsewhere)).toMatchObject({ missions: [{ html_url: 'https://another.example/acme/widgets/tasks/mission-one' }] });
  });

  it('preserves failures and comment-list shapes without adding links to repository content', async () => {
    vi.mocked(changesRoute).mockResolvedValueOnce(Response.json({ error: 'Review required.' }, { status: 409 }));
    const error = await f.call('/api/changes/12/revisions', { cookie: await f.login(), method: 'POST' });
    expect(error.status).toBe(409);
    expect(await error.json()).toEqual({ error: 'Review required.' });
    vi.mocked(changesRoute).mockResolvedValueOnce(Response.json([{ id: 'rc_one', body: 'Comment text.' }]));
    expect(await body(await f.call('/api/changes/12/comments'))).toEqual([{ id: 'rc_one', body: 'Comment text.' }]);
    vi.mocked(changesRoute).mockResolvedValueOnce(Response.json({ path: 'main.ts', before: '', after: 'some text' }));
    expect(await body(await f.call('/api/changes/12/diff?path=main.ts'))).toEqual({ path: 'main.ts', before: '', after: 'some text' });
  });

  it('never returns a private repository’s name or link to a visitor or nonmember', async () => {
    const hidden = f.directory.createWorkspace(alice.id, f.org.id, 'Secret-plans', 'private');
    for (const cookie of [undefined, await f.login(outsider)]) for (const workspaceId of [hidden.id, 'not-a-repository']) for (const path of ['/api/changes', '/api/changes/12', '/api/tasks', '/api/tasks/mission-one', '/api/state']) {
      const response = await f.call(path, { cookie, workspaceId });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Repository not found.', requestId: expect.any(String) });
    }
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it('does not disclose a newly private address through a warmed public resource answer', async () => {
    expect((await f.call('/api/state')).status).toBe(200);
    f.directory.updateWorkspace(alice.id, { teamId: f.org.id, workspaceId: f.repo.id, visibility: 'private', slug: 'secret-plans' });
    for (const path of ['/api/state', '/api/changes', '/api/missions/mission-one']) {
      const response = await f.call(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Repository not found.', requestId: expect.any(String) });
    }
  });

  it('resolves an agent’s canonical task address only within its approved repository', async () => {
    const hidden = f.directory.createWorkspace(alice.id, f.org.id, 'Hidden', 'private');
    const token = await mintAccess(f.env, { grant: 'grant', user: alice, workspace: hidden.id, team: f.org.id, scope: 'work', agent: 'agent:a', name: 'Agent', owner: { id: alice.id, name: 'Alice' }, exp: Date.now() + 60_000 });
    const options = { workspaceId: hidden.id, headers: { authorization: `Bearer ${token}` } };
    expect(await body(await f.call('/api/repos/acme/hidden', options))).toMatchObject({ workspaceId: hidden.id });
    for (const name of ['widgets', 'unknown']) {
      const response = await f.call(`/api/repos/acme/${name}`, options);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Repository not found.', requestId: expect.any(String) });
    }
  });
});
