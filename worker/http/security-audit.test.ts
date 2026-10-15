import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import { digest, sessionToken } from './auth';
import { mintAccess, ACCESS_LIFETIME } from './agent-token';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { ChangeShard } from '../changes/shard';
import { recordedExample } from '../changes/demo';
import { publicResponse } from './public-view';
import { unsubscribeToken, verifyUnsubscribeToken } from '../accounts/notify';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import type { BraidEnv } from '../env';

const alice = { id: 'alice', email: 'alice@example.test', name: 'Alice' };
const stores: ReturnType<typeof storageFixture>[] = [];
const storage = () => { const db = storageFixture(); stores.push(db); return db; };
afterEach(async () => {
  for (const db of stores.splice(0)) { await db.settled(); db.db.close(); }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture() {
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example',
    SESSION_SECRET: 'security-audit-session-secret-at-least-32-characters',
    ASSETS: { fetch: () => new Response('<!doctype html><title>Braid</title>', { headers: { 'content-type': 'text/html' } }) },
  } as unknown as BraidEnv;
  const directory = new Directory(storage().ctx, env), security = new Security(storage().ctx, env);
  const fetchWorkspace = vi.fn(async (request: Request) => Response.json({ capabilities: { mode: request.headers.get('x-braid-mode') }, value: request.headers.get('x-braid-repository') }));
  const shards = new Map<string, ChangeShard>();
  Object.assign(env, {
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: fetchWorkspace, exampleState: async () => ({ decisions: {}, changes: [] }) }) },
    CHANGES: { getByName: (name: string) => { if (!shards.has(name)) shards.set(name, new ChangeShard(storage().ctx, env)); return shards.get(name)!; } },
  });
  const org = directory.createOrganization(alice, 'Audit'), repo = directory.createWorkspace(alice.id, org.id, 'Private');
  const call = (path: string, init: RequestInit = {}) => api.fetch(new Request(`https://braid.example${path}`, init), env);
  const login = async (user = alice) => { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 86_400_000, user); return `__Host-braid-session=${token}`; };
  return { env, directory, security, org, repo, call, login, fetchWorkspace };
}

