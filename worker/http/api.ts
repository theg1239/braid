import { directoryOf, securityOf, type BraidEnv } from '../env';
import { mediaProxy } from './media-proxy';
import { assertOrigin, cookie, cookies, digest, equalSecret, jsonBody, SESSION_MS, sessionToken, validSession } from './auth';
import { accessIdentity, type Identity } from './access';
import { errorAnswer, HttpError, logFailure, unwrap } from '../errors';
import type { Account, AccountIdentity } from '../../shared/account';
import { githubCallback, githubLogin, githubSession } from '../accounts/oauth';
import { emailSignIn } from '../accounts/email-auth';
import { agentAuthorization, agentCredential, agentPathAllowed, publicPathAllowed } from './agent-auth';
import { setupGuide } from './setup-guide';
import { guideResponse } from './guide-response';
import type { AgentScope, ChangePage, ChangeSummary, Mission, PullRequestContext, WorkspaceSnapshot } from '../../shared/types';
import { githubImportTransport, githubReturn, githubRoute } from '../github/routes';
import { changesRoute, type ChangeGateway } from '../changes/router';
import { ACCESS_LIFETIME, ACCESS_PREFIX, fleetAgent, mintAccess } from './agent-token';
import { githubWebhook } from '../github/webhook';
import { handleMcp, rpcMessage, type ApiCall } from './mcp';
import { crossOrigin, mcpChallenge, mcpCredential, oauthConsentRoute, oauthRoute } from './oauth';
import { repositoryFromStatuses } from '../changes/ci';
import { repositoryKey, trunkOf } from '../changes/names';
import * as v from 'valibot';
import { accountUsername, agentSession, auditCursor, invite, inviteToken, ownerSession, parse, repositoryLabel, repositoryUpdate, repositoryAddress, repositoryListQuery, workspaceSelection, organizationPersonId, orgTeamCreate, orgTeamUpdate, orgTeamMember, orgTeamRepository, organizationName, organizationMember, teamName, teamUpdate } from '../schemas';
import type { Directory, DirectoryInput } from '../accounts/directory';
import type { ProvenanceOwner } from '../../shared/types';
import { ownerOf, personHandle, personName, personOwner, publicPerson } from '../repositories/provenance';
import { GIT_PATH, gitRemote } from '../git/remote';
import { Timings } from './timing';
import { cachedRepositoryRead, repositoryRead } from './repository-cache';
import { cachedPublicRead, matchesEtag, readCache } from './read-cache';
import { publicResponse, publicMetadata } from './public-view';
import { clientAddress, networkKey, publicRead } from './public-access';
import { redactPublicText } from '../../shared/privacy';
import { EXAMPLE_SESSION_LIMIT } from '../../shared/errors';
import { checkPublicSelectors } from '../repositories/public-revisions';
import { servePage } from './social';

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function headers(response: Response, request: Request, requestId: string) {
  const result = new Response(request.method === 'HEAD' ? null : response.body, response);
  const { protocol, pathname } = new URL(request.url);
  for (const [name, value] of Object.entries(securityHeaders)) result.headers.set(name, value);
  result.headers.set('x-request-id', requestId);
  if (result.status === 429 && !result.headers.has('retry-after')) result.headers.set('retry-after', '60');
  // MCP clients that run in a web page reach /mcp and OAuth with bearer tokens only, never with a session cookie.
  if (crossOrigin(pathname)) {
    result.headers.set('access-control-allow-origin', '*');
    result.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    result.headers.set('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, x-braid-workspace');
    result.headers.set('access-control-expose-headers', 'www-authenticate');
    result.headers.set('access-control-max-age', '86400');
  }
  if (protocol === 'https:') result.headers.set('strict-transport-security', 'max-age=31536000');
  // Pages and static files are normally served without the Worker, with these headers from public/_headers.
  // API answers are never cached, except content-addressed evidence images, which say so themselves.
  if (pathname.startsWith('/api/') && !response.headers.has('cache-control')) result.headers.set('cache-control', 'no-store');
  // Media keeps its own sandbox policy: an SVG opened directly must not run as this site. Remote media reaches the page
  // only through /api/media, so the browser contacts no other host.
  else if (protocol === 'https:' && !response.headers.has('content-security-policy')) result.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  return result;
}

export default {
  async fetch(request: Request, env: BraidEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const timings = new Timings();
    try {
      const response = await route(request, env, timings);
      if (response.status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId, status: response.status, elapsedMs: Date.now() - started }));
      const answered = headers(response, request, requestId);
      if (new URL(request.url).pathname.startsWith('/api/')) answered.headers.set('server-timing', [timings.header(), `total;dur=${Date.now() - started}`].filter(Boolean).join(', '));
      return answered;
    } catch (error) {
      const { status, error: message, retryAfter, ...answer } = errorAnswer(error, 'The operation could not complete. Try again using the same request.');
      if (status >= 500) logFailure('request_failed', error, { requestId, status, elapsedMs: Date.now() - started });
      return headers(Response.json({ error: redactPublicText(message), ...answer, requestId }, { status, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} }), request, requestId);
    }
  },
} satisfies ExportedHandler<BraidEnv>;

/**
 * Braid as an MCP server: each tool is a request to this API with the caller's own credentials and address. A missing,
 * invalid or too narrow credential answers as OAuth asks (RFC 6750), so MCP clients can authorize and try again.
 */
async function mcp(request: Request, env: BraidEnv, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Send one JSON-RPC message.' } }, { status: 400 }); }
  const message = v.safeParse(rpcMessage, json);
  if (!message.success) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC message.' } }, { status: 400 });
  const presented = request.headers.get('authorization');
  const credential = presented ? await mcpCredential(env, url, presented) : null;
  const refuse = (status: 401 | 403, error: string, code?: 'invalid_token' | 'insufficient_scope') =>
    Response.json({ error }, { status, headers: { 'www-authenticate': mcpChallenge(env, url, code && { code, description: code === 'invalid_token' ? 'The access token is invalid, expired or revoked.' : 'This tool needs work access.' }) } });
  if (credential && !credential.ok) return refuse(401, credential.description, 'invalid_token');
  const forward = ['x-braid-workspace', 'cf-connecting-ip'].flatMap(name => { const value = request.headers.get(name); return value ? [[name, value] as [string, string]] : []; });
  if (credential) forward.push(['authorization', credential.authorization]);
  const api: ApiCall = async (method, path, body, key) => {
    const response = await route(new Request(new URL(path, url.origin), { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...Object.fromEntries(forward), origin: url.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) } }), env);
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  try {
    const result = await handleMcp(message.output, api, !!credential, { ...(credential ? { scope: credential.scope } : {}), workspace: request.headers.has('x-braid-workspace') });
    return result ? Response.json(result) : new Response(null, { status: 202 });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return refuse(401, error.message, presented ? 'invalid_token' : undefined);
    if (error instanceof HttpError && error.code === 'insufficient_scope') return refuse(403, error.message, 'insufficient_scope');
    throw error;
  }
}

