import * as v from 'valibot';
import { base64url } from 'jose';
import type { AccountIdentity } from '../../shared/account';
import type { AgentScope, OAuthRequestView } from '../../shared/types';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import { HttpError, unwrap } from '../errors';
import { oauthAuthorization, oauthClientDocument, oauthConsent, oauthRegistration, oauthRevocation, oauthTokenRequest, parse } from '../schemas';
import { digest, equalSecret, jsonBody } from './auth';
import { ACCESS_LIFETIME, MCP_ACCESS_LIFETIME, MCP_ACCESS_PREFIX, mintAccess, mintMcpAccess, verifyMcpAccess } from './agent-token';
import { agentCredential } from './agent-auth';
import { clientAddress, networkKey } from './public-access';
import { personOwner } from '../repositories/provenance';
import type { AgentGrant, OAuthClient } from '../accounts/security';

/*
 * Braid as the OAuth 2.1 authorization server for its own MCP endpoint, as the MCP authorization specification asks:
 * protected resource metadata (RFC 9728), server metadata (RFC 8414), clients that register (RFC 7591) or publish a
 * client ID metadata document, the authorization code flow with PKCE S256 only, tokens bound to the /mcp resource
 * (RFC 8707), rotating refresh tokens and revocation (RFC 7009). A person approves in the app, at /oauth/authorize,
 * and the approval becomes an agent grant for one repository, checked as a connection approved in Braid is.
 */

export const REFRESH_PREFIX = 'braid_agent_rt_';
const CODE_PREFIX = 'braid_code_', SECRET_PREFIX = 'braid_cs_';
const SCOPES = ['read', 'work'] as const;
type OAuthScope = typeof SCOPES[number];
const PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';
const AUTHORIZATION_SERVER = '/.well-known/oauth-authorization-server';
const ENDPOINTS = ['/oauth/token', '/oauth/register', '/oauth/revoke'];
/** Token answers are never cached (RFC 6749 section 5.1). */
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

/** The paths MCP clients may call from a web page: they carry bearer tokens or nothing, never a session cookie. */
export const crossOrigin = (path: string) => path === '/mcp' || path === PROTECTED_RESOURCE || path === `${PROTECTED_RESOURCE}/mcp` || path === AUTHORIZATION_SERVER || ENDPOINTS.includes(path);

/** The issuer, the MCP resource and its metadata, where people have accounts to approve with. */
function oauthOrigins(env: BraidEnv, url: URL) {
  if (env.AUTH_MODE !== 'github') return null;
  const issuer = URL.parse(env.PUBLIC_ORIGIN)?.origin ?? url.origin;
  return { issuer, resource: `${issuer}/mcp`, metadata: `${issuer}${PROTECTED_RESOURCE}` };
}
type Origins = NonNullable<ReturnType<typeof oauthOrigins>>;

const random = (bytes = 32) => base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
/** A body of at most `limit` bytes, or null when it is larger. */
async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  const reader = body?.getReader(), bytes = new Uint8Array(limit);
  let size = 0;
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) { await reader.cancel(); return null; }
    bytes.set(value, size);
    size += value.byteLength;
  }
  return bytes.subarray(0, size);
}
const s256 = async (verifier: string) => base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
/** RFC 8707 resources compare as URLs, so the scheme and host may be in any case. A fragment never names a resource. */
const sameResource = (value: string, resource: string) => { const url = URL.parse(value); return !!url && !url.hash && `${url.origin}${url.pathname}${url.search}` === resource; };

/* ---------- redirects ---------- */