describe('security audit regressions', () => {
  it.each(['/api/repository/commits', '/api/repository/commit'])('redacts emails and secrets from public commit metadata at %s', async path => {
    const secret = `ghp_${'A1b2'.repeat(9)}`;
    const result = await publicResponse(Response.json({ title: 'Contact author@example.test', message: `Reviewed by author@example.test\n${secret}` }), path);
    const text = await result.text();
    expect(text).not.toContain('author@example.test'); expect(text).not.toContain(secret);
    expect(text).toContain('[private email]'); expect(text).toContain('[redacted]');
  });

  it('revoking a connection immediately rejects its already-issued access token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture(), id = 'audit-connection', raw = 'braid_agent_auditconnection';
    await f.security.issueAgent(await digest(raw), { id, user: alice, workspaceId: f.repo.id, scope: 'work', label: 'Audit agent', expires: Date.now() + 86_400_000 });
    const token = await mintAccess(f.env, { grant: id, user: alice, workspace: f.repo.id, team: f.org.id, scope: 'work', agent: id, name: 'Audit agent', exp: Date.now() + ACCESS_LIFETIME });
    const read = () => f.call('/api/repository', { headers: { authorization: `Bearer ${token}` } });
    expect((await read()).status).toBe(200);
    expect((await f.call(`/api/agent/connections/${id}`, { method: 'DELETE', headers: { cookie: await f.login(), origin: 'https://braid.example' } })).status).toBe(200);
    expect(f.security.agent(await digest(raw))).toBeNull();
    expect((await read()).status).toBe(401);
  });

  it('does not let one person revoke another person’s minted connection', async () => {
    const f = fixture(), id = 'another-connection';
    await f.security.issueAgent('connection-digest', { id, user: alice, workspaceId: f.repo.id, scope: 'work', label: 'Agent', expires: Date.now() + ACCESS_LIFETIME });
    f.security.revokeAgent('someone-else', id);
    expect(f.security.agent('connection-digest')).not.toBeNull(); expect(f.security.accessRevoked(id)).toBe(false);
  });

  it('keeps real example comment threads isolated for cookie-less visitors on the same network', async () => {
    const f = fixture(), example = await recordedExample(), change = example.change('22');
    const write = (body: string, key: string) => f.call('/api/changes/22/comments', { method: 'POST', headers: {
      'x-braid-workspace': 'demo', 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json', 'idempotency-key': key,
    }, body: JSON.stringify({ body, revision: change.revision }) });
    const first = await write('First visitor private draft', 'audit-first-visitor-key');
    const second = await write('Second visitor draft', 'audit-second-visitor-key');
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
    expect(cookie(second)).not.toBe(cookie(first));
    expect(await second.text()).not.toContain('First visitor private draft');
    const own = await f.call('/api/changes/22/comments', { headers: { 'x-braid-workspace': 'demo', cookie: cookie(first) } });
    expect(await own.text()).toContain('First visitor private draft');
  });

  it('supports the unsubscribe HTML form through the real API while GET leaves preferences unchanged', async () => {
    const f = fixture(), person = f.directory.publicPerson(alice.id)!;
    const token = await unsubscribeToken(f.env, person, 'returned'), path = `/api/notifications/unsubscribe?token=${token}`;
    const opened = await f.call(path);
    expect(opened.status).toBe(200); expect(await opened.text()).toContain('<form method="post">');
    expect(f.directory.notificationPreferences(alice).returned).toBe(true);
    const crossSite = await f.call(path, { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(crossSite.status).toBe(403); expect(f.directory.notificationPreferences(alice).returned).toBe(true);
    const unsigned = await f.call('/api/notifications/unsubscribe?token=invalid', { method: 'POST', headers: { origin: 'https://braid.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(unsigned.status).toBe(400); expect(f.directory.notificationPreferences(alice).returned).toBe(true);
    const submitted = await f.call(path, { method: 'POST', headers: { origin: 'https://braid.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(submitted.status).toBe(200); expect(f.directory.notificationPreferences(alice)).toEqual({ attention: true, returned: false });
  });

  it('keeps unsubscribe signing separate from the session MAC domain', async () => {
    const f = fixture(), payload = `${f.directory.publicPerson(alice.id)!}.attention.${Date.now() + 60_000}`;
    const encoder = new TextEncoder(), key = await crypto.subtle.importKey('raw', encoder.encode(f.env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))).toString('hex');
    await expect(verifyUnsubscribeToken(f.env, `${payload}.${mac}`)).rejects.toMatchObject({ status: 400 });
  });
});

describe('security audit boundaries', () => {
  it.each(['/api/repository/search?q=secret', '/api/repository/commits', '/api/repository/commit?sha=' + 'a'.repeat(40)])('denies private %s before reaching repository storage', async path => {
    const f = fixture();
    for (const cookie of ['', await f.login({ id: 'outsider', name: 'Outsider', email: 'outsider@example.test' })]) {
      const response = await f.call(path, { headers: { 'x-braid-workspace': f.repo.id, ...(cookie ? { cookie } : {}) } });
      expect(response.status).toBe(404);
    }
    expect(f.fetchWorkspace).not.toHaveBeenCalled();
  });

  it('keeps private and session data out of the shared example cache', async () => {
    const f = fixture(), cache = edgeCache(), cookie = await f.login();
    const live = await f.call('/api/state', { headers: { cookie, 'x-braid-workspace': f.repo.id } });
    expect(live.status).toBe(200); expect(cache.size).toBe(0);
    const example = await f.call('/api/state', { headers: { cookie, 'x-braid-workspace': 'demo' } });
    expect(example.status).toBe(200); expect(cache.size).toBe(1);
    for (const response of cache.values()) {
      expect(response.headers.has('set-cookie')).toBe(false);
      const text = await response.clone().text(); expect(text).not.toContain(alice.email); expect(text).not.toContain(f.repo.id); expect(text).not.toContain('identity');
    }
    const again = await f.call('/api/state', { headers: { 'x-braid-workspace': 'demo' } });
    expect(await again.json()).toEqual(await example.json());
  });

  it('serves pages with restrictive script, frame and form CSP directives', async () => {
    const f = fixture(), response = await f.call('/signin');
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'"); expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('unsafe-eval'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
