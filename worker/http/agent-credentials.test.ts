import { afterEach, expect, it, vi } from 'vitest';
import api from './api';
import { digest } from './auth';
import { ACCESS_LIFETIME, mintAccess } from './agent-token';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import type { ChangeGateway } from '../changes/router';
import type { BraidEnv } from '../env';

const remote = vi.hoisted(() => ({ calls: [] as { path: string; gateway: ChangeGateway }[] }));
vi.mock('../git/remote', async original => ({ ...await original<typeof import('../git/remote')>(),
  gitRemote: async (request: Request, _env: BraidEnv, gateway: ChangeGateway) => { remote.calls.push({ path: new URL(request.url).pathname, gateway }); return new Response('advertised'); } }));

const alice = { id: 'alice', email: 'alice@example.test', name: 'Alice' };
const stores: ReturnType<typeof storageFixture>[] = [];
afterEach(async () => { for (const db of stores.splice(0)) { await db.settled(); db.db.close(); } remote.calls.length = 0; });

async function fixture() {
  const env = { AUTH_MODE: 'github', LIVE_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'git-credentials-session-secret-of-32-characters' } as unknown as BraidEnv;
  const [people, secrets] = [storageFixture(), storageFixture()]; stores.push(people, secrets);
  const directory = new Directory(people.ctx, env), security = new Security(secrets.ctx, env);
  Object.assign(env, { DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } });
  const org = directory.createOrganization(alice, 'Acme');
  const [repo, other] = ['Private', 'Other'].map(name => directory.createWorkspace(alice.id, org.id, name, 'private'));
  const connect = async (workspaceId: string) => {
    const token = `braid_agent_${crypto.randomUUID().replaceAll('-', '')}`;
    await security.issueAgent(await digest(token), { id: crypto.randomUUID(), user: alice, workspaceId, scope: 'work', label: 'Agent', expires: Date.now() + 86_400_000 });
    return token;
  };
  const access = (workspace: string) => mintAccess(env, { grant: 'grant', user: alice, workspace, team: org.id, scope: 'work', agent: 'agent', name: 'Agent', exp: Date.now() + ACCESS_LIFETIME });
  const clone = (path: string, authorization?: string) => api.fetch(new Request(`https://braid.example${path}/info/refs?service=git-upload-pack`, authorization ? { headers: { authorization } } : {}), env);
  return { env, security, repo, other, connect, access, clone, address: `/${org.slug}/${repo.slug}.git`, path: `/git/${repo.id}.git` };
}
const basic = (token: string, scheme = 'Basic') => `${scheme} ${btoa(`x:${token}`)}`;

it('resolves a private clone address for the agent whose connection or access token names that repository', async () => {
  const f = await fixture();
  for (const token of [await f.connect(f.repo.id), await f.access(f.repo.id)]) {
    const answer = await f.clone(f.address, basic(token));
    expect(answer.status, token.slice(0, 12)).toBe(200);
    expect(remote.calls.at(-1)).toMatchObject({ path: `${f.path}/info/refs`, gateway: { authorization: { user: { id: alice.id }, workspaceId: f.repo.id } } });
  }
  for (const token of [await f.connect(f.other.id), await f.access(f.other.id), 'braid_agent_unknown', 'not-a-braid-token']) expect((await f.clone(f.address, basic(token))).status).toBe(404);
  expect((await f.clone(f.address)).status).toBe(404);
  expect(remote.calls).toHaveLength(2);
});

it('reads Basic credentials alike on the clone address and the repository path', async () => {
  const f = await fixture(), token = await f.connect(f.repo.id);
  expect((await f.clone(f.path, basic(token))).status).toBe(200);
  expect((await f.clone(f.address, basic(token, 'basic'))).status).toBe(404);
  const asked = await f.clone(f.path, basic(token, 'basic'));
  expect(asked.status).toBe(401);
  expect(asked.headers.get('www-authenticate')).toBe('Basic realm="Braid"');
  expect((await f.clone(f.path, 'Basic not*base64')).status).toBe(401);
});

it('tells an agent which credential failed: an access token to renew, or a connection to replace', async () => {
  const f = await fixture(), revoked = await f.access(f.repo.id);
  await f.security.revokeLeakedToken(revoked);
  const read = async (authorization: string) => {
    const answer = await api.fetch(new Request('https://braid.example/api/queue', { headers: { authorization, 'x-braid-workspace': f.repo.id } }), f.env);
    return [answer.status, (await answer.json() as { error: string }).error];
  };
  const renew = 'The access token is invalid or expired. Exchange the agent connection for a new one at /api/agent/session.';
  const replace = 'The agent connection is invalid, expired, or revoked.';
  expect(await read(`Bearer ${revoked}`)).toEqual([401, renew]);
  expect(await read('Bearer braid_at_forged.signature')).toEqual([401, renew]);
  for (const authorization of ['Bearer braid_agent_unknown', 'Bearer ghp_not-braid', basic(await f.connect(f.repo.id))]) expect(await read(authorization)).toEqual([401, replace]);
});
