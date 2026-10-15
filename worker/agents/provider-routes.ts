import type { AccountIdentity } from '../../shared/account';
import type { ProviderConnection } from '../../shared/providers';
import type { AgentScope } from '../../shared/types';
import { assertOrigin, jsonBody } from '../http/auth';
import { HttpError } from '../errors';
import { securityOf, type BraidEnv } from '../env';
import { parse } from '../schemas';
import { providerId, providerKey, providerModel } from './providers';

const noStore = { 'cache-control': 'no-store' };
/**
 * A person's own model provider keys: `GET /api/providers`, `PUT|PATCH|DELETE /api/providers/:provider` and
 * `POST /api/providers/:provider/check`. Only the signed-in person manages theirs; agent connections never can.
 * Answers describe a connection and never contain its key.
 */
export async function providerRoute(request: Request, env: BraidEnv, user: AccountIdentity | null, agentScope?: AgentScope): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/api\/providers(?:\/([a-z]+)(\/check)?)?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'Provider endpoint not found.');
  if (!user) throw new HttpError(401, 'Sign in to connect a model provider.');
  if (agentScope) throw new HttpError(403, 'Connect model providers in Braid.');
  const security = securityOf(env);
  if (!match[1]) {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return Response.json({ providers: await security.providers(user.id) }, { headers: noStore });
  }
  const provider = parse(providerId, match[1]);
  assertOrigin(request);
  const answer = (connection: ProviderConnection | null) => {
    if (!connection) throw new HttpError(404, 'This provider is not connected.');
    return Response.json(connection, { headers: noStore });
  };
  if (match[2]) {
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    await budget(env, user.id);
    return answer(await security.checkProvider(user.id, provider));
  }
  if (request.method === 'PUT') {
    const { key } = parse(providerKey(provider), await jsonBody(request, 4096));
    await budget(env, user.id);
    const result = await security.connectProvider(user.id, provider, key);
    if (!result.ok) throw new HttpError(result.status, result.error);
    return answer(result.connection);
  }
  if (request.method === 'PATCH') {
    const { model } = parse(providerModel, await jsonBody(request, 4096));
    const result = await security.chooseProviderModel(user.id, provider, model);
    if (!result.ok) throw new HttpError(result.status, result.error);
    return answer(result.connection);
  }
  if (request.method === 'DELETE') {
    await security.disconnectProvider(user.id, provider);
    return new Response(null, { status: 204, headers: noStore });
  }
  throw new HttpError(405, 'Method not allowed.');
}

/** Checking a key calls the provider; thirty an hour is plenty for a person and keeps Braid from probing keys for anyone. */
async function budget(env: BraidEnv, userId: string) {
  const allowed = await securityOf(env).consume(`providers:${userId}`, 30, 3_600_000);
  if (!allowed.allowed) throw new HttpError(429, 'Too many provider checks. Try again later.', allowed.retryAfter);
}
