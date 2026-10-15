import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64url } from 'jose';
import api from './api';
import { digest, sessionToken } from './auth';
import { mintMcpAccess } from './agent-token';
import { MCP_SIGN_IN } from './mcp';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import { organizationWithRepository } from '../test/organization';
import type { BraidEnv } from '../env';
import type { OAuthRequestView } from '../../shared/types';

const origin = 'https://braid.example';
const resource = `${origin}/mcp`;
const maya = { id: 'maya', email: 'maya@example.test', name: 'Maya' };
const head = 'b'.repeat(40);
const stores: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.db.close(); });

async function fixture() {
  const people = storageFixture(), secrets = storageFixture();
  stores.push(people, secrets);
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: origin, SESSION_SECRET: 'oauth-test-session-secret-of-32-characters' } as unknown as BraidEnv;
  const directory = new Directory(people.ctx, env), security = new Security(secrets.ctx, env);
  const status = vi.fn(async () => ({ branch: 'main', head, enabled: true, recent: [] }));
  Object.assign(env, {
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
    TRUNKS: { getByName: () => ({ status }) },
  });
  const team = organizationWithRepository(directory, maya, 'Acme', 'private');
  const repository = team.workspaces[0];
  const session = await sessionToken(env.SESSION_SECRET);
  await security.issue(await digest(session), Date.now() + 86_400_000, maya);
  const cookie = `__Host-braid-session=${session}`;
  const call = (path: string, init: RequestInit = {}) => api.fetch(new Request(`${origin}${path}`, init), env);
  const json = async <T>(response: Response) => await response.json() as T;
  const form = (path: string, values: Record<string, string>, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values).toString() });
  const tool = (token: string | null, name: string, args: object = {}) => call('/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const register = async (metadata: object) => json<{ client_id: string; client_secret?: string }>(await call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) }));
  const pkce = async () => {
    const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(48)));
    return { verifier, challenge: base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) };
  };
  const consent = (query: Record<string, string>) => call(`/api/oauth/authorize?${new URLSearchParams(query)}`, { headers: { cookie } });
  const answer = (request: Record<string, string>, decision: 'approve' | 'deny', choice: { workspaceId?: string; scope?: 'read' | 'work' } = {}) =>
    call('/api/oauth/authorize', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ request, decision, ...choice }) });
  /** An approved request's code, as the browser carries it back to the client. */
  const authorize = async (request: Record<string, string>, choice: { workspaceId?: string; scope?: 'read' | 'work' } = { workspaceId: repository.id }) => {
    const approved = await answer(request, 'approve', choice);
    expect(approved.status).toBe(200);
    return new URL((await json<{ redirect: string }>(approved)).redirect);
  };
  return { env, directory, security, repository, cookie, call, json, form, tool, register, pkce, consent, answer, authorize, status };
}
type Tokens = { access_token: string; refresh_token?: string; token_type: string; expires_in: number; scope: string };

