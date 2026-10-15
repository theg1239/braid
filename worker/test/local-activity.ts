import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { mintAccess } from '../http/agent-token';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Trunk } from '../changes/trunk';
import type { AgentScope } from '../../shared/types';
import type { BraidEnv } from '../env';
import { storageFixture } from './storage';
import { organizationWithRepository } from './organization';

/** Local-only authenticated API with real gateway, SQL store and grants; no Artifacts or live writes. */
export async function localActivityFixture() {
  const stores: ReturnType<typeof storageFixture>[] = [];
  const storage = () => { const found = storageFixture(); stores.push(found); return found.ctx; };
  const directory = new Directory(storage(), {} as BraidEnv), securityState = storage(), security = new Security(securityState, {} as BraidEnv);
  const user = { id: 'local-owner', email: 'local@example.test', name: 'Local owner', username: 'local-owner' };
  const org = organizationWithRepository(directory, user, 'Local activity', 'public'), workspace = org.workspaces[0].id;
  directory.setUsername(user, 'local-owner');
  const trunks = new Map<string, Trunk>();
  const token = 'braid_agent_local_activity_fixture';
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', SESSION_SECRET: 'local-activity-test-secret-at-least-32-characters',
    DIRECTORY: { idFromName: (id: string) => id, get: () => directory }, SECURITY: { idFromName: (id: string) => id, get: () => security },
    WORKSPACES: { idFromName: (id: string) => id, get: () => ({ fetch: async () => Response.json({}) }) },
    CHANGES: { getByName: () => ({ get: async () => ({ ok: true, data: { id: 'ch_0123456789abc', number: 7, author: { kind: 'agent', id: 'agent:local-connection', name: 'Claude', owner: { id: 'user:local-owner', name: '@local-owner' } } } }) }) },
    TRUNKS: { getByName: (id: string) => { if (!trunks.has(id)) trunks.set(id, new Trunk(storage(), env)); return trunks.get(id)!; } },
  } as unknown as BraidEnv;
  const issue = async (scope: AgentScope = 'work', id = 'local-connection', expires = Date.now() + 86_400_000) => {
    securityState.storage.sql.exec('DELETE FROM agent_grants');
    await security.issueAgent(await digest(token), { id, user, workspaceId: workspace, scope, label: 'Claude Code', expires });
    return mintAccess(env, { grant: id, user, workspace, team: org.id, scope, agent: id, name: 'Claude Code', owner: { name: '@local-owner' }, exp: Date.now() + 60_000 });
  };
  await issue();
  const session = await sessionToken(env.SESSION_SECRET);
  await security.issue(await digest(session), Date.now() + 86_400_000, user);
  const cookie = `__Host-braid-session=${session}`;
  const call = (body?: unknown, options: { token?: string | null; cookie?: string; workspace?: string; query?: string; headers?: Record<string, string> } = {}) => api.fetch(new Request(`https://braid.test/api/local-activity${options.query ?? ''}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-braid-workspace': options.workspace ?? workspace, ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? token}` }), ...(options.cookie ? { cookie: options.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { env, issue, call, cookie, user, workspace, token, security, close: () => stores.forEach(item => item.db.close()) };
}
