import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import { Trunk } from '../changes/trunk';
import { digest, sessionToken } from '../http/auth';
import { concat, FLUSH, pktLine } from '../git/transport';
import { storageFixture } from './storage';
import { startGitServer } from './git-server';
import { fakeGitHub } from './fake-github';
import { edgeCache } from './edge-cache';
import type { BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';

export const mirrorAlice = { id: 'github:101', email: 'alice@example.test', name: 'Alice' };
export const mirrorBob = { id: 'github:202', email: 'bob@example.test', name: 'Bob' };
/** Real Git + existing GitHub fake, real Directory/Workspace/Security, and deliberately strict Artifacts RPC methods. */
export async function mirrorFixture() {
  edgeCache();
  const source = await startGitServer(), target = await startGitServer();
  const first = source.commitTree({ 'README.md': '# Mirror\n' }, undefined, 'First commit');
  const head = source.commitTree({ 'README.md': '# Mirror\nHello\n' }, first, 'Second commit');
  source.native(['update-ref', 'refs/heads/main', head]);
  const github = fakeGitHub({ root: source.root, gitOrigin: new URL(source.remote).origin, fullName: 'alice/repo' });
  github.git(['fetch', `file://${join(source.root, 'repo.git')}`, 'main:refs/heads/main']);
  // As GitHub does: filtered packs, and any reachable tree or file by hash, for copies in parts.
  github.git(['config', 'uploadpack.allowFilter', 'true']); github.git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const baseFetch = globalThis.fetch;
  const state = { private: false, readable: new Set([mirrorAlice.id]), size: 8, orgRole: 'admin', orgState: 'active', missing: false, restLimited: false, refusePushes: false };
  const profiles = new Map([[mirrorAlice.id, { id: 101, login: 'alice', type: 'User' }], [mirrorBob.id, { id: 202, login: 'bob', type: 'User' }]]);
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers), auth = headers.get('authorization');
    if (url.origin === 'https://github.com') {
      const person = auth?.startsWith('Basic ') ? atob(auth.slice(6)).replace('x-access-token:own-', '') : '';
      if (state.missing || state.private && !state.readable.has(person)) return new Response('', { status: 401 });
      // Several names may point to this isolated fixture; the production URL remains observable above.
      return baseFetch(`https://github.com/alice/repo.git/${url.pathname.split('.git/')[1]}${url.search}`, { ...init, ...(init?.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
    }
    if (url.origin === 'https://api.github.com') {
      if (state.restLimited) return Response.json({ message: 'API rate limit exceeded' }, { status: 403 });
      const person = auth?.replace('Bearer own-', '') ?? '';
      if (url.pathname === '/user') return Response.json(profiles.get(person));
      if (url.pathname.startsWith('/user/memberships/orgs/')) return Response.json({ role: state.orgRole, state: state.orgState, organization: { id: 303, login: url.pathname.split('/').at(-1) } });
      if (url.pathname.startsWith('/users/')) { const login = url.pathname.slice(7); return Response.json([...profiles.values()].find(profile => profile.login === login) ?? { id: 303, login, type: 'Organization' }); }
      if (url.pathname.startsWith('/repos/') || url.pathname.startsWith('/repositories/')) {
        if (state.missing || !state.readable.has(person)) return Response.json({ message: 'Not Found' }, { status: 404 });
        return Response.json({ id: 99, full_name: url.pathname.startsWith('/repos/') ? url.pathname.slice(7) : 'alice/repo', default_branch: 'main', size: state.size, private: state.private, owner: profiles.get(mirrorAlice.id) });
      }
      throw new Error(`No App authority is available in mirror tests: ${url.pathname}`);
    }
    // Artifacts answers 413 to a push larger than it takes.
    if (state.refusePushes && url.href.startsWith(target.remote) && url.pathname.endsWith('/git-receive-pack')) return new Response('', { status: 413 });
    return baseFetch(input, init);
  });
  vi.stubGlobal('fetch', network);
  const directoryDb = storageFixture(), securityDb = storageFixture(), workspaces = new Map<string, { db: ReturnType<typeof storageFixture>; workspace: Workspace }>(), trunks = new Map<string, { db: ReturnType<typeof storageFixture>; trunk: Trunk }>();
  let completeImport!: () => void;
  const gate = new Promise<void>(resolve => { completeImport = resolve; });
  let imported = false, current = '';
  const rpc = <Args extends unknown[], Result>(fn: (...args: Args) => Result) => Object.assign(fn, { bind() { throw new Error('Artifacts RPC methods cannot be bound.'); } });
  const repo = {
    info: rpc(async () => ({ remote: target.remote })),
    log: rpc(async (options: { ref?: string; limit?: number; offset?: number } = {}) => {
      if (options.ref?.startsWith('refs/')) throw new Error('Artifacts does not accept refs/... names.');
      // Imported default branches sometimes cannot be read by name until their history arrives.
      return options.ref === 'main' ? [] : target.repository.log(options);
    }),
    readCommit: rpc((hash: string) => target.repository.readCommit(hash)), readTree: rpc((hash: string) => target.repository.readTree(hash)), readBlob: rpc((hash: string) => target.repository.readBlob(hash)),
    createToken: rpc(async () => ({ plaintext: 'artifacts-fixture-token' })), revokeToken: rpc(async () => {}), [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
  const artifacts = {
    import: vi.fn(async (options: { source: { url: string; branch: string; depth: number }; target: { name: string } }) => {
      await gate;
      // Exercise Braid's actual bridge before the fake materializes the shallow copy.
      const refs = await api.fetch(new Request(`${options.source.url}/info/refs?service=git-upload-pack`), env);
      if (!refs.ok) throw new Error(await refs.text()); await refs.arrayBuffer();
      const body = concat([pktLine(`want ${head}\n`), pktLine('deepen 1\n'), FLUSH, pktLine('done\n')]);
      const pack = await api.fetch(new Request(`${options.source.url}/git-upload-pack`, { method: 'POST', headers: { 'content-type': 'application/x-git-upload-pack-request' }, body }), env);
      if (!pack.ok) throw new Error(await pack.text()); await pack.arrayBuffer();
      rmSync(join(target.root, 'repo.git'), { force: true, recursive: true });
      execFileSync('git', ['clone', '--quiet', '--bare', '--depth', String(options.source.depth), '--branch', options.source.branch, `file://${github.path}`, join(target.root, 'repo.git')]);
      // Artifacts takes the shallow pushes that copy history beneath the imported tip.
      target.native(['config', 'http.receivepack', 'true']); target.native(['config', 'receive.shallowUpdate', 'true']); imported = true; current = options.target.name;
      return { name: options.target.name, remote: target.remote, defaultBranch: 'main', token: 'initial-fixture-token' };
    }),
    create: vi.fn(async (name: string, opts?: { setDefaultBranch?: string }) => {
      const branch = opts?.setDefaultBranch ?? 'main';
      rmSync(join(target.root, 'repo.git'), { force: true, recursive: true });
      execFileSync('git', ['init', '--quiet', '--bare', `--initial-branch=${branch}`, join(target.root, 'repo.git')]);
      target.native(['config', 'http.receivepack', 'true']); target.native(['config', 'receive.shallowUpdate', 'true']); target.native(['config', 'gc.auto', '0']);
      imported = true; current = name;
      return { id: name, name, description: null, defaultBranch: branch, remote: target.remote, token: 'initial-fixture-token' };
    }),
    get: vi.fn(async () => { if (!imported) throw Object.assign(new Error('Import pending'), { code: 'NOT_FOUND' }); return repo; }),
    // One Git server stands in for every repository name; a name no longer imported is gone already.
    delete: vi.fn(async (name: string) => {
      if (name !== current) return true;
      imported = false; rmSync(join(target.root, 'repo.git'), { force: true, recursive: true }); return true;
    }),
  };
  const env = { ...github.env, AUTH_MODE: 'github', LIVE_ENABLED: 'true', SIGNUP_ENABLED: 'true', PUBLIC_ORIGIN: 'https://braid.example',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory }, SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: (name: string) => getWorkspace(name).workspace, getByName: (name: string) => getWorkspace(name).workspace },
    TRUNKS: { getByName: (name: string) => getTrunk(name) },
    ARTIFACTS: artifacts, ASSETS: { fetch: async () => new Response('<html><head><title>Braid</title></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) }, PUBLIC_EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as BraidEnv;
  const directory = new Directory(directoryDb.ctx, env), security = new Security(securityDb.ctx, env);
  vi.spyOn(security, 'githubIdentity').mockImplementation(id => profiles.get(id) ?? null);
  vi.spyOn(security, 'githubConnection').mockImplementation(async id => profiles.has(id) ? { login: profiles.get(id)!.login, connectedAt: '' } : null);
  vi.spyOn(security, 'githubAccessToken').mockImplementation(async id => ({ ok: true, token: `own-${id}` }));
  function getTrunk(name: string) {
    let found = trunks.get(name);
    if (!found) { const db = storageFixture(); found = { db, trunk: new Trunk(db.ctx, env) }; trunks.set(name, found); }
    return found.trunk;
  }
  function getWorkspace(key: string) {
    let found = workspaces.get(key);
    if (!found) { const db = storageFixture(); found = { db, workspace: new Workspace(db.ctx, env) }; workspaces.set(key, found); }
    return found;
  }
  const request = async (path: string, user?: AccountIdentity, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    if (user) { const token = await sessionToken(env.SESSION_SECRET); await security.issue(await digest(token), Date.now() + 600_000, user); headers.cookie = `__Host-braid-session=${token}`; }
    return api.fetch(new Request(`https://braid.example${path}`, { ...init, headers: { 'cf-connecting-ip': '198.51.100.2', ...headers } }), env);
  };
  const drain = async () => { for (let n = 0; n < 3; n++) { await directoryDb.settled(); for (const { db } of [...workspaces.values(), ...trunks.values()]) { await db.ready(); await db.settled(); } } };
  const close = async () => { completeImport(); await drain(); for (const { db } of [...workspaces.values(), ...trunks.values()]) db.db.close(); directoryDb.db.close(); securityDb.db.close(); await source.close(); await target.close(); };
  return { env, directory, directoryDb, security, state, profiles, github, network, artifacts, source, target, head, first, repo, request, getWorkspace, workspaces, completeImport, drain, close };
}