/** Only resource answers get browser links; file contents and failed requests are never rewritten. */
const taskResource = /^\/api\/(?:missions|tasks)(?:\/([^/]+)(?:\/(?:finish|cancel|resolve|merge|agents\/[^/]+\/(?:checkout|update|progress|submit)))?)?$/;
const changeResource = /^\/api\/changes(?:\/[^/]+(?:\/(?:revisions|restack|reviews|approve|close|revert|comments(?:\/[^/]+\/resolve)?))?)?$/;
const hasBrowserUrls = (path: string, method: string) => path === '/api/state' || path === '/api/coordination' || taskResource.test(path)
  || (changeResource.test(path) && path !== '/api/changes/checkout' && !(path.endsWith('/comments') && ['GET', 'HEAD'].includes(method)))
  || (/^\/api\/instructions(?:\/[^/]+)?$/.test(path) && ['POST', 'DELETE'].includes(method));

/** Run after authorization and edge-cache reads: cached bodies never retain another origin or an old address. */
async function browserUrls(response: Response, request: Request, base: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!response.ok || !hasBrowserUrls(path, request.method)) return response;
  const pull = <T extends { number: number }>(value: T) => ({ ...value, html_url: `${base}/pull/${value.number}` });
  const mission = (value: Mission) => ({ ...value, html_url: `${base}/tasks/${encodeURIComponent(value.id)}`,
    agents: value.agents?.map(agent => ({ ...agent, ...(agent.change ? { change: pull(agent.change) } : {}) })) });
  let data: unknown = await response.json();
  if (path === '/api/state') {
    const snapshot = data as WorkspaceSnapshot;
    data = { ...snapshot, missions: snapshot.missions?.map(mission) };
  } else if (path === '/api/coordination') {
    data = Object.fromEntries(Object.entries(data as Record<string, { number: number }[]>).map(([path, changes]) => [path, changes.map(pull)]));
  } else if (path === '/api/changes' && ['GET', 'HEAD'].includes(request.method)) {
    const page = data as ChangePage;
    data = { ...page, items: page.items.map(pull) };
  } else if (taskResource.test(path)) {
    if (Array.isArray(data)) data = (data as Mission[]).map(mission);
    else {
      const value = data as Partial<Mission> & { missionId?: string; change?: { number: number }; pullRequest?: PullRequestContext };
      const id = taskResource.exec(path)![1] ?? value.missionId!;
      data = { ...value, html_url: `${base}/tasks/${encodeURIComponent(id)}`,
        ...(value.agents ? { agents: mission(value as Mission).agents } : {}),
        ...(value.change ? { change: pull(value.change) } : {}), ...(value.pullRequest ? { pullRequest: pull(value.pullRequest) } : {}) };
    }
  } else data = pull(data as ChangeSummary);
  const answer = Response.json(data, response);
  // Validators cover the address as well as the underlying resource, including after an owner/repository rename.
  if (response.headers.has('etag')) {
    const etag = `"${await digest(`${response.headers.get('etag')}:${base}`)}"`;
    answer.headers.set('etag', etag);
    if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers: answer.headers });
  }
  return answer;
}

/** Requests that create work someone owns: changes and their revisions, reverts, review comments, instructions, simulations, tasks and task results. */
const ownsWork = (path: string, method: string) => method === 'POST' || method === 'DELETE'
  ? /^\/api\/changes(?:\/[^/]+\/(?:revisions|restack|revert|comments(?:\/[^/]+\/resolve)?))?$/.test(path) || /^\/api\/instructions(?:\/|$)/.test(path) || path === '/api/swarm' || path === '/api/missions'
    || /^\/api\/missions\/[^/]+\/agents\/[^/]+\/submit$/.test(path) || /^\/git\/[^/]+\.git\/git-receive-pack$/.test(path)
  : false;
/**
 * Git authenticates with Basic auth, the agent's token as its password, and names the repository in its path; the
 * request continues as a bearer request for that repository. Without credentials, Git is asked for them.
 */
const gitAuthentication = () => new Response('Authenticate with your Braid agent token as the password.\n', { status: 401,
  headers: { 'www-authenticate': 'Basic realm="Braid"', 'content-type': 'text/plain; charset=utf-8' } });
function basicPassword(authorization: string | null): string {
  if (!authorization?.startsWith('Basic ')) return '';
  try { return atob(authorization.slice(6)).split(':').slice(1).join(':'); } catch { return ''; }
}
function gitRequest(request: Request, workspace: string): Request {
  const password = basicPassword(request.headers.get('authorization'));
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  if (password) headers.set('authorization', `Bearer ${password}`);
  else headers.delete('authorization');
  headers.set('x-braid-workspace', workspace);
  return new Request(request, { headers });
}
/** A screenshot may name its repository in the query, so a plain `<img>` can show it; the session still authorizes it. */
const EVIDENCE_IMAGE = /^\/api\/changes\/[^/]+\/evidence\/[^/]+$/;

/** Writable copies of the example one address may open a day; a venue's visitors often share one address. */
const EXAMPLE_SESSIONS = 40;
/** The region for a new copy of the recorded example, from where the visitor's request entered Cloudflare. */
function exampleLocation(entered: Request['cf']): DurableObjectLocationHint | undefined {
  const cf = entered as { continent?: string; country?: string; longitude?: string } | undefined;
  const longitude = Number(cf?.longitude);
  switch (cf?.continent) {
    case 'AF': return 'afr';
    case 'AS': return ['AE', 'BH', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'QA', 'SA', 'SY', 'TR', 'YE'].includes(cf.country ?? '') ? 'me' : 'apac';
    case 'EU': return longitude > 20 ? 'eeur' : 'weur';
    case 'NA': return longitude < -100 ? 'wnam' : 'enam';
    case 'SA': return 'sam';
    case 'OC': return 'oc';
    default: return undefined;
  }
}

