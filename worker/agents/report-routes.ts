import type { AgentReports } from '../../shared/types';
import { directoryOf, type BraidEnv } from '../env';
import { jsonBody } from '../http/auth';
import { HttpError, unwrap } from '../errors';
import { personOwner } from '../repositories/provenance';
import { verifyAccess } from '../http/agent-token';
import type { ChangeGateway } from '../changes/router';
import { trunkOf } from '../changes/names';

/** Repository write grants can belong to members; resolving feedback requires the owner role. */
async function canResolve(env: BraidEnv, gateway: ChangeGateway) {
  if (gateway.agent || gateway.role !== 'owner') return false;
  const authorization = gateway.authorization;
  if (!authorization) return env.AUTH_MODE === 'owner-key';
  const access = await directoryOf(env).access(authorization.user, authorization.workspaceId, false);
  return access.ok && access.data.organizationRole === 'owner';
}

export async function agentReportRoute(request: Request, env: BraidEnv, gateway: ChangeGateway): Promise<Response> {
  if (gateway.mode !== 'live' || gateway.publicViewer || !gateway.person) throw new HttpError(403, 'Sign in with repository access to read agent reports.');
  const path = new URL(request.url).pathname;
  const trunk = trunkOf(env, gateway.repository);
  if (path === '/api/agent-reports') {
    if (request.method === 'GET') {
      const [items, allowed] = await Promise.all([trunk.agentReports(), canResolve(env, gateway)]);
      return Response.json({ items, canResolve: allowed } satisfies AgentReports);
    }
    if (request.method === 'POST') {
      const agent = gateway.agent;
      if (!agent || agent.scope !== 'work' || gateway.role !== 'owner') throw new HttpError(403, 'A repository work connection is required to report a problem.');
      const raw = await jsonBody(request, 32_768);
      // Fleet identities share the approving connection's quota, including after token renewal.
      let connection = agent.id;
      const bearer = request.headers.get('authorization');
      if (bearer?.startsWith('Bearer braid_at_')) {
        const claims = await verifyAccess(env, bearer.slice(7));
        if (!claims) throw new HttpError(401, 'The access token is invalid or expired.');
        connection = claims.grant;
      }
      // Long-lived connections have no embedded owner; resolve their existing identity here.
      const owner = agent.owner ?? await personOwner(env, gateway.person);
      const saved = await trunk.reportProblem({ connection, name: agent.label, model: agent.model, owner }, raw);
      if (!saved.ok) return Response.json({ error: saved.error }, { status: saved.status, headers: saved.retryAfter ? { 'retry-after': String(saved.retryAfter) } : {} });
      return Response.json(saved.data, { status: 201 });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  const match = path.match(/^\/api\/agent-reports\/([^/]+)\/resolve$/);
  if (!match) throw new HttpError(404, 'Report not found.');
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (!await canResolve(env, gateway)) throw new HttpError(403, 'Only repository owners can resolve agent reports.');
  return Response.json({ items: unwrap(await trunk.resolveAgentReport(match[1])), canResolve: true } satisfies AgentReports);
}
