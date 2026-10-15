import { digest, jsonBody, shortCode } from './auth';
import { ACCESS_PREFIX, verifyAccess, type AccessClaims } from './agent-token';
import { HttpError, unwrap } from '../errors';
import { agentApproval, agentRequest, deviceToken, parse } from '../schemas';
import { directoryOf, publicOrigin, securityOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import type { AgentGrant } from '../accounts/security';
import type { AgentScope } from '../../shared/types';

export const CONNECTION_PREFIX = 'braid_agent_';
/** The agent a token names. An access token outlives a revocation of its connection, so callers recheck that. */
type AgentCredential = { user: AccountIdentity; workspace: string } & ({ access: AccessClaims; grant?: undefined } | { grant: AgentGrant; digest: string; access?: undefined });
export async function agentCredential(env: BraidEnv, token: string): Promise<AgentCredential | null> {
  if (token.startsWith(ACCESS_PREFIX)) { const access = await verifyAccess(env, token); return access && { access, user: access.user, workspace: access.workspace }; }
  if (!token.startsWith(CONNECTION_PREFIX)) return null;
  const hash = await digest(token), grant = await securityOf(env).agent(hash);
  return grant && { grant, digest: hash, user: grant.user, workspace: grant.workspaceId };
}

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
export async function agentAuthorization(request: Request, env: BraidEnv, ip: string, user: AccountIdentity | null): Promise<Response> {
  const path = new URL(request.url).pathname;
  const security = securityOf(env);
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
    const token = `${CONNECTION_PREFIX}${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
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
  const grant: AgentGrant = { id: crypto.randomUUID(), user, workspaceId, scope, label: pending.label, expires: Date.now() + (scope === 'work' || scope === 'fleet' ? 7 * 86_400_000 : 3_600_000) };
  if (!await security.approveDevice(match[1], grant)) throw new HttpError(409, 'This agent request changed. Return to the agent and request a new approval link.');
  return Response.json({ ok: true });
}