/** GitHub's clone address, `/<owner>/<repo>.git`, which only a public repository answers to; tokens use `/git/<id>.git`. */
const GIT_ADDRESS = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** `entered` is where the visitor's own request entered Cloudflare, which a request made on their behalf does not carry. */
async function route(request: Request, env: BraidEnv, timings = new Timings(), entered = request.cf): Promise<Response> {
  const url = new URL(request.url);
  const addressed = !url.pathname.startsWith('/git/') && !url.pathname.startsWith('/api/') ? GIT_ADDRESS.exec(url.pathname) : null;
  if (addressed) {
    const network = await networkKey(clientAddress(request));
    if (env.IP_LIMITER && !(await env.IP_LIMITER.limit({ key: network })).success) throw new HttpError(429, 'Too many requests. Try again shortly.', 10);
    const parsed = v.safeParse(repositoryAddress, { owner: addressed[1], repo: addressed[2] });
    const credential = await agentCredential(env, basicPassword(request.headers.get('authorization')));
    const found = parsed.success ? await directoryOf(env).resolveRepository(credential?.user.id ?? null, parsed.output.owner, parsed.output.repo) : null;
    if (!found?.ok || found.data.visibility !== 'public' && found.data.workspaceId !== credential?.workspace) throw new HttpError(404, 'Repository not found.');
    // From here it is the repository's own Git path, with every check that path has.
    return route(new Request(new URL(`/git/${found.data.workspaceId}.git/${addressed[3]}${url.search}`, url), request), env, timings);
  }
  const git = GIT_PATH.exec(url.pathname);
  if (/^\/git\/demo\.git(?:\/|$)/.test(url.pathname)) throw new HttpError(404, 'Repository not found.');
  if (git) request = gitRequest(request, parse(workspaceSelection, git[1]));
  // An <img> or <video> cannot send headers, so evidence images and a README's media name the repository in the address.
  const requestedWorkspace = request.headers.get('x-braid-workspace') ?? (['GET', 'HEAD'].includes(request.method) && (EVIDENCE_IMAGE.test(url.pathname) || url.pathname === '/api/repository' && url.searchParams.get('media') === '1') ? url.searchParams.get('workspace') : null);
  const guide = request.method === 'GET' ? setupGuide(url.pathname, env.PUBLIC_ORIGIN || url.origin, url.searchParams) : null;
  if (guide) return guideResponse(request, guide, env.PUBLIC_ORIGIN || url.origin, env.BUILD_ID ?? 'dev');
  if (url.pathname === '/mcp') return mcp(request, env, url);
  const oauth = await oauthRoute(request, env, url);
  if (oauth) return oauth;
  if (!url.pathname.startsWith('/api/') && !git) return servePage(request, env);
  // Signed by GitHub rather than a browser session, so it precedes origin and session checks.
  if (url.pathname === '/api/github/webhook' && request.method === 'POST') return githubWebhook(request, env);
  // CI reports statuses for a merge group, authenticated by the webhook secret's signature rather than a session.
  const statuses = url.pathname.match(/^\/api\/statuses\/([A-Za-z0-9_-]{1,300})\/([a-f0-9]{40})$/);
  if (statuses && request.method === 'POST') {
    const key = repositoryFromStatuses(statuses[1]);
    const body = await request.text();
    if (!key || body.length > 16_384) throw new HttpError(400, 'Unknown repository or oversized status.');
    const result = await trunkOf(env, key).report(key, statuses[2], body, request.headers.get('x-braid-signature-256'));
    if (!result.ok) unwrap(result);
    return Response.json({ ok: true }, { status: 201 });
  }
  const githubImport = url.pathname.startsWith('/api/github/import/');
  // Git and the import bridge authenticate every request themselves, never with a browser's cookies.
  if (!githubImport && !git && !['GET', 'HEAD'].includes(request.method)) assertOrigin(request);
  if (url.pathname === '/api/health' && request.method === 'GET') return Response.json({ ok: true, product: 'Braid' });
  if (!['owner-key', 'access', 'github'].includes(env.AUTH_MODE)) throw new HttpError(503, 'Workspace authentication is not configured.');
  const security = securityOf(env);
  const address = clientAddress(request);
  const ip = await digest(address);
  const network = await networkKey(address);
  // The rate-limit binding is local to each Cloudflare location and never queues behind one object.
  if (env.IP_LIMITER) {
    if (!(await env.IP_LIMITER.limit({ key: network })).success) return Response.json({ error: 'Too many requests. Try again shortly.' }, { status: 429, headers: { 'retry-after': '10' } });
  } else {
    const budget = await security.consume(`requests:${network}`, 3000, 60_000);
    if (!budget.allowed) return Response.json({ error: 'Too many requests. Try again shortly.' }, { status: 429, headers: { 'retry-after': String(budget.retryAfter) } });
  }
  if (githubImport) return githubImportTransport(request, env);
  if (url.pathname === '/api/media') return mediaProxy(request);
  const anonymousBudget = async () => {
    const allowed = env.ANONYMOUS_LIMITER ? (await env.ANONYMOUS_LIMITER.limit({ key: network })).success : (await security.consume(`public:${network}`, 300, 60_000)).allowed;
    if (!allowed) throw new HttpError(429, 'Too many requests. Try again shortly.');
  };
  const publicBudget = async () => {
    await anonymousBudget();
    if (/\/(?:diff|compare)$/.test(url.pathname) || ['/api/policy', '/api/instructions', '/api/blame', '/api/repository/commits', '/api/repository/tree/commits', '/api/repository/commit', '/api/repository/search'].includes(url.pathname) || url.pathname === '/api/repository' && url.searchParams.has('download') || git?.[2] === 'git-upload-pack') {
      const allowed = env.PUBLIC_EXPENSIVE_LIMITER ? (await env.PUBLIC_EXPENSIVE_LIMITER.limit({ key: network })).success
        : (await security.consume(`public-expensive:${network}`, 60, 60_000)).allowed;
      if (!allowed) throw new HttpError(429, 'Too many content requests. Retry shortly.', 60);
    }
  };
  const stored = cookies(request);
  let identity: Identity | undefined;
  let displayName: string | undefined;
  let publicViewer = false, privateMirror = false;
  let workspaceName: string | undefined, teamId: string | undefined, selectedWorkspace: string | undefined;
  let repositoryPath: string | undefined;
  let agentScope: AgentScope | undefined;
  let agentConnection: { id: string; digest: string; expires: number; label: string; model?: string; fleet?: string } | undefined;
  /** Whose agent this is, or whose change: read from the access token, or looked up for requests that create work. */
  let owner: ProvenanceOwner | undefined;
  const write = !['GET', 'HEAD'].includes(request.method) && !(git?.[2] === 'git-upload-pack' && request.method === 'POST');
  const gitRead = git && ((git[2] === 'info/refs' && ['GET', 'HEAD'].includes(request.method) && url.searchParams.get('service') === 'git-upload-pack') || (git[2] === 'git-upload-pack' && request.method === 'POST'));
  const publicAccounts = env.AUTH_MODE !== 'owner-key';
  const explicitDemo = publicAccounts && requestedWorkspace === 'demo';
  if (publicAccounts) {
    if (env.AUTH_MODE === 'github' && request.method === 'GET' && ['/api/github/callback', '/api/github/installed'].includes(url.pathname)) return githubReturn(request, env);
    if (env.AUTH_MODE === 'github' && request.method === 'GET' && url.pathname === '/api/auth/github') {
      const loginBudget = await security.consume(`login:${ip}`, 8, 300_000);
      if (!loginBudget.allowed) throw new HttpError(429, 'Too many sign-in attempts. Try again shortly.', loginBudget.retryAfter);
      return githubLogin(request, env);
    }
    if (env.AUTH_MODE === 'github' && request.method === 'GET' && url.pathname === '/api/auth/github/callback') return githubCallback(request, env);
    if (env.AUTH_MODE === 'github' && request.method === 'POST' && /^\/api\/auth\/email\/(start|verify)$/.test(url.pathname)) return emailSignIn(request, env, ip);
    if (env.AUTH_MODE === 'github' && request.method === 'DELETE' && url.pathname === '/api/session') {
      if (stored['braid-session']) await security.revoke(await digest(stored['braid-session']));
      return Response.json({ ok: true }, { headers: { 'set-cookie': cookie('braid-session', '', request, 0) } });
    }
    let user: AccountIdentity | null = null;
    if (env.AUTH_MODE === 'github') user = await timings.wait('session', githubSession(request, env));
    else if (!explicitDemo && request.headers.has('cf-access-jwt-assertion')) {
      const verified = await accessIdentity(request, env);
      user = { id: `access:${verified.id}`, email: verified.email!, name: verified.email! };
    }
    const bearer = request.headers.get('authorization');
    // A browser task link resolves its address using the connection it will use for checkout.
    const agentAddressRead = request.method === 'GET' && /^\/api\/repos\/[^/]+\/[^/]+$/.test(url.pathname);
    let agentWorkspace: string | undefined;
    if (bearer) {
      const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
      const credential = await agentCredential(env, token);
      // Recheck each request so a completed revocation cannot leave a cached permission behind.
      if (!credential || credential.access && await security.accessRevoked(credential.access.grant)) {
        await anonymousBudget();
        throw new HttpError(401, token.startsWith(ACCESS_PREFIX) ? 'The access token is invalid or expired. Exchange the agent connection for a new one at /api/agent/session.' : 'The agent connection is invalid, expired, or revoked.');
      }
      if (credential.access) {
        const claims = credential.access;
        if ((!agentPathAllowed(url.pathname, request.method, claims.scope) && !agentAddressRead) || url.pathname.startsWith('/api/missions/')) throw new HttpError(403, 'Access tokens cover changes and reads; task checkouts use the agent connection itself.');
        if (requestedWorkspace && requestedWorkspace !== claims.workspace) throw new HttpError(403, 'This access token belongs to a different repository.');
        agentScope = claims.scope;
        agentConnection = { id: claims.agent, digest: '', expires: claims.exp, label: claims.name, ...(claims.model ? { model: claims.model } : {}), ...(claims.fleet ? { fleet: claims.fleet } : {}) };
        owner = claims.owner ?? ownerOf(claims.user, null, await publicPerson(env, claims.user.id));
        if (env.AGENT_LIMITER && !(await env.AGENT_LIMITER.limit({ key: claims.agent })).success) return Response.json({ error: 'This agent is sending too many requests. Slow down.' }, { status: 429, headers: { 'retry-after': '10' } });
      } else {
        const { grant } = credential;
        // Exchanging a connection for a short-lived access token checks the grant and membership once.
        if (url.pathname === '/api/agent/session' && request.method === 'POST') {
          const allowed = await directoryOf(env).access(grant.user, grant.workspaceId, grant.scope !== 'read');
          if (!allowed.ok) throw new HttpError(403, 'The approving owner no longer has repository access.');
          const { name, model } = parse(agentSession, await jsonBody(request));
          let agent = { id: grant.id, name: grant.label || 'Connected agent' };
          if (grant.scope === 'fleet') {
            if (!name) throw new HttpError(400, 'Name each fleet agent with 1–60 letters, digits, spaces or . : @ / - characters.');
            agent = fleetAgent(grant.id, name);
          }
          const exp = Math.min(grant.expires, Date.now() + ACCESS_LIFETIME);
          // The approving person owns every agent the connection mints, as GitHub knows them when Braid can tell.
          const owner = await personOwner(env, grant.user);
          const accessToken = await mintAccess(env, { grant: grant.id, user: grant.user, workspace: grant.workspaceId, team: allowed.data.teamId,
            scope: grant.scope === 'fleet' ? 'work' : grant.scope, agent: agent.id, name: agent.name, ...(model ? { model } : {}), owner, ...(grant.scope === 'fleet' ? { fleet: grant.label } : {}), exp });
          return Response.json({ accessToken, tokenType: 'Bearer', expiresAt: new Date(exp).toISOString(), agent, workspaceId: grant.workspaceId });
        }
        agentScope = grant.scope;
        agentConnection = { id: grant.id, digest: credential.digest, expires: grant.expires, label: grant.label || 'Connected agent' };
        if (!agentPathAllowed(url.pathname, request.method, grant.scope) && !agentAddressRead) throw new HttpError(403, 'This agent connection cannot perform that operation.');
        if (requestedWorkspace && requestedWorkspace !== grant.workspaceId) throw new HttpError(403, 'This agent connection belongs to a different repository.');
      }
      agentWorkspace = credential.workspace; user = credential.user;
    }
    if (url.pathname.startsWith('/api/agent/')) return agentAuthorization(request, env, ip, user);
    if (url.pathname === '/api/oauth/authorize') {
      if (agentScope) throw new HttpError(403, 'Only a person authorizes MCP clients.');
      return oauthConsentRoute(request, env, url, user);
    }
    if (url.pathname.startsWith('/api/github/')) {
      if (!user) throw new HttpError(401, 'Sign in to connect a GitHub repository.');
      if (agentScope) throw new HttpError(403, 'Choose and authorize GitHub repositories in Braid.');
      return githubRoute(request, env, user, request.headers.get('x-braid-workspace') || '');
    }
    if (env.AUTH_MODE === 'github' && /^\/api\/auth\/passkeys(?:\/(?:register|authenticate)\/(?:options|verify)|\/[^/]+)?$/.test(url.pathname)) return (await import('../accounts/passkeys')).passkeyRoute(request, env, user);
    if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/unsubscribe') return (await import('../accounts/notify-routes')).notificationRoute(request, env, user, agentScope);
    if (url.pathname === '/api/providers' || url.pathname.startsWith('/api/providers/')) return (await import('../agents/provider-routes')).providerRoute(request, env, user, agentScope);
    const directory = directoryOf(env);
    if (user && (agentScope || env.AUTH_MODE === 'access')) user = await directory.identity(user);
    if (owner && user?.username) owner = { ...owner, name: `@${user.username}` };
    const answer = await accountRoute(request, env, url, user, agentScope, anonymousBudget, agentWorkspace, network);
    if (answer) return answer;
    if (url.pathname === '/api/search' && request.method === 'GET') {
      if (!user) await anonymousBudget();
      return (await import('../repositories/search-all')).searchAllRoute(request, env, user, agentWorkspace, network, q => {
        const example = new URL('/api/repository/search', url); example.searchParams.set('q', q);
        const headers = new Headers(request.headers); headers.set('x-braid-workspace', 'demo');
        // The visitor's regional copy of the example, the one their other reads keep warm, rather than a copy of its own.
        return route(new Request(example, { headers }), env, timings, request.cf);
      });
    }
    if (!explicitDemo) {
      selectedWorkspace = agentWorkspace || requestedWorkspace || '';
      if (!selectedWorkspace) {
        if (!user) throw new HttpError(401, 'Sign in to open your organizations and repositories.');
        throw new HttpError(400, 'Select a repository first.');
      }
      selectedWorkspace = parse(workspaceSelection, selectedWorkspace);
      // Membership and team grants are live even for previously minted agent tokens.
      const access = user ? await timings.wait('directory', directory.access(user, selectedWorkspace, write)) : null;
      if (access?.ok) {
        const allowed = access.data;
        privateMirror = !!allowed.privateMirror;
        if (allowed.readOnly) {
          if (!gitRead && !publicPathAllowed(url.pathname, request.method)) throw new HttpError(403, 'Claim this GitHub owner to enable Braid features first.');
          publicViewer = true;
        }
        teamId = allowed.teamId;
        repositoryPath = `/${allowed.ownerSlug}/${allowed.repoSlug}`;
        displayName = personHandle(user!);
        identity = { ...user!, role: allowed.role === 'owner' ? 'owner' : 'viewer', provider: env.AUTH_MODE === 'github' ? 'github' : 'cloudflare-access' };
        if (!owner && ownsWork(url.pathname, request.method)) owner = await personOwner(env, user!);
      } else {
        // An existing member's denied write must not turn into anonymous access.
        if (access && access.status !== 404) unwrap(access);
        await publicBudget();
        // Link-bearing answers read the address with access, so a cached visibility lease cannot retain an old slug.
        const allowed = await timings.wait('public', hasBrowserUrls(url.pathname, request.method) ? directory.publicRead(selectedWorkspace) : publicRead(env, selectedWorkspace));
        if (!allowed.ok) {
          if (git && !user) return gitAuthentication();
          throw new HttpError(404, 'Repository not found.');
        }
        if (!gitRead && !publicPathAllowed(url.pathname, request.method)) {
          if (git && !user) return gitAuthentication();
          throw new HttpError(user ? 403 : 401, 'Sign in with repository access to use this endpoint.');
        }
        teamId = allowed.data.teamId;
        repositoryPath = `/${allowed.data.ownerSlug}/${allowed.data.repoSlug}`;
        publicViewer = true;
      }
      workspaceName = repositoryKey(teamId, selectedWorkspace);
    }
  } else {
    if (url.pathname === '/api/account' && request.method === 'GET') {
      const organizations: Account['organizations'] = [];
      return Response.json({ user: null, organizations, teams: organizations, provider: 'owner-key', signupEnabled: false, methods: { github: false, email: false, passkeys: false } } satisfies Account & { teams: Account['organizations'] });
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const attempts = await security.consume(`login:${ip}`, 8, 300_000);
      if (!attempts.allowed) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.', attempts.retryAfter);
      if (env.LIVE_ENABLED === 'false') throw new HttpError(503, 'Use the deployed workspace to run live agents.');
      if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new HttpError(503, 'The owner key must contain at least 32 characters.');
      const { token: key } = parse(ownerSession, await jsonBody(request));
      if (!await equalSecret(key, env.ADMIN_TOKEN)) throw new HttpError(401, 'That owner key is not valid.');
      const expires = Date.now() + SESSION_MS;
      const token = await sessionToken(env.ADMIN_TOKEN, expires);
      await security.issue(await digest(token), expires);
      return Response.json({ ok: true }, { headers: { 'set-cookie': cookie('braid-owner', token, request) } });
    }
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
      if (stored['braid-owner']) await security.revoke(await digest(stored['braid-owner']));
      return Response.json({ ok: true }, { headers: { 'set-cookie': cookie('braid-owner', '', request, 0) } });
    }
    if (await validSession(env.ADMIN_TOKEN, stored['braid-owner']) && await security.valid(await digest(stored['braid-owner'])))
      identity = { id: 'owner', role: 'owner', provider: 'owner-key' };
    // An expired/revoked live session must never turn a write into a demo operation.
    if (stored['braid-owner'] && !identity) throw new HttpError(401, 'Your session ended. Sign in again to continue.');
  }
  if (!identity && !publicViewer) await anonymousBudget();
  if (identity && write && identity.role !== 'owner') throw new HttpError(403, 'Only a workspace owner can change repository state or run agents.');
  if (identity && write && env.LIVE_ENABLED === 'false') throw new HttpError(503, 'Live repository writes are disabled for this deployment.');
  const demoSecret = env.SESSION_SECRET || env.ADMIN_TOKEN || (env.LIVE_ENABLED === 'false' ? 'local-recorded-example' : '');
  const validId = await validSession(demoSecret, stored['braid-demo']);
  let demoToken = validId ? stored['braid-demo'] : '';
  /**
   * A visitor without a session has changed nothing, so they read the example as it starts: their region's shared copy,
   * which nobody changes and which is renewed hourly so its times stay current, through each data center's cache.
   * Their first change counts against the network's sessions for the day and opens their own copy. Past that count,
   * a signed marker keeps the network read-only until it resets, without counting again.
   */
  const visitor = !identity && !publicViewer && !validId;
  let readOnly = visitor && await validSession(`${demoSecret}:shared`, stored['braid-demo-shared']), sharedUntil = 0;
  if (visitor && write && !readOnly) {
    if (!demoSecret) throw new HttpError(503, 'The recorded example has no session key configured.');
    const session = await timings.wait('example', security.exampleSession(ip, await sessionToken(demoSecret), EXAMPLE_SESSIONS, 86_400_000));
    if ('retryAfter' in session) { readOnly = true; sharedUntil = Date.now() + Math.min(session.retryAfter, 86_400) * 1000; }
    else demoToken = session.token;
  }
  if (readOnly && write) {
    const refusal = Response.json({ code: 'example_session_limit', error: EXAMPLE_SESSION_LIMIT }, { status: 429, headers: { 'retry-after': '3600' } });
    if (sharedUntil) refusal.headers.append('set-cookie', cookie('braid-demo-shared', await sessionToken(`${demoSecret}:shared`, sharedUntil), request, Math.ceil((sharedUntil - Date.now()) / 1000)));
    return refusal;
  }
  const sharedExample = visitor && !write;
  const live = !!identity || publicViewer;
  // A copy of the example lives near the visitor who opened it, so its reads do not cross an ocean; the shared one has a copy per region.
  const location = live ? undefined : exampleLocation(entered);
  const hour = Math.floor(Date.now() / 3_600_000);
  // Each deploy reads its own shared copies and cached answers, so a new version never answers with the last one's.
  const epoch = env.BUILD_ID ? `${hour}.${env.BUILD_ID}` : String(hour);
  const demoId = sharedExample ? `shared:${location ?? 'any'}:${epoch}` : demoToken.split('.')[1];
  const workspaceKey = live ? workspaceName ?? 'owner-v1' : `demo:${demoId}`;
  const workspace = env.WORKSPACES.get(env.WORKSPACES.idFromName(workspaceKey), location ? { locationHint: location } : undefined);
  const forwarded = new Request(request, publicViewer && request.method === 'HEAD' ? { method: 'GET' } : undefined);
  if (hasBrowserUrls(url.pathname, request.method)) forwarded.headers.delete('if-none-match');
  for (const name of [...forwarded.headers.keys()]) if (name.startsWith('x-braid-')) forwarded.headers.delete(name);
  forwarded.headers.set('x-braid-mode', live ? 'live' : 'demo');
  forwarded.headers.set('x-braid-repository', workspaceKey);
  forwarded.headers.set('x-braid-role', publicViewer || agentScope === 'read' || sharedExample ? 'viewer' : identity?.role ?? 'demo');
  forwarded.headers.set('x-braid-actor', encodeURIComponent(displayName ?? identity?.id ?? (publicViewer ? 'Public viewer' : 'Demo visitor')));
  if (publicViewer) {
    forwarded.headers.set('x-braid-public', 'true');
    forwarded.headers.set('x-braid-public-network', network);
  }
  // Header values are bytes, so a name in any script travels encoded.
  if (owner) forwarded.headers.set('x-braid-owner', encodeURIComponent(JSON.stringify(owner)));
  if (agentConnection) {
    forwarded.headers.set('x-braid-connection', agentConnection.id);
    forwarded.headers.set('x-braid-connection-digest', agentConnection.digest);
    forwarded.headers.set('x-braid-connection-expires', String(agentConnection.expires));
  }
  const viewer = { canWrite: !publicViewer && !readOnly && agentScope !== 'read' && (!identity || identity.role === 'owner'), ...(identity ? { identity } : {}) };
  // Conditional reads must cover the permission and identity fields added by this gateway.
  forwarded.headers.set('x-braid-viewer', await digest(JSON.stringify(viewer)));
  if (teamId && selectedWorkspace && identity) {
    forwarded.headers.set('x-braid-team', teamId);
    forwarded.headers.set('x-braid-workspace', selectedWorkspace);
    forwarded.headers.set('x-braid-user-id', identity.id);
  }
  // Changes, the landing queue and coordination are sharded across their own objects, not the workspace.
  // The forwarded copy owns the request body now; whichever route handles it reads it once.
  const gateway: ChangeGateway = {
    repository: workspaceKey, publicViewer, publicNetwork: network, mode: live ? 'live' : 'demo', ...(location ? { location } : {}),
    role: publicViewer || agentScope === 'read' || sharedExample ? 'viewer' : identity?.role ?? 'demo',
    ...(identity ? { person: { id: identity.id, name: displayName ?? personName(identity.id), ...(owner && !agentConnection ? { owner } : {}) } } : {}),
    ...(agentConnection && agentScope ? { agent: { id: agentConnection.id, label: agentConnection.label, scope: agentScope, ...(agentConnection.model ? { model: agentConnection.model } : {}),
      ...(agentConnection.fleet ? { fleet: agentConnection.fleet } : {}), ...(owner ? { owner } : {}) } } : {}),
    ...(teamId && selectedWorkspace && identity ? { authorization: { user: { id: identity.id, email: identity.email ?? identity.id, name: identity.email ?? identity.id }, workspaceId: selectedWorkspace, teamId } } : {}),
  };
  if (git) return gitRemote(forwarded, env, gateway, `${url.origin}${repositoryPath ?? ''}`);
  // Before any reader or edge cache: a public caller's revisions must be ones Braid reads strictly.
  if (publicViewer) checkPublicSelectors(url);
  // The shared copy of the example never changes within its hour, so each data center keeps its answers for the rest of it.
  const shared = sharedExample && request.method === 'GET' ? new Request(`https://example.braid.invalid/${epoch}${url.pathname}${url.search}`) : null;
  const kept = shared ? await readCache('example') : null;
  let result = shared && kept ? await timings.wait('cache', kept.match(shared)) : undefined;
  const validator = result?.headers.get('etag');
  if (validator && !hasBrowserUrls(url.pathname, request.method) && matchesEtag(request, validator)) return new Response(null, { status: 304, headers: { etag: validator } });
  // Trees and files of a public repository are kept at the edge by commit, for visitors and members alike.
  const shareable = !privateMirror && live && repositoryRead(url, forwarded.method) && (publicViewer || (!!selectedWorkspace && (await publicRead(env, selectedWorkspace)).ok));
  if (!result) {
    const read = async () => {
      forwarded.headers.set('x-braid-sent', String(Date.now()));
      const routed = await timings.wait('changes', changesRoute(forwarded, env, gateway));
      return routed ?? await timings.wait('workspace', shareable ? cachedRepositoryRead(forwarded, workspaceKey, env.BUILD_ID ?? 'dev', timings, publicViewer, request => workspace.fetch(request)) : workspace.fetch(forwarded));
    };
    result = publicViewer && !identity && forwarded.method === 'GET' && ['/api/state', '/api/coordination'].includes(url.pathname)
      ? await cachedPublicRead(new Request(`https://reads.braid.invalid/${env.BUILD_ID ?? 'dev'}/${encodeURIComponent(workspaceKey)}${url.pathname}${url.search}`), 5, read)
      : await read();
    timings.add(result.headers.get('server-timing'), 'do-');
    if (shared && kept && result.status === 200) {
      const copy = new Response(result.clone().body, result);
      // Kept until the hour's copy is replaced: the key names the hour, so nothing outlives it.
      copy.headers.set('cache-control', `public, max-age=${Math.max(60, Math.ceil(((hour + 1) * 3_600_000 - Date.now()) / 1000))}`);
      copy.headers.delete('server-timing');
      await kept.put(shared, copy);
    }
  }
  let response = new Response(result.body, result);
  // Repository visibility and membership can change after this read, even when its commit cannot.
  if (live && (EVIDENCE_IMAGE.test(url.pathname) || url.pathname === '/api/repository' && url.searchParams.get('media') === '1')) response.headers.set('cache-control', 'private, no-store');
  if (url.pathname === '/api/state' && result.ok) {
    const snapshot = await response.json() as { capabilities: Record<string, unknown> };
    Object.assign(snapshot.capabilities, viewer);
    response = Response.json(snapshot, result);
    // The same shared data has different write permissions after the network exhausts its sessions.
    if (readOnly && result.headers.has('etag')) response.headers.set('etag', `"${await digest(`${result.headers.get('etag')}:read-only`)}"`);
  }
  if (publicViewer) response = await publicResponse(response, url.pathname, env);
  response = await browserUrls(response, request, `${url.origin}${repositoryPath ?? (live ? '' : '/example/relay')}`);
  if (!identity && !publicViewer && !validId && !sharedExample) response.headers.append('set-cookie', cookie('braid-demo', demoToken, request));
  return response;
}