type RedirectKind = OAuthRequestView['client']['redirect']['kind'];
/** Schemes a browser handles itself; an app cannot claim them for its redirect. */
const BROWSER_SCHEMES = new Set(['http:', 'https:', 'javascript:', 'data:', 'blob:', 'about:', 'file:', 'filesystem:', 'vbscript:', 'ftp:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** An HTTPS page, this computer over HTTP, or an app's own scheme (RFC 8252). Never a fragment or credentials. */
function redirectKind(value: string): RedirectKind | null {
  const url = URL.parse(value);
  if (!url || value.includes('#') || url.username || url.password) return null;
  if (url.protocol === 'https:') return url.hostname ? 'web' : null;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? 'loopback' : null;
  return BROWSER_SCHEMES.has(url.protocol) ? null : 'app';
}
/** Exact, except that a loopback redirect may use any port the client opens at the time (RFC 8252 section 7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = URL.parse(registered), b = URL.parse(requested);
  return !!a && !!b && a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname
    && a.pathname === b.pathname && a.search === b.search && redirectKind(requested) === 'loopback';
}
const shownRedirect = (uri: string): OAuthRequestView['client']['redirect'] => {
  const url = new URL(uri), kind = redirectKind(uri)!;
  return { kind, host: kind === 'app' ? url.protocol.slice(0, -1) : url.hostname };
};
function withParameters(uri: string, values: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

/* ---------- clients ---------- */

type Client = { id: string; name: string; redirectUris: string[]; refresh: boolean; document: string | null };
const registered = (client: OAuthClient): Client => ({ id: client.id, name: client.name, redirectUris: client.redirectUris, refresh: client.grantTypes.includes('refresh_token'), document: null });
const documents = new Map<string, { client: Client; until: number }>();
const DOCUMENT_BYTES = 16_384;
const unreadableDocument = () => new HttpError(400, 'Braid could not read this client’s metadata document.', undefined, 'oauth_client');
/**
 * A client whose id is the HTTPS address of its metadata document. Braid fetches the document, without redirects and
 * from a host name only, checks that it names itself, and keeps a valid one for as long as its cache headers allow.
 */
async function documentClient(id: string): Promise<Client> {
  const url = URL.parse(id);
  if (!url || url.href !== id || url.protocol !== 'https:' || url.pathname === '/' || url.username || url.password || url.hash
    || url.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) throw new HttpError(400, 'This client id is not a valid metadata document address.', undefined, 'oauth_client');
  const kept = documents.get(id);
  if (kept && kept.until > Date.now()) return kept.client;
  let response: Response;
  try { response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) }); }
  catch { throw unreadableDocument(); }
  if (response.status !== 200) { await response.body?.cancel(); throw unreadableDocument(); }
  const bytes = await boundedBytes(response.body, DOCUMENT_BYTES);
  if (!bytes) throw unreadableDocument();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw unreadableDocument(); }
  const document = v.safeParse(oauthClientDocument, parsed);
  if (!document.success || document.output.client_id !== id || document.output.redirect_uris.some(uri => !redirectKind(uri)) || !document.output.response_types.includes('code'))
    throw new HttpError(400, 'This client’s metadata document does not describe it correctly.', undefined, 'oauth_client');
  const client: Client = { id, name: document.output.client_name, redirectUris: document.output.redirect_uris, refresh: document.output.grant_types.includes('refresh_token'), document: url.hostname };
  const control = response.headers.get('cache-control') ?? '';
  const maxAge = /(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(control) ? 0 : Number(/(?:^|,)\s*max-age=(\d+)/i.exec(control)?.[1] ?? 300);
  if (maxAge > 0) {
    if (documents.size >= 200) documents.delete(documents.keys().next().value!);
    documents.set(id, { client, until: Date.now() + Math.min(maxAge, 86_400) * 1000 });
  }
  return client;
}
async function resolveClient(env: BraidEnv, id: string): Promise<Client> {
  if (id.startsWith('https://')) return documentClient(id);
  const client = await securityOf(env).oauthClient(id);
  if (!client) throw new HttpError(400, 'This client is not registered with Braid. Remove the server from your MCP client and add it again.', undefined, 'oauth_client');
  return registered(client);
}

/* ---------- authorization requests ---------- */

type Checked = { ok: true; client: Client; redirectUri: string; challenge: string; scope: OAuthScope; state?: string } | { ok: false; redirect: string };
/**
 * Checks an authorization request in the order OAuth 2.1 section 4.1.2.1 sets: a bad client or redirect is shown to the
 * person and never followed; every other problem returns to the client's checked redirect with an error.
 */
