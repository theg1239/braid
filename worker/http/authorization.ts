import type { AccountIdentity } from '../../shared/account';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import { HttpError } from '../errors';

/** The owner whose access authorizes a Git write, rechecked immediately before the write. */
export type Authorization = { user: AccountIdentity; workspaceId: string; teamId: string; connectionDigest?: string };

/** The owner still has write access, and an agent connection acting for them is still live; returns that connection's grant. */
export async function checkAuthorization(env: BraidEnv, authorization?: Authorization) {
  if (env.LIVE_ENABLED === 'false') throw new HttpError(503, 'Live repository writes are disabled.');
  if (!authorization) {
    if (env.AUTH_MODE !== 'owner-key') throw new HttpError(403, 'This operation has no team owner authorization.');
    return;
  }
  // The connection is looked up alongside the owner check; its answer, or its failure, counts only once the owner check passes.
  const connection = authorization.connectionDigest;
  const lookup = connection ? (async () => securityOf(env).agent(connection))() : undefined;
  lookup?.catch(() => {});
  const result = await directoryOf(env).access(authorization.user, authorization.workspaceId, true);
  if (!result.ok) throw new HttpError(result.status, 'The owner who authorized this operation no longer has repository access.');
  if (result.data.teamId !== authorization.teamId) throw new HttpError(403, 'Repository authorization does not match.');
  if (!lookup) return;
  const grant = await lookup;
  if (!grant || grant.scope === 'read' || (grant.workspaceId !== '*' && grant.workspaceId !== authorization.workspaceId) || grant.user.id !== authorization.user.id)
    throw new HttpError(403, 'The agent connection was revoked or expired. Reconnect before submitting.');
  return grant;
}
