import { jsonBody } from '../http/auth';
import { HttpError, unwrap } from '../errors';
import type { BraidEnv } from '../env';
import { personOwner } from '../repositories/provenance';
import { activityChangeId, localActivityBatch, parse } from '../schemas';
import type { ChangeGateway } from './router';
import { changeShardOf, shardOf, trunkOf } from './names';

export async function localActivityRoute(request: Request, env: BraidEnv, gateway: ChangeGateway): Promise<Response> {
  if (gateway.mode !== 'live' && request.method === 'GET') return Response.json({ items: [] });
  if (gateway.mode !== 'live') throw new HttpError(409, 'Local activity requires a live repository.');
  if (gateway.publicViewer || !gateway.person) throw new HttpError(403, 'Sign in with repository access to read local activity.');
  const trunk = trunkOf(env, gateway.repository);
  if (request.method === 'GET') {
    const changeId = new URL(request.url).searchParams.get('changeId');
    return Response.json(await trunk.localActivity(changeId === null ? undefined : parse(activityChangeId, changeId)), { headers: { 'cache-control': 'private, no-store' } });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (!gateway.agent || gateway.agent.scope !== 'work' || gateway.role !== 'owner' || !request.headers.get('x-braid-connection-digest')) throw new HttpError(403, 'Use the repository work connection token to report local activity.');
  const input = parse(localActivityBatch, await jsonBody(request, 32_768));
  const owner = gateway.agent.owner ?? await personOwner(env, gateway.person);
  let changeNumber: number | undefined;
  if (input.changeId) {
    const { author, number } = unwrap(await changeShardOf(env, gateway.repository, shardOf(input.changeId)!).get(input.changeId));
    if (author.id !== `agent:${gateway.agent.id}` && !(owner.publicId && author.owner?.publicId === owner.publicId) && !(owner.id && author.owner?.id === owner.id)) throw new HttpError(403, 'Only the pull request author or their reconnected agent can attach activity.');
    changeNumber = number;
  }
  return Response.json(unwrap(await trunk.recordLocalActivity(gateway.person.id, { name: gateway.agent.label, owner: { name: owner.name, ...(owner.publicId ? { publicId: owner.publicId } : {}), ...(owner.github ? { github: owner.github } : {}) } }, input, changeNumber)), { status: 202 });
}