/** Accounts, owners and organizations: the API paths that name no repository. Every other path is undefined here. */
async function accountRoute(request: Request, env: BraidEnv, url: URL, user: AccountIdentity | null, agentScope: AgentScope | undefined, anonymousBudget: () => Promise<void>, agentWorkspace: string | undefined, network: string): Promise<Response | undefined> {
  const directory = directoryOf(env), security = securityOf(env);
  const call = async <A extends keyof DirectoryInput>(action: A, input: DirectoryInput[A]) => {
    if (!user) throw new HttpError(401, 'Sign in to open your organizations and repositories.');
    return JSON.parse(unwrap(await directory.dispatch(user, action, input))) as unknown;
  };
  if (url.pathname === '/api/repos' && ['GET', 'HEAD'].includes(request.method)) {
    const { limit, cursor, q, sort } = parse(repositoryListQuery, Object.fromEntries(url.searchParams));
    await anonymousBudget();
    const listing = await directory.publicRepositories(limit, cursor, { q, sort });
    return Response.json(publicMetadata(listing));
  }
  const avatarAddress = url.pathname.match(/^\/api\/owners\/([^/]+)\/avatar$/);
  if (avatarAddress && ['GET', 'HEAD'].includes(request.method)) {
    await anonymousBudget();
    const parsed = v.safeParse(repositoryAddress.entries.owner, avatarAddress[1]);
    if (!parsed.success) throw new HttpError(404, 'Avatar not found.');
    const id = await directory.avatar(parsed.output);
    if (id === null) throw new HttpError(404, 'Avatar not found.');
    const avatar = await fetch(`https://avatars.githubusercontent.com/u/${id}?s=192`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    const type = avatar.headers.get('content-type')?.split(';')[0];
    if (!avatar.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type ?? '')) {
      await avatar.body?.cancel();
      throw new HttpError(502, 'Avatar unavailable.');
    }
    return new Response(avatar.body, { headers: { 'content-type': type!, 'cache-control': 'public, max-age=3600' } });
  }
  const claim = url.pathname.match(/^\/api\/owners\/([^/]+)\/claim$/);
  if (claim) {
    await anonymousBudget();
    const slug = parse(repositoryAddress.entries.owner, claim[1]);
    if (agentScope) throw new HttpError(403, 'Claim a GitHub owner in Braid.');
    if (request.method === 'GET') {
      const proof = await directory.claimStatus(user, slug);
      return Response.json({ claimable: proof.claimable, ...(proof.kind ? { kind: proof.kind } : {}), ...(proof.link ? { link: true } : {}), ...(proof.owned ? { owned: true } : {}), ...(proof.reason ? { reason: proof.reason } : {}) });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!user) throw new HttpError(401, 'Sign in and connect GitHub to claim this owner.');
    const result = await directory.claimMirrorOwner(user, slug);
    if (!result.ok) unwrap(result);
    return Response.json(result);
  }
  const ownerAddress = url.pathname.match(/^\/api\/owners\/([^/]+)$/);
  if (ownerAddress && ['GET', 'HEAD'].includes(request.method)) {
    await anonymousBudget();
    const parsed = v.safeParse(repositoryAddress.entries.owner, ownerAddress[1]);
    if (!parsed.success) throw new HttpError(404, 'Owner not found.');
    return Response.json(publicMetadata(unwrap(await directory.mirrorOwnerRepositories(user, parsed.output))));
  }
  const address = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/);
  if (address && ['GET', 'HEAD'].includes(request.method)) {
    const parsed = v.safeParse(repositoryAddress, { owner: address[1], repo: address[2] });
    if (!parsed.success) throw new HttpError(404, 'Repository not found.');
    if (!user || !await directory.addressMember(user.id, parsed.output.owner, parsed.output.repo)) await anonymousBudget();
    let result: Awaited<ReturnType<Directory['resolveMirror']>> = await directory.resolveRepository(user?.id ?? null, parsed.output.owner, parsed.output.repo);
    // The operator's seeding key, at least 32 characters, skips the visitor admission budget.
    const seeded = (env.MIRROR_SEED_TOKEN?.length ?? 0) >= 32 && await equalSecret(request.headers.get('x-braid-mirror-seed') ?? '', env.MIRROR_SEED_TOKEN!);
    if (!agentScope && (!result.ok || result.data.mirror)) result = await directory.resolveMirror(user, parsed.output.owner, parsed.output.repo, network, { seeded });
    const found = unwrap(result);
    if (agentWorkspace && found.workspaceId !== agentWorkspace) throw new HttpError(404, 'Repository not found.');
    return Response.json(publicMetadata({ ...found, canWrite: found.canWrite && agentScope !== 'read' }));
  }
  if (url.pathname === '/api/account' && request.method === 'GET') {
    if (user && !agentScope) await directory.syncGitHubMemberships(user);
    // The organization list settles first: it can migrate the visibility the personal owner reports.
    const [organizations, github] = user ? await Promise.all([call('list', {}) as Promise<Account['organizations']>, security.githubIdentity(user.id)]) : [[], null];
    const personal = user ? await directory.accountView(user, github) : { user: null, personalOwner: null, usernameSuggestion: null };
    // Keep the legacy key for open tabs during this release, including their personal repositories.
    return Response.json({ ...personal, organizations, teams: [...(personal.personalOwner ? [personal.personalOwner] : []), ...organizations], provider: env.AUTH_MODE as Account['provider'], signupEnabled: env.SIGNUP_ENABLED === 'true', methods: { github: !!env.GITHUB_CLIENT_ID, email: !!env.EMAIL && !!env.EMAIL_FROM, passkeys: !!env.PUBLIC_ORIGIN } } satisfies Account & { teams: Account['organizations'] });
  }
  if (url.pathname === '/api/account/username' && request.method === 'PATCH') {
    if (agentScope) throw new HttpError(403, 'Choose your username in Braid.');
    return Response.json(await call('username', parse(accountUsername, await jsonBody(request))));
  }
  if (['/api/orgs', '/api/teams'].includes(url.pathname) && request.method === 'POST') {
    if (env.SIGNUP_ENABLED !== 'true') throw new HttpError(403, 'New organizations are currently closed. You can still accept an organization invitation.');
    return Response.json(await call('createOrganization', parse(url.pathname === '/api/teams' ? teamName : organizationName, await jsonBody(request))), { status: 201 });
  }
  if (url.pathname === '/api/invites/accept' && request.method === 'POST') return Response.json(await call('accept', parse(inviteToken, await jsonBody(request))));
  if (url.pathname === '/api/orgs' && request.method === 'GET') return Response.json(await call('list', {}));
  const orgTeams = url.pathname.match(/^\/api\/orgs\/([^/]+)\/teams(?:\/([^/]+))?(?:\/(members|repositories)\/([^/]+))?$/);
  if (orgTeams) {
    const orgId = parse(workspaceSelection, orgTeams[1]);
    if (!orgTeams[2]) {
      if (request.method === 'GET') return Response.json(await call('teams', { orgId }));
      if (request.method === 'POST') return Response.json(await call('createOrgTeam', { orgId, ...parse(orgTeamCreate, await jsonBody(request)) }), { status: 201 });
    } else {
      const input = { orgId, teamId: parse(workspaceSelection, orgTeams[2]) };
      if (!orgTeams[3]) {
        if (request.method === 'GET') return Response.json(await call('team', input));
        if (request.method === 'PATCH') return Response.json(await call('updateOrgTeam', { ...input, ...parse(orgTeamUpdate, await jsonBody(request)) }));
        if (request.method === 'DELETE') return Response.json(await call('deleteOrgTeam', input));
      } else if (orgTeams[3] === 'members') {
        const memberId = parse(organizationPersonId, orgTeams[4]);
        if (request.method === 'PUT' || request.method === 'PATCH') return Response.json(await call('setTeamMember', { ...input, memberId, ...parse(orgTeamMember, await jsonBody(request)) }));
        if (request.method === 'DELETE') return Response.json(await call('removeTeamMember', { ...input, memberId }));
      } else {
        const workspaceId = parse(workspaceSelection, orgTeams[4]);
        if (request.method === 'PUT' || request.method === 'PATCH') return Response.json(await call('setTeamRepository', { ...input, workspaceId, ...parse(orgTeamRepository, await jsonBody(request)) }));
        if (request.method === 'DELETE') return Response.json(await call('removeTeamRepository', { ...input, workspaceId }));
      }
    }
    throw new HttpError(405, 'This method is not supported.');
  }
  const repositoryAccess = url.pathname.match(/^\/api\/(?:orgs|owners)\/([^/]+)\/workspaces\/([^/]+)\/access$/);
  if (repositoryAccess && request.method === 'GET') return Response.json(await call('repositoryAccess', { orgId: parse(workspaceSelection, repositoryAccess[1]), workspaceId: parse(workspaceSelection, repositoryAccess[2]) }));
  const teamAddress = url.pathname.match(/^\/api\/(?:orgs|teams)\/([^/]+)$/);
  if (teamAddress && request.method === 'PATCH') return Response.json(await call('updateTeam', { ...parse(teamUpdate, await jsonBody(request)), teamId: parse(workspaceSelection, teamAddress[1]) }));
  const team = url.pathname.match(/^\/api\/(?:orgs|teams|owners)\/([^/]+)\/(workspaces|members|invites|audit)(?:\/([^/]+))?$/);
  if (team) {
    const input = { teamId: parse(workspaceSelection, team[1]) };
    if (team[2] === 'workspaces' && request.method === 'POST' && !team[3]) return Response.json(await call('createWorkspace', { ...parse(repositoryLabel, await jsonBody(request)), ...input }), { status: 201 });
    if (team[2] === 'workspaces' && request.method === 'PATCH' && team[3]) return Response.json(await call('updateWorkspace', { ...parse(repositoryUpdate, await jsonBody(request)), ...input, workspaceId: parse(workspaceSelection, team[3]) }));
    if (team[2] === 'members' && request.method === 'GET' && !team[3]) return Response.json(await call('members', input));
    if (team[2] === 'invites' && request.method === 'POST' && !team[3]) return Response.json(await call('invite', { ...parse(invite, await jsonBody(request)), ...input }), { status: 201 });
    if (team[2] === 'invites' && request.method === 'POST' && team[3]) return Response.json(await call('replaceInvite', { ...input, inviteId: parse(workspaceSelection, team[3]) }));
    if (team[2] === 'members' && request.method === 'PATCH' && team[3]) return Response.json(await call('updateMember', { ...input, memberId: parse(organizationPersonId, team[3]), ...parse(organizationMember, await jsonBody(request)) }));
    if (team[2] === 'invites' && request.method === 'DELETE' && team[3]) return Response.json(await call('revokeInvite', { ...input, inviteId: parse(workspaceSelection, team[3]) }));
    if (team[2] === 'members' && request.method === 'DELETE' && team[3]) return Response.json(await call('removeMember', { ...input, memberId: parse(organizationPersonId, team[3]) }));
    if (team[2] === 'audit' && request.method === 'GET' && !team[3]) return Response.json(await call('audit', { ...input, before: parse(auditCursor, url.searchParams.get('before')) }));
    throw new HttpError(404, 'Account endpoint not found.');
  }
}