describe('OAuth for MCP clients', () => {
  it('runs a client from discovery to tools, refreshes with rotation, and refuses what OAuth refuses', async () => {
    const f = await fixture();
    // Discovery: an unauthorized tool call points at the protected resource metadata, which names Braid's server.
    const challenged = await f.tool(null, 'get_repository');
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="work"`);
    expect(challenged.headers.get('access-control-expose-headers')).toBe('www-authenticate');
    expect(await f.json(challenged)).toEqual({ error: MCP_SIGN_IN });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await f.json(await f.call(path))).toEqual({ resource, authorization_servers: [origin], scopes_supported: ['read', 'work'], bearer_methods_supported: ['header'], resource_name: 'Braid', resource_documentation: `${origin}/auth.md` });
    }
    const metadata = await f.json<Record<string, unknown>>(await f.call('/.well-known/oauth-authorization-server'));
    expect(metadata).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`, code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], client_id_metadata_document_supported: true });
    expect((await f.call('/oauth/token', { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBe('*');

    // Dynamic registration of a public client with a loopback redirect.
    const registered = await f.call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://localhost:7777/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) });
    expect(registered.status).toBe(201);
    const client = await f.json<{ client_id: string; client_secret?: string; token_endpoint_auth_method: string }>(registered);
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe('none');

    // The consent page reads the request; the browser returns on the port the client opened (RFC 8252).
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:51234/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'work', resource };
    expect((await f.call(`/api/oauth/authorize?${new URLSearchParams(request)}`)).status).toBe(401);
    expect(await f.json(await f.consent(request))).toEqual({ client: { name: 'Claude Code', redirect: { kind: 'loopback', host: 'localhost' }, document: null }, scope: 'work' } satisfies OAuthRequestView);
    // A redirect the client did not register is shown, never followed; other problems return to the client.
    const foreign = await f.consent({ ...request, redirect_uri: 'https://attacker.example/callback' });
    expect(foreign.status).toBe(400);
    expect(await f.json(foreign)).toMatchObject({ code: 'oauth_client' });
    const plain = new URL((await f.json<{ redirect: string }>(await f.consent({ ...request, code_challenge_method: 'plain' }))).redirect);
    expect(Object.fromEntries(plain.searchParams)).toMatchObject({ error: 'invalid_request', state: 'xyz', iss: origin });
    expect(plain.origin).toBe('http://localhost:51234');
    const audience = new URL((await f.json<{ redirect: string }>(await f.consent({ ...request, resource: 'https://other.example/mcp' }))).redirect);
    expect(audience.searchParams.get('error')).toBe('invalid_target');
    const denied = new URL((await f.json<{ redirect: string }>(await f.answer(request, 'deny'))).redirect);
    expect(Object.fromEntries(denied.searchParams)).toEqual({ error: 'access_denied', error_description: 'The person denied the request.', state: 'xyz', iss: origin });

    // A code spent with a wrong verifier or redirect is gone; the right exchange gives tokens for /mcp.
    const exchange = (code: string, values: Record<string, string> = {}) => f.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier, client_id: client.client_id, resource, ...values });
    const first = (await f.authorize(request)).searchParams;
    expect(first.get('state')).toBe('xyz');
    expect(first.get('iss')).toBe(origin);
    const wrongVerifier = await exchange(first.get('code')!, { code_verifier: (await f.pkce()).verifier });
    expect(wrongVerifier.status).toBe(400);
    expect(await f.json(wrongVerifier)).toMatchObject({ error: 'invalid_grant' });
    expect(wrongVerifier.headers.get('cache-control')).toBe('no-store');
    expect(await f.json(await exchange(first.get('code')!))).toMatchObject({ error: 'invalid_grant' });
    const second = (await f.authorize(request)).searchParams.get('code')!;
    expect(await f.json(await exchange(second, { redirect_uri: 'http://localhost:9999/elsewhere' }))).toMatchObject({ error: 'invalid_grant' });
    const third = (await f.authorize(request)).searchParams.get('code')!;
    expect(await f.json(await exchange(third, { resource: 'https://other.example/mcp' }))).toMatchObject({ error: 'invalid_target' });
    const issued = await exchange(third);
    expect(issued.status).toBe(200);
    const tokens = await f.json<Tokens>(issued);
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'work', expires_in: 3600 });
    expect(tokens.access_token.startsWith('braid_at_mcp_')).toBe(true);
    expect(tokens.refresh_token!.startsWith('braid_agent_rt_')).toBe(true);

    // The token works at /mcp, as the agent the person approved, and nowhere else.
    const used = await f.tool(tokens.access_token, 'get_repository');
    expect(used.status).toBe(200);
    expect(JSON.stringify(await f.json(used))).toContain(`Default branch main at ${head}`);
    expect((await f.call('/api/queue', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    const elsewhere = await mintMcpAccess(f.env, { grant: 'g', user: maya, workspace: f.repository.id, team: 't', scope: 'work', agent: 'g', name: 'Other', aud: 'https://other.example/mcp', client: client.client_id, exp: Date.now() + 60_000 });
    const misdirected = await f.tool(elsewhere, 'get_repository');
    expect(misdirected.status).toBe(401);
    expect(misdirected.headers.get('www-authenticate')).toContain('error="invalid_token"');
    const connections = await f.json<{ id: string; label: string; scope: string; client?: string; workspaceId: string }[]>(await f.call('/api/agent/connections', { headers: { cookie: f.cookie } }));
    expect(connections).toEqual([expect.objectContaining({ label: 'Claude Code', scope: 'work', client: client.client_id, workspaceId: f.repository.id })]);

    // Rotation: the token before the newest stays usable until the newest is used, then a retired one ends the grant.
    const refresh = (token: string) => f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id });
    const one = await f.json<Tokens>(await refresh(tokens.refresh_token!));
    expect(one.refresh_token).not.toBe(tokens.refresh_token);
    const retried = await f.json<Tokens>(await refresh(tokens.refresh_token!));
    expect(retried.access_token).toBeTruthy();
    const two = await f.json<Tokens>(await refresh(retried.refresh_token!));
    expect((await f.tool(two.access_token, 'get_repository')).status).toBe(200);
    expect(await f.json(await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: two.refresh_token!, client_id: 'another-client' }))).toMatchObject({ error: 'invalid_client' });
    const reused = await refresh(one.refresh_token!);
    expect(await f.json(reused)).toMatchObject({ error: 'invalid_grant' });
    expect((await f.tool(two.access_token, 'get_repository')).status).toBe(401);
    expect(await f.json(await refresh(two.refresh_token!))).toMatchObject({ error: 'invalid_grant' });

    // Revocation (RFC 7009) ends a grant from its refresh token; an unknown token answers the same.
    const fourth = (await f.authorize(request)).searchParams.get('code')!;
    const revocable = await f.json<Tokens>(await exchange(fourth));
    expect((await f.form('/oauth/revoke', { token: 'braid_agent_rt_unknown', client_id: client.client_id })).status).toBe(200);
    expect((await f.tool(revocable.access_token, 'get_repository')).status).toBe(200);
    expect((await f.form('/oauth/revoke', { token: revocable.refresh_token!, client_id: client.client_id })).status).toBe(200);
    expect((await f.tool(revocable.access_token, 'get_repository')).status).toBe(401);
    expect(await f.json(await refresh(revocable.refresh_token!))).toMatchObject({ error: 'invalid_grant' });

    // A code presented twice revokes what the first exchange issued (OAuth 2.1 section 4.1.3).
    const fifth = (await f.authorize(request)).searchParams.get('code')!;
    const once = await f.json<Tokens>(await exchange(fifth));
    expect((await f.tool(once.access_token, 'get_repository')).status).toBe(200);
    expect(await f.json(await exchange(fifth))).toMatchObject({ error: 'invalid_grant' });
    expect((await f.tool(once.access_token, 'get_repository')).status).toBe(401);
  });

  it('gives read access a read token, which asks for more before a write tool', async () => {
    const f = await fixture();
    const { client_id } = await f.register({ client_name: 'Reader', redirect_uris: ['https://reader.example/callback'], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id, redirect_uri: 'https://reader.example/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read' };
    expect(await f.json(await f.consent(request))).toMatchObject({ scope: 'read', client: { redirect: { kind: 'web', host: 'reader.example' } } });
    expect((await f.answer(request, 'approve', { workspaceId: f.repository.id, scope: 'work' })).status).toBe(400);
    const code = (await f.authorize(request, { workspaceId: f.repository.id })).searchParams.get('code')!;
    const tokens = await f.json<Tokens>(await f.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier, client_id }));
    expect(tokens.scope).toBe('read');
    expect((await f.tool(tokens.access_token, 'get_repository')).status).toBe(200);
    const write = await f.tool(tokens.access_token, 'report_problem', { summary: 'Blocked' });
    expect(write.status).toBe(403);
    expect(write.headers.get('www-authenticate')).toBe(`Bearer error="insufficient_scope", error_description="This tool needs work access.", resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="work"`);
    expect(await f.json(await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id, scope: 'work' }))).toMatchObject({ error: 'invalid_scope' });
  });

  it('authenticates a confidential client with its secret, by Basic credentials or the form', async () => {
    const f = await fixture();
    const { client_id, client_secret } = await f.register({ client_name: 'Web connector', redirect_uris: ['https://connector.example/oauth/callback'] });
    expect(client_secret).toMatch(/^braid_cs_/);
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id, redirect_uri: 'https://connector.example/oauth/callback', code_challenge: challenge, code_challenge_method: 'S256' };
    const code = (await f.authorize(request)).searchParams.get('code')!;
    const values = { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier };
    const basic = (secret: string) => ({ authorization: `Basic ${btoa(`${encodeURIComponent(client_id)}:${encodeURIComponent(secret)}`)}` });
    const refused = await f.form('/oauth/token', values, basic('braid_cs_wrong'));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Basic realm="Braid"');
    expect((await f.form('/oauth/token', { ...values, client_id })).status).toBe(401);
    const tokens = await f.json<Tokens>(await f.form('/oauth/token', values, basic(client_secret!)));
    expect(tokens.scope).toBe('work');
    expect((await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id, client_secret: client_secret! })).status).toBe(200);
  });

  it('reads a client ID metadata document, shows its host and keeps to its redirects', async () => {
    const f = await fixture();
    const id = 'https://client.example/oauth/metadata.json';
    const document = { client_id: id, client_name: 'VS Code', redirect_uris: ['http://127.0.0.1/callback', 'vscode://vscode.github-authentication/did-authenticate'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' };
    const fetched = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(id);
      expect(init?.redirect).toBe('manual');
      return Response.json(document, { headers: { 'cache-control': 'max-age=600' } });
    });
    vi.stubGlobal('fetch', fetched);
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id: id, redirect_uri: 'http://127.0.0.1:33418/callback', code_challenge: challenge, code_challenge_method: 'S256' };
    expect(await f.json(await f.consent(request))).toEqual({ client: { name: 'VS Code', redirect: { kind: 'loopback', host: '127.0.0.1' }, document: 'client.example' }, scope: 'work' });
    expect(await f.json(await f.consent({ ...request, redirect_uri: 'vscode://vscode.github-authentication/did-authenticate' }))).toMatchObject({ client: { redirect: { kind: 'app', host: 'vscode' } } });
    expect((await f.consent({ ...request, redirect_uri: 'http://localhost:33418/callback' })).status).toBe(400);
    const code = (await f.authorize(request)).searchParams.get('code')!;
    const tokens = await f.json<Tokens>(await f.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier, client_id: id }));
    expect(tokens.refresh_token).toBeTruthy();
    expect(fetched).toHaveBeenCalledTimes(1);

    for (const wrong of [{ ...document, client_id: 'https://client.example/other.json' }, { ...document, client_secret: 'shared' }, { ...document, redirect_uris: ['javascript:alert(1)'] }]) {
      const other = `https://other.example/${crypto.randomUUID()}.json`;
      fetched.mockImplementationOnce(async () => Response.json({ ...wrong, client_id: wrong.client_id === id ? other : wrong.client_id }));
      expect(await f.json(await f.consent({ ...request, client_id: other }))).toMatchObject({ code: 'oauth_client' });
    }
    for (const address of ['http://client.example/metadata.json', 'https://client.example/', 'https://127.0.0.1/metadata.json', 'https://client.example/a/../metadata.json'])
      expect(await f.json(await f.consent({ ...request, client_id: address }))).toMatchObject({ code: 'oauth_client' });
  });

  it('registers only redirects an app may own, and limits registrations by network', async () => {
    const f = await fixture();
    for (const redirect of ['http://example.com/callback', 'https://example.com/callback#fragment', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@example.com/callback']) {
      const refused = await f.call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
      expect(refused.status).toBe(400);
      expect(await f.json(refused)).toMatchObject({ error: 'invalid_redirect_uri' });
    }
    expect(await f.json(await f.call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'private_key_jwt' }) })))
      .toMatchObject({ error: 'invalid_client_metadata' });
    const app = await f.register({ client_name: 'Cursor', redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/user-braid/callback'], token_endpoint_auth_method: 'none' });
    expect(app.client_id).toBeTruthy();
    for (let attempt = 0; attempt < 14; attempt++) await f.register({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'none' });
    const limited = await f.call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('removes an MCP client from Settings like any other connection, ending its tokens', async () => {
    const f = await fixture();
    const { client_id } = await f.register({ client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id, redirect_uri: 'http://localhost:4000/callback', code_challenge: challenge, code_challenge_method: 'S256' };
    const code = (await f.authorize(request)).searchParams.get('code')!;
    const tokens = await f.json<Tokens>(await f.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier, client_id }));
    const [connection] = await f.json<{ id: string }[]>(await f.call('/api/agent/connections', { headers: { cookie: f.cookie } }));
    expect((await f.call(`/api/agent/connections/${connection.id}`, { method: 'DELETE', headers: { cookie: f.cookie, origin } })).status).toBe(200);
    expect((await f.tool(tokens.access_token, 'get_repository')).status).toBe(401);
    expect(await f.json(await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id }))).toMatchObject({ error: 'invalid_grant' });
  });

  it('lets only people who can write a repository approve, and leaked OAuth tokens revoke their grant', async () => {
    const f = await fixture();
    const { client_id } = await f.register({ client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = await f.pkce();
    const request = { response_type: 'code', client_id, redirect_uri: 'http://localhost/callback', code_challenge: challenge, code_challenge_method: 'S256' };
    expect((await f.answer(request, 'approve', { workspaceId: 'another-repository' })).status).toBe(404);
    expect((await f.answer(request, 'approve')).status).toBe(400);
    const code = (await f.authorize(request)).searchParams.get('code')!;
    const tokens = await f.json<Tokens>(await f.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: request.redirect_uri, code_verifier: verifier, client_id }));
    expect(await f.security.revokeLeakedToken(tokens.refresh_token!)).toMatchObject({ workspaceId: f.repository.id });
    expect((await f.tool(tokens.access_token, 'get_repository')).status).toBe(401);
  });
});
