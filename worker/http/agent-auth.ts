import { digest, jsonBody, shortCode } from './auth';
import { ACCESS_PREFIX, verifyAccess, type AccessClaims } from './agent-token';
import { HttpError, unwrap } from '../errors';
import { agentApproval, agentEmailStart, agentEmailVerify, agentGitHubSignup, agentRequest, deviceToken, parse } from '../schemas';
import { directoryOf, publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import type { AgentGrant } from '../accounts/security';
import type { AgentScope } from '../../shared/types';
import { githubApi } from '../github/client';
import { githubProfile } from '../accounts/oauth';
import { repositoryKey } from '../changes/names';
import { emailCodeDigest, sendEmailCode } from '../accounts/email-auth';

export const CONNECTION_PREFIX = 'braid_agent_';
/** The agent a token names. An access token outlives a revocation of its connection, so callers recheck that. */
type AgentCredential = { user: AccountIdentity; workspace: string } & ({ access: AccessClaims; grant?: undefined } | { grant: AgentGrant; digest: string; access?: undefined });
export async function agentCredential(env: BraidEnv, token: string): Promise<AgentCredential | null> {
  if (token.startsWith(ACCESS_PREFIX)) { const access = await verifyAccess(env, token); return access && { access, user: access.user, workspace: access.workspace }; }
  if (!token.startsWith(CONNECTION_PREFIX)) return null;
  const hash = await digest(token), grant = await securityOf(env).agent(hash);
  return grant && { grant, digest: hash, user: grant.user, workspace: grant.workspaceId };
}
/** Work connections last a week; read and setup connections an hour. */
const connectionLifetime = (scope: AgentScope) => scope === 'work' || scope === 'fleet' ? 7 * 86_400_000 : 3_600_000;
const connectionToken = () => `${CONNECTION_PREFIX}${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;

/** Anonymous repository reads are opt-in. New endpoints are private until explicitly added here. */
export const publicPathAllowed = (path: string, method: string) => ['GET', 'HEAD'].includes(method) && (
  path === '/api/repository/search' ||
  ['/api/repository/branches', '/api/repository/compare', '/api/repository/compare/diff'].includes(path) ||
  path === '/api/repository/commits' || path === '/api/repository/tree/commits' ||
  ['/api/repository/commit', '/api/repository/commit/diff'].includes(path) ||
  ['/api/state', '/api/repository/tree', '/api/repository', '/api/changes', '/api/queue', '/api/coordination', '/api/coordination/hot', '/api/policy', '/api/instructions', '/api/blame', '/api/provenance', '/api/agents', '/api/missions', '/api/tasks'].includes(path)
  || /^\/api\/changes\/(?:ch_[a-f0-9]{13}|[1-9]\d{0,12})(?:\/(?:diff|compare|guide|comments)|\/evidence\/[a-f0-9]{64}\.(?:png|jpg|webp))?$/.test(path)
  || /^\/api\/(?:missions|tasks)\/mission-[a-z0-9-]{1,80}(?:\/(?:integration|diff))?$/.test(path)
);
export const agentPathAllowed = (path: string, method: string, scope: AgentScope) => {
  if (method === 'GET' && path === '/api/repository/search') return true;
  if (method === 'GET' && path === '/api/search') return true;
  if (method === 'GET' && (path === '/api/repository/commits' || path === '/api/repository/tree/commits')) return true;
  if (method === 'GET' && ['/api/repository/commit', '/api/repository/commit/diff'].includes(path)) return true;
  if (path === '/api/agent/session' && method === 'POST') return true;
  // Git fetches with any repository access; the remote itself requires work access to push.
  if (/^\/git\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) return scope !== 'fleet' && (method === 'GET' || method === 'POST');
  if (method === 'GET') return ['/api/state', '/api/repository', '/api/repository/tree', '/api/changes', '/api/queue', '/api/coordination', '/api/coordination/hot', '/api/policy', '/api/instructions', '/api/blame', '/api/provenance', '/api/agents'].includes(path)
    || ['/api/repository/branches', '/api/repository/compare', '/api/repository/compare/diff'].includes(path)
    || /^\/api\/missions\/[^/]+\/(integration|diff)$/.test(path) || /^\/api\/changes\/[^/]+(\/diff|\/guide|\/comments|\/evidence\/[^/]+)?$/.test(path);
  // Work connections submit and revise their own changes, review others' and reply to review comments; approval, resolving comments and landing settings stay with people.
  if (scope === 'work') return method === 'POST' && (/^\/api\/missions\/[^/]+\/agents\/[^/]+\/(checkout|submit|progress|update)$/.test(path)
    || path === '/api/local-activity' || path === '/api/agent-reports' || path === '/api/changes' || path === '/api/changes/checkout' || /^\/api\/changes\/[^/]+\/(revisions|restack|reviews|close|comments)$/.test(path));
  // A fleet connection itself only mints per-agent access tokens; the agents act with those.
  if (scope === 'fleet') return false;
  // Setup grants cannot change memberships, resolve human decisions, or merge into main.
  return scope === 'setup' && method === 'POST' && ['/api/project', '/api/project/import/retry', '/api/missions', '/api/context'].includes(path);
};

type SelfConnection = { name: string; scope: Exclude<AgentScope, 'fleet'>; repository?: { owner: string; repo: string }; workspaceId?: string; checkout?: { name: string; github?: { owner: string; repo: string } } };
/**
 * A connection for an agent that proved it acts for the person, with their GitHub token or the code from their email.
 * The proof stands in for the approval click, so the connection is what an approval gives: the asked access to one
 * repository the person can write, with every later request checked as an approved connection's is.
 */
async function selfConnection(env: BraidEnv, user: AccountIdentity, wanted: SelfConnection): Promise<Response> {
  const directory = directoryOf(env);
  let workspaceId = wanted.workspaceId;
  let created = false;
  if (!workspaceId && wanted.repository) {
    const resolved = await directory.resolveRepository(user.id, wanted.repository.owner, wanted.repository.repo);
    if (resolved.ok) workspaceId = resolved.data.workspaceId;
    else if (resolved.status !== 404 || wanted.repository.owner !== user.username || !wanted.checkout) unwrap(resolved);
  }
  if (!workspaceId && wanted.checkout && wanted.scope !== 'read') {
    // An explicit origin can reuse a writable Braid repository, but never adopts a read-only mirror.
    if (!wanted.repository && wanted.checkout.github) {
      const match = await directory.resolveRepository(user.id, wanted.checkout.github.owner, wanted.checkout.github.repo);
      if (match.ok && match.data.canWrite) workspaceId = match.data.workspaceId;
    }
    if (!workspaceId) {
      const provisioned = await directory.ensureAgentRepository(user, wanted.repository?.repo ?? wanted.checkout.name);
      workspaceId = provisioned.workspaceId; created = provisioned.created; user = provisioned.user;
    }
  }
  const account = { username: user.username ?? null };
  if (!workspaceId) {
    const writable = await directory.writableRepositories(user);
    if (writable.length !== 1) return Response.json({ code: 'repository_required', error: 'Run connect inside the checkout to create a private repository, or name an existing repository with --repository OWNER/REPO.', repositories: writable.map(repository => repository.address), account }, { status: 409 });
    workspaceId = writable[0].workspaceId;
  }
  const allowed = unwrap(await directory.access(user, workspaceId, wanted.scope !== 'read'));
  let initialize = false;
  if (wanted.checkout && wanted.scope !== 'read') {
    const workspace = env.WORKSPACES.getByName(repositoryKey(allowed.teamId, workspaceId));
    const result = await workspace.setupAgentRepository({ user, workspaceId, teamId: allowed.teamId }, wanted.checkout.name, wanted.checkout.github);
    initialize = result.initialize;
  }
  const grant: AgentGrant = { id: crypto.randomUUID(), user, workspaceId, scope: wanted.scope, label: wanted.name, expires: Date.now() + connectionLifetime(wanted.scope) };
  const token = connectionToken();
  await securityOf(env).issueAgent(await digest(token), grant);
  return Response.json({ accessToken: token, tokenType: 'Bearer', expiresAt: new Date(grant.expires).toISOString(), workspaceId, scope: grant.scope,
    repository: `${allowed.ownerSlug}/${allowed.repoSlug}`, account, created, url: `${publicOrigin(env).origin}/${allowed.ownerSlug}/${allowed.repoSlug}`, ...(initialize ? { initialization: { accessToken: await setupToken(env, user, workspaceId, wanted.name), branch: 'main' } } : {}) }, { status: 201 });
}

async function setupToken(env: BraidEnv, user: AccountIdentity, workspaceId: string, label: string) {
  const token = connectionToken();
  await securityOf(env).issueAgent(await digest(token), { id: crypto.randomUUID(), user, workspaceId, scope: 'setup', label, expires: Date.now() + connectionLifetime('setup') });
  return token;
}

/** Who a GitHub token belongs to, by the same rules as signing in with GitHub. The token is read here and never kept. */
async function githubPerson(token: string) {
  const user = await githubApi('/user', token).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 401) throw new HttpError(401, 'GitHub did not accept this token. Run gh auth login, then connect again.', undefined, 'github_token');
    throw error;
  });
  // The immutable /user ID is sufficient. Only explicitly verified addresses may link accounts.
  const emails = await githubApi('/user/emails', token, { allowNotFound: true }).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 403) return null;
    throw error;
  });
  return githubProfile(user, emails ?? [], true);
}

/** Agents that sign the person up, or in, with proof the person gave them, and connect without a browser. */
async function selfSignup(request: Request, env: BraidEnv, ip: string, path: string): Promise<Response> {
  if (env.AUTH_MODE !== 'github') throw new HttpError(404, 'This Braid has no accounts to sign up for. Use the approval link; see /auth.md.');
  publicOrigin(env);
  const security = securityOf(env), directory = directoryOf(env);
  if (path === '/api/agent/github') {
    if (!env.GITHUB_CLIENT_ID) throw new HttpError(404, 'GitHub sign-in is off on this Braid. Connect with an email code or the approval link; see /auth.md.');
    for (const [key, limit, period] of [[`agent-github:${ip}`, 10, 3_600_000], ['agent-github', 2000, 86_400_000]] as const) {
      const budget = await security.consume(key, limit, period);
      if (!budget.allowed) throw new HttpError(429, 'Too many GitHub sign-ins. Wait the Retry-After interval, then try again.', budget.retryAfter);
    }
    const { token, ...wanted } = parse(agentGitHubSignup, await jsonBody(request));
    const { identity: external, github } = await githubPerson(token);
    const profile = await security.profile(external);
    await security.recordGitHubIdentity(profile.id, github, 'sign-in');
    const { user } = await directory.account(profile, github, true);
    return selfConnection(env, user, wanted);
  }
  if (path === '/api/agent/email/start') {
    const { email, scope } = parse(agentEmailStart, await jsonBody(request));
    const { flowId, expires } = await sendEmailCode(env, ip, email, { kind: 'agent', scope });
    return Response.json({ flowId, expiresAt: new Date(expires).toISOString(), scope }, { status: 201 });
  }
  const { flowId, code, ...wanted } = parse(agentEmailVerify, await jsonBody(request));
  const taken = await security.takeAgentEmail(flowId, await emailCodeDigest(env, flowId, code));
  if (!taken) throw new HttpError(401, 'That code is invalid or expired. After five wrong codes, ask for a new one.', undefined, 'email_code');
  // Until a connection follows, the code stays for another try within its ten minutes.
  const keep = () => security.challenge(flowId, taken.value, taken.expires);
  try {
    const profile = await security.profile({ id: `email:${taken.email}`, email: taken.email, name: taken.email.split('@')[0] });
    const { user } = await directory.account(profile);
    const answer = await selfConnection(env, user, { ...wanted, scope: taken.scope });
    if (answer.status === 409) await keep();
    return answer;
  } catch (error) { await keep(); throw error; }
}

export async function agentAuthorization(request: Request, env: BraidEnv, ip: string, user: AccountIdentity | null): Promise<Response> {
  const path = new URL(request.url).pathname;
  const security = securityOf(env);
  if (['/api/agent/github', '/api/agent/email/start', '/api/agent/email/verify'].includes(path) && request.method === 'POST') return selfSignup(request, env, ip, path);
  if (path === '/api/agent/requests' && request.method === 'POST') {
    const budget = await security.consume(`agent-requests:${ip}`, 10, 3_600_000);
    if (!budget.allowed) throw new HttpError(429, 'Too many connection requests. Wait the Retry-After interval before requesting another connection.', budget.retryAfter);
    const { name: label, scope } = parse(agentRequest, await jsonBody(request));
    const deviceCode = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const code = shortCode();
    await security.startDevice(await digest(deviceCode), code, label, scope);
    return Response.json({ deviceCode, userCode: code, verificationUri: `${publicOrigin(env).origin}/?connect=${code}`, expiresIn: 600, interval: 5 }, { status: 201 });
  }
  if (path === '/api/agent/token' && request.method === 'POST') {
    const { deviceCode } = parse(deviceToken, await jsonBody(request));
    const result = await security.takeDevice(await digest(deviceCode));
    if (result.status !== 'approved' || !result.grant) {
      const next = result.status === 'pending' ? 'Wait for the person to approve the connection. Poll again after Retry-After seconds.'
        : result.status === 'slow_down' ? 'Polling too quickly. Wait Retry-After seconds before polling again.'
          : result.status === 'denied' ? 'The person denied this connection. Stop and ask them how to proceed.'
            : 'This request expired or was already exchanged. Use the saved connection, or start again at POST /api/agent/requests; see /auth.md.';
      return Response.json({ status: result.status, next }, { status: result.status === 'pending' ? 202 : result.status === 'slow_down' ? 429 : 410, headers: { 'retry-after': '5' } });
    }
    const grant = JSON.parse(result.grant) as AgentGrant;
    const directory = directoryOf(env);
    const allowed = await directory.access(grant.user, grant.workspaceId, grant.scope !== 'read');
    if (!allowed.ok) throw new HttpError(403, 'The approving owner no longer has repository access. Ask a current repository owner to approve a new connection; see /auth.md.');
    const token = connectionToken();
    await security.issueAgent(await digest(token), grant);
    return Response.json({ accessToken: token, tokenType: 'Bearer', expiresAt: new Date(grant.expires).toISOString(), workspaceId: grant.workspaceId, scope: grant.scope });
  }
  if (!user) throw new HttpError(401, 'The repository owner must sign in and open the approval link to authorize this agent.');
  if (path === '/api/agent/connections' && request.method === 'GET') return Response.json(await security.agents(user.id));
  if (path.startsWith('/api/agent/connections/') && request.method === 'DELETE') {
    await security.revokeAgent(user.id, path.split('/').at(-1)!); return Response.json({ ok: true });
  }
  const match = path.match(/^\/api\/agent\/requests\/([A-Z2-9]{8})$/);
  if (!match) throw new HttpError(404, 'Agent authorization endpoint not found. Start with POST /api/agent/requests; see /auth.md.');
  const pending = await security.device(match[1]);
  if (!pending) throw new HttpError(410, 'This agent request expired or has already been handled. Return to the agent to check its saved connection or request a new approval link.');
  if (request.method === 'GET') return Response.json(pending);
  if (request.method === 'DELETE') { await security.denyDevice(match[1]); return Response.json({ ok: true }); }
  if (request.method !== 'POST') throw new HttpError(405, 'Use POST to approve this agent request.');
  const { workspaceId, scope } = parse(agentApproval, await jsonBody(request));
  if (scope !== 'read' && scope !== pending.scope) throw new HttpError(400, 'Approve the requested permission or reduce it to read-only.');
  unwrap(await directoryOf(env).access(user, workspaceId, true));
  const grant: AgentGrant = { id: crypto.randomUUID(), user, workspaceId, scope, label: pending.label, expires: Date.now() + connectionLifetime(scope) };
  if (!await security.approveDevice(match[1], grant)) throw new HttpError(409, 'This agent request changed. Return to the agent and request a new approval link.');
  return Response.json({ ok: true });
}