async function checkRequest(env: BraidEnv, origins: Origins, parameters: Record<string, string>, repeated = false): Promise<Checked> {
  const request = parse(oauthAuthorization, parameters);
  if (!request.client_id) throw new HttpError(400, 'This request names no client.', undefined, 'oauth_client');
  const client = await resolveClient(env, request.client_id);
  const redirectUri = request.redirect_uri;
  if (!redirectUri || !client.redirectUris.some(uri => redirectMatches(uri, redirectUri))) throw new HttpError(400, 'This request returns to an address its client did not register.', undefined, 'oauth_client');
  const fail = (error: string, description: string): Checked => ({ ok: false, redirect: withParameters(redirectUri, { error, error_description: description, state: request.state, iss: origins.issuer }) });
  if (repeated) return fail('invalid_request', 'Send each parameter once.');
  if (request.response_type !== 'code') return fail('unsupported_response_type', 'Braid supports the authorization code flow only.');
  if (request.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.code_challenge ?? '')) return fail('invalid_request', 'Send a PKCE code_challenge with code_challenge_method S256.');
  const scopes = (request.scope ?? '').split(' ').filter(Boolean);
  if (scopes.some(scope => !(SCOPES as readonly string[]).includes(scope))) return fail('invalid_scope', 'Ask for read or work.');
  if (request.resource !== undefined && !sameResource(request.resource, origins.resource)) return fail('invalid_target', `Ask for the resource ${origins.resource}.`);
  // Work includes reading; a request for read alone gets read.
  return { ok: true, client, redirectUri, challenge: request.code_challenge!, scope: scopes.length && !scopes.includes('work') ? 'read' : 'work', state: request.state };
}

/**
 * The consent page's API. GET shows a request; POST answers it with the repository and access the person chose. Each
 * answer that leaves Braid is `{ redirect }`, to the client's checked address.
 */
export async function oauthConsentRoute(request: Request, env: BraidEnv, url: URL, user: AccountIdentity | null): Promise<Response> {
  const origins = oauthOrigins(env, url);
  if (!origins) throw new HttpError(404, 'This Braid has no OAuth sign-in for MCP clients.');
  if (!user) throw new HttpError(401, 'Sign in to authorize this client.');
  const budget = await securityOf(env).consume(`oauth-consent:${user.id}`, 60, 600_000);
  if (!budget.allowed) throw new HttpError(429, 'Too many authorization requests. Try again shortly.', budget.retryAfter);
  if (request.method === 'GET') {
    const names = [...url.searchParams.keys()];
    const checked = await checkRequest(env, origins, Object.fromEntries(url.searchParams), new Set(names).size !== names.length);
    if (!checked.ok) return Response.json({ redirect: checked.redirect });
    return Response.json({ client: { name: checked.client.name, redirect: shownRedirect(checked.redirectUri), document: checked.client.document }, scope: checked.scope } satisfies OAuthRequestView);
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Use GET to read the request and POST to answer it.');
  const answer = parse(oauthConsent, await jsonBody(request));
  const checked = await checkRequest(env, origins, answer.request);
  if (!checked.ok) return Response.json({ redirect: checked.redirect });
  const back = (values: Record<string, string>) => withParameters(checked.redirectUri, { ...values, state: checked.state, iss: origins.issuer });
  if (answer.decision === 'deny') return Response.json({ redirect: back({ error: 'access_denied', error_description: 'The person denied the request.' }) });
  if (!answer.workspaceId) throw new HttpError(400, 'Choose a repository.');
  const scope = answer.scope ?? checked.scope;
  if (scope === 'work' && checked.scope === 'read') throw new HttpError(400, 'Approve the requested access or reduce it to read.');
  // As with an approval link: only a person who can write a repository lets an agent into it.
  unwrap(await directoryOf(env).access(user, answer.workspaceId, true));
  const code = `${CODE_PREFIX}${random()}`;
  await securityOf(env).issueOAuthCode(await digest(code), { clientId: checked.client.id, redirectUri: checked.redirectUri, challenge: checked.challenge, resource: origins.resource,
    scope, user, workspaceId: answer.workspaceId, label: checked.client.name.slice(0, 60), refresh: checked.client.refresh });
  return Response.json({ redirect: back({ code }) });
}

/* ---------- metadata, registration, tokens and revocation ---------- */

const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...headers } });
/** A form body (application/x-www-form-urlencoded) of at most 16 KiB, each parameter once. */
async function formBody(request: Request): Promise<Record<string, string> | Response> {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return oauthError(400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded.');
  const bytes = await boundedBytes(request.body, 16_384);
  if (!bytes) return oauthError(400, 'invalid_request', 'The request is too large.');
  const form = new URLSearchParams(new TextDecoder().decode(bytes)), names = [...form.keys()];
  if (new Set(names).size !== names.length) return oauthError(400, 'invalid_request', 'Send each parameter once.');
  return Object.fromEntries(form);
}
/** Basic credentials (RFC 6749 section 2.3.1), each part form-encoded. */
function basicCredentials(header: string): { id: string; secret: string } | null {
  try {
    const decoded = atob(header.slice(6)), split = decoded.indexOf(':');
    if (split < 0) return null;
    const decode = (part: string) => decodeURIComponent(part.replaceAll('+', ' '));
    return { id: decode(decoded.slice(0, split)), secret: decode(decoded.slice(split + 1)) };
  } catch { return null; }
}
/** The client a token or revocation request authenticates as: public clients by id, confidential ones with their secret. */
async function authenticateClient(request: Request, env: BraidEnv, form: { client_id?: string; client_secret?: string }): Promise<{ id: string } | Response> {
  const header = request.headers.get('authorization');
  const basic = header?.startsWith('Basic ') ? basicCredentials(header) : null;
  if (header?.startsWith('Basic ') && !basic) return oauthError(401, 'invalid_client', 'The client credentials are malformed.', { 'www-authenticate': 'Basic realm="Braid"' });
  if (basic && form.client_id !== undefined && form.client_id !== basic.id) return oauthError(400, 'invalid_request', 'The client is named twice, differently.');
  const id = basic?.id ?? form.client_id, secret = basic?.secret ?? form.client_secret;
  if (!id) return oauthError(401, 'invalid_client', 'Name the client with client_id.');
  if (id.startsWith('https://')) return !secret ? { id } : oauthError(401, 'invalid_client', 'A client with a metadata document has no secret.');
  const client = await securityOf(env).oauthClient(id);
  if (!client) return oauthError(401, 'invalid_client', 'This client is not registered here. Register it again.');
  if (client.authMethod === 'none') return { id };
  if (!secret || !client.secretDigest || !await equalSecret(await digest(secret), client.secretDigest)) return oauthError(401, 'invalid_client', 'The client secret is not valid.', basic ? { 'www-authenticate': 'Basic realm="Braid"' } : {});
  return { id };
}
async function limited(env: BraidEnv, key: string, limit: number, period: number): Promise<Response | null> {
  const budget = await securityOf(env).consume(key, limit, period);
  return budget.allowed ? null : oauthError(429, 'slow_down', 'Too many requests. Wait the Retry-After interval.', { 'retry-after': String(budget.retryAfter) });
}

/** An access token for /mcp, and the next refresh token when the client registered for refreshing. */
async function issueTokens(env: BraidEnv, origins: Origins, grant: AgentGrant, team: string, scope: OAuthScope, refresh: string | null): Promise<Response> {
  const now = Date.now(), exp = Math.min(grant.expires, now + MCP_ACCESS_LIFETIME);
  const { id, email, name } = grant.user;
  const accessToken = await mintMcpAccess(env, { grant: grant.id, user: { id, email, name }, workspace: grant.workspaceId, team, scope, agent: grant.id, name: grant.label,
    owner: await personOwner(env, grant.user), aud: origins.resource, client: grant.client!, exp });
  return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: Math.floor((exp - now) / 1000), scope, ...(refresh ? { refresh_token: refresh } : {}) }, { headers: NO_STORE });
}

async function register(request: Request, env: BraidEnv, ip: string): Promise<Response> {
  const refused = await limited(env, `oauth-register:${ip}`, 20, 3_600_000) ?? await limited(env, 'oauth-register', 5_000, 86_400_000);
  if (refused) return refused;
  if (!request.headers.get('content-type')?.startsWith('application/json')) return oauthError(400, 'invalid_client_metadata', 'Send the client metadata as JSON.');
  const body = await jsonBody(request).catch((error: unknown) => { if (error instanceof HttpError) return null; throw error; });
  if (!body) return oauthError(400, 'invalid_client_metadata', 'Send the client metadata as one JSON object of at most 16 KiB.');
  const parsed = v.safeParse(oauthRegistration, body);
  if (!parsed.success) return oauthError(400, 'invalid_client_metadata', `${v.getDotPath(parsed.issues[0]) ?? 'metadata'}: ${parsed.issues[0].message}`);
  const metadata = parsed.output;
  const invalid = metadata.redirect_uris.find(uri => !redirectKind(uri));
  if (invalid !== undefined) return oauthError(400, 'invalid_redirect_uri', 'Use HTTPS, a loopback address over HTTP, or an app’s own scheme, without a fragment.');
  const id = crypto.randomUUID(), secret = metadata.token_endpoint_auth_method === 'none' ? undefined : `${SECRET_PREFIX}${random()}`;
  const name = metadata.client_name || shownRedirect(metadata.redirect_uris[0]).host;
  const client: OAuthClient = { id, name, redirectUris: metadata.redirect_uris, authMethod: metadata.token_endpoint_auth_method, grantTypes: metadata.grant_types, createdAt: Date.now(),
    ...(secret ? { secretDigest: await digest(secret) } : {}) };
  await securityOf(env).registerOAuthClient(client);
  return Response.json({ client_id: id, client_id_issued_at: Math.floor(client.createdAt / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name, redirect_uris: client.redirectUris, token_endpoint_auth_method: client.authMethod, grant_types: client.grantTypes, response_types: ['code'] }, { status: 201, headers: NO_STORE });
}

async function token(request: Request, env: BraidEnv, origins: Origins, ip: string): Promise<Response> {
  const refused = await limited(env, `oauth-token:${ip}`, 120, 60_000);
  if (refused) return refused;
  const form = await formBody(request);
  if (form instanceof Response) return form;
  if (!['authorization_code', 'refresh_token'].includes(form.grant_type ?? '')) return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  const parsed = v.safeParse(oauthTokenRequest, form);
  if (!parsed.success) return oauthError(400, 'invalid_request', `${v.getDotPath(parsed.issues[0]) ?? 'request'}: ${parsed.issues[0].message}`);
  const body = parsed.output;
  const client = await authenticateClient(request, env, body);
  if (client instanceof Response) return client;
  if (body.resource !== undefined && !sameResource(body.resource, origins.resource)) return oauthError(400, 'invalid_target', `Ask for the resource ${origins.resource}.`);
  const security = securityOf(env), directory = directoryOf(env);
  const refresh = `${REFRESH_PREFIX}${random()}`;
  if (body.grant_type === 'authorization_code') {
    const redeemed = await security.redeemOAuthCode(await digest(body.code), { clientId: client.id, redirectUri: body.redirect_uri, challenge: await s256(body.code_verifier),
      ...(body.resource === undefined ? {} : { resource: origins.resource }) }, { id: crypto.randomUUID(), refresh: await digest(refresh) });
    if (!redeemed.ok) return oauthError(400, 'invalid_grant', 'The code is invalid, expired or used, or it was issued for another client, redirect or verifier.');
    const allowed = await directory.access(redeemed.grant.user, redeemed.grant.workspaceId, redeemed.grant.scope !== 'read');
    if (!allowed.ok) { await security.revokeAgent(redeemed.grant.user.id, redeemed.grant.id); return oauthError(400, 'invalid_grant', 'The person who approved no longer has access to the repository.'); }
    return issueTokens(env, origins, redeemed.grant, allowed.data.teamId, redeemed.grant.scope as OAuthScope, redeemed.refresh ? refresh : null);
  }
  const scopes = (body.scope ?? '').split(' ').filter(Boolean);
  if (scopes.some(scope => !(SCOPES as readonly string[]).includes(scope))) return oauthError(400, 'invalid_scope', 'Ask for read or work.');
  const rotated = await security.refreshOAuth(await digest(body.refresh_token), client.id, await digest(refresh));
  if (!rotated.ok) return oauthError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked. Authorize again.');
  const grant = rotated.grant;
  // A refresh may narrow the access, never widen it.
  if (grant.scope === 'read' && scopes.includes('work')) return oauthError(400, 'invalid_scope', 'This authorization allows read only.');
  const allowed = await directory.access(grant.user, grant.workspaceId, grant.scope !== 'read');
  if (!allowed.ok) { await security.revokeAgent(grant.user.id, grant.id); return oauthError(400, 'invalid_grant', 'The person who approved no longer has access to the repository.'); }
  return issueTokens(env, origins, grant, allowed.data.teamId, scopes.length && !scopes.includes('work') ? 'read' : grant.scope as OAuthScope, refresh);
}

async function revoke(request: Request, env: BraidEnv, ip: string): Promise<Response> {
  const refused = await limited(env, `oauth-revoke:${ip}`, 60, 60_000);
  if (refused) return refused;
  const form = await formBody(request);
  if (form instanceof Response) return form;
  const parsed = v.safeParse(oauthRevocation, form);
  if (!parsed.success) return oauthError(400, 'invalid_request', 'Send the token to revoke.');
  const client = await authenticateClient(request, env, parsed.output);
  if (client instanceof Response) return client;
  const presented = parsed.output.token;
  const claims = presented.startsWith(MCP_ACCESS_PREFIX) ? await verifyMcpAccess(env, presented) : null;
  if (claims) await securityOf(env).revokeOAuth({ grant: claims.grant }, client.id);
  else if (presented.startsWith(REFRESH_PREFIX)) await securityOf(env).revokeOAuth({ refresh: await digest(presented) }, client.id);
  // An unknown, expired or foreign token answers the same (RFC 7009 section 2.2).
  return new Response(null, { status: 200, headers: NO_STORE });
}

/** The OAuth endpoints outside /api: metadata, registration, tokens and revocation. Other paths answer null. */
export async function oauthRoute(request: Request, env: BraidEnv, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const metadata = path === PROTECTED_RESOURCE || path === `${PROTECTED_RESOURCE}/mcp` || path === AUTHORIZATION_SERVER;
  if (!metadata && !ENDPOINTS.includes(path)) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const origins = oauthOrigins(env, url);
  if (!origins) throw new HttpError(404, 'This Braid has no OAuth sign-in for MCP clients.');
  if (metadata) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } });
    const documentation = `${origins.issuer}/auth.md`;
    return Response.json(path === AUTHORIZATION_SERVER ? {
      issuer: origins.issuer, authorization_endpoint: `${origins.issuer}/oauth/authorize`, token_endpoint: `${origins.issuer}/oauth/token`,
      registration_endpoint: `${origins.issuer}/oauth/register`, revocation_endpoint: `${origins.issuer}/oauth/revoke`,
      scopes_supported: SCOPES, response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, service_documentation: documentation,
    } : { resource: origins.resource, authorization_servers: [origins.issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Braid', resource_documentation: documentation },
    { headers: { 'cache-control': 'public, max-age=3600' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  const address = clientAddress(request);
  if (env.IP_LIMITER && !(await env.IP_LIMITER.limit({ key: await networkKey(address) })).success) return oauthError(429, 'slow_down', 'Too many requests. Try again shortly.', { 'retry-after': '10' });
  const ip = await digest(address);
  if (path === '/oauth/register') return register(request, env, ip);
  if (path === '/oauth/token') return token(request, env, origins, ip);
  return revoke(request, env, ip);
}

/* ---------- the MCP resource ---------- */

/** WWW-Authenticate for /mcp (RFC 6750, RFC 9728): where to authorize, and what went wrong with a token that was sent. */
export function mcpChallenge(env: BraidEnv, url: URL, error?: { code: 'invalid_token' | 'insufficient_scope'; description: string }): string {
  const origins = oauthOrigins(env, url);
  const parts = [...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
    ...(origins ? [`resource_metadata="${origins.metadata}"`] : []), ...(error?.code !== 'invalid_token' ? ['scope="work"'] : [])];
  return `Bearer ${parts.join(', ')}`;
}
/**
 * The credential a /mcp request carries, checked before any tool runs. An OAuth access token must be for this resource
 * and still live; its tools then call the API with a five-minute agent token for the same grant, so every check the
 * gateway makes of an agent applies. An agent token from /auth.md passes through as it is.
 */
export async function mcpCredential(env: BraidEnv, url: URL, authorization: string): Promise<{ ok: true; authorization: string; scope: AgentScope } | { ok: false; description: string }> {
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expired = { ok: false as const, description: 'The access token is invalid, expired or revoked.' };
  if (presented.startsWith(MCP_ACCESS_PREFIX)) {
    const claims = await verifyMcpAccess(env, presented), origins = oauthOrigins(env, url);
    if (!claims || claims.aud !== origins?.resource || await securityOf(env).accessRevoked(claims.grant)) return expired;
    const { v: _version, aud: _audience, client: _client, ...agent } = claims;
    return { ok: true, authorization: `Bearer ${await mintAccess(env, { ...agent, exp: Math.min(claims.exp, Date.now() + ACCESS_LIFETIME) })}`, scope: claims.scope };
  }
  const credential = await agentCredential(env, presented);
  if (!credential || credential.access && await securityOf(env).accessRevoked(credential.access.grant)) return expired;
  return { ok: true, authorization, scope: credential.access ? credential.access.scope : credential.grant.scope };
}
