import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { mintAccess } from '../http/agent-token';
import { digest } from '../http/auth';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import { recordingAnswers } from '../test/rpc-answers';
import { FLUSH, pktLine, ZERO } from './transport';
import { listChanges } from '../changes/router';
import type { AgentScope, Change } from '../../shared/types';
import type { BraidEnv } from '../env';
import { braid, environment } from '../../cli/test/helpers';
import { saveCredentials, writeLink } from '../../cli/src/config';

const router = ['export const routes = [', "  '/health',", '];', '', 'export function handle(path: string) {', '  return routes.includes(path);', '}', ''].join('\n');
const maya = { id: 'u-maya', email: 'maya@example.test', name: 'Maya Chen' };
const owner = { id: 'user:u-maya', name: 'Maya Chen', email: '1+maya-chen@users.noreply.github.com', github: 'maya-chen' };
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const step of cleanup.reverse()) await step(); cleanup = []; });

/** Braid's Worker over HTTP, as a Git client reaches it, with the local Git server standing in for Artifacts. */
async function remote() {
  const harness = await changeHarness();
  const base = harness.git.commitTree({ 'src/router.ts': router, 'README.md': '# Relay\n' }, undefined, 'Start Relay');
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  const security = new Security(storageFixture().ctx, {} as BraidEnv);
  const env = Object.assign(harness.env, { AUTH_MODE: 'github', SESSION_SECRET: 's'.repeat(40), LIVE_ENABLED: 'true', PUBLIC_ORIGIN: '',
    SECURITY: { idFromName: (name: string) => name, get: () => security }, ASSETS: { fetch: async () => new Response('asset') },
    WORKSPACES: { getByName: () => harness.workspace, idFromName: (name: string) => name, get: () => harness.workspace },
  }) as BraidEnv;
  const directoryStore = storageFixture();
  directoryStore.storage.sql.exec('CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)');
  directoryStore.storage.sql.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)');
  directoryStore.storage.sql.exec("INSERT INTO teams VALUES ('t', 'Relay team', '2026-01-01T00:00:00.000Z')");
  directoryStore.storage.sql.exec("INSERT INTO workspaces VALUES ('w', 't', 'Relay', '2026-01-01T00:00:00.000Z')");
  const directory = new Directory(directoryStore.ctx, env);
  directoryStore.storage.sql.exec("INSERT INTO members VALUES ('t', ?, 'owner')", maya.id);
  Object.assign(env, { DIRECTORY: { idFromName: () => 'directory', get: () => directory } });
  const server: Server = createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    const body = incoming.method === 'GET' ? undefined : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    const response = await api.fetch(new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method, headers, body, duplex: 'half' } as RequestInit), env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const work = mkdtempSync(join(tmpdir(), 'braid-push-'));
  cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(work, { recursive: true, force: true }); await harness.close(); });
  /** An agent's access token, as the CLI's credential helper would give Git. */
  const token = (scope: AgentScope = 'work') => mintAccess(env, { grant: 'grant-1', user: maya, workspace: 'w', team: 't', scope,
    agent: 'conn-1', name: 'Laptop', model: 'claude-opus-5-5', owner, exp: Date.now() + 300_000 });
  const url = (secret: string) => `${origin.replace('http://', `http://agent:${secret}@`)}/git/w.git`;
  // The machine's own Git settings, such as commit signing, stay out of the test.
  const identity = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@example.test', GIT_COMMITTER_NAME: 'Maya Chen', GIT_COMMITTER_EMAIL: 'maya@example.test' };
  /** Git talking to Braid, without blocking the server it talks to. */
  const git = (args: string[], cwd = join(work, 'client')) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn('git', args, { cwd, env: identity });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  /** Git working on the clone alone. */
  const local = (args: string[]) => spawnSync('git', args, { cwd: join(work, 'client'), encoding: 'utf8', env: identity });
  const commit = (path: string, content: string, message: string) => {
    mkdirSync(join(work, 'client', path, '..'), { recursive: true });
    writeFileSync(join(work, 'client', path), content);
    expect(local(['add', path]).status).toBe(0);
    expect(local(['commit', '-q', '-m', message]).status).toBe(0);
    return local(['rev-parse', 'HEAD']).stdout.trim();
  };
  const changes = async () => (await listChanges(harness.env, harness.repository, { limit: 50 })).items.sort((a, b) => a.number - b.number);
  const change = async (number: number) => { const item = (await changes()).find(entry => entry.number === number)!; const found = await harness.shard(parseInt(item.id[3], 16)).get(item.id); if (!found.ok) throw new Error(found.error); return found.data as Change; };
  /** A long-lived connection Maya approved, as `braid init` keeps it for Git's credential helper. */
  const connection = async (scope: AgentScope = 'work') => {
    const secret = `braid_agent_${crypto.randomUUID().replaceAll('-', '')}`;
    await security.issueAgent(await digest(secret), { id: scope === 'work' ? 'conn-laptop' : `conn-${scope}`, user: maya, workspaceId: 'w', scope, label: 'Laptop', expires: Date.now() + 86_400_000 });
    return secret;
  };
  return { harness, env, directory, base, origin, work, token, connection, url, git, local, commit, changes, change };
}

describe('Braid as a Git remote', () => {
  it('clones and fetches a public repository anonymously while push still requires work access', async () => {
    const { harness, directory, base, origin, work, git, local, commit, token, url } = await remote();
    const activity = vi.spyOn(directory, 'repositoryActivity');
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', visibility: 'public' });
    const cloned = await git(['clone', '-q', `${origin}/git/w.git`, 'client'], work);
    expect(cloned.status, cloned.stderr).toBe(0);
    expect(local(['rev-parse', 'origin/main']).stdout.trim()).toBe(base);
    expect((await git(['fetch', '-q', 'origin'])).status).toBe(0);
    expect((await git(['push', 'origin', 'HEAD:refs/for/main'])).status).not.toBe(0);
    const advertisement = await fetch(`${origin}/git/w.git/info/refs?service=git-receive-pack`);
    expect(advertisement.status).toBe(401);
    expect(advertisement.headers.get('www-authenticate')).toBe('Basic realm="Braid"');
    expect(local(['remote', 'set-url', 'origin', url(await token())]).status).toBe(0);
    commit('docs/public.md', '# Public Git workflow\n', 'Document public cloning');
    const pushed = await git(['push', 'origin', 'HEAD:refs/for/main']);
    expect(pushed.status, pushed.stderr).toBe(0);
    const publications = activity.mock.calls.length;
    await harness.settle();
    expect(activity.mock.calls.length).toBeGreaterThan(publications);
    expect(local(['remote', 'set-url', 'origin', `${origin}/git/w.git`]).status).toBe(0);
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(5001);
    expect((await git(['fetch', '-q', 'origin'])).status).not.toBe(0);
  }, 60_000);
  it('clones a public repository from its address, which private and unknown repositories do not answer to', async () => {
    const { directory, base, origin, work, git, local } = await remote();
    const team = directory.list(maya)[0], address = `${origin}/${team.slug}/${team.workspaces[0].slug}.git`;
    expect((await fetch(`${address}/info/refs?service=git-upload-pack`)).status).toBe(404);
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', visibility: 'public' });
    const cloned = await git(['clone', '-q', address, 'client'], work);
    expect(cloned.status, cloned.stderr).toBe(0);
    expect(local(['rev-parse', 'origin/main']).stdout.trim()).toBe(base);
    expect((await fetch(`${origin}/nobody/nothing.git/info/refs?service=git-upload-pack`)).status).toBe(404);
  }, 60_000);
  it('serves protocol v2, so a shallow clone works, while pushes in progress stay hidden as in v1', async () => {
    const { harness, directory, base, origin, work, git, local } = await remote();
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', visibility: 'public' });
    harness.git.native(['update-ref', 'refs/braid/incoming/in-progress', base]);
    const upstream = vi.spyOn(globalThis, 'fetch');
    const shallow = await git(['-c', 'protocol.version=2', 'clone', '-q', '--depth', '1', `${origin}/git/w.git`, 'client'], work);
    expect(shallow.status, shallow.stderr).toBe(0);
    // Braid asked the repository's host for v2 too, for the listing and for the pack.
    const v2 = upstream.mock.calls.filter(([, init]) => new Headers(init?.headers).get('git-protocol') === 'version=2').map(([input]) => String(input));
    expect(v2.some(url => url.endsWith('/info/refs?service=git-upload-pack'))).toBe(true);
    expect(v2.filter(url => url.endsWith('/git-upload-pack')).length).toBeGreaterThanOrEqual(2);
    upstream.mockRestore();
    expect(local(['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('true');
    expect(local(['rev-parse', 'origin/main']).stdout.trim()).toBe(base);
    for (const version of ['1', '2']) {
      const listed = await git(['-c', `protocol.version=${version}`, 'ls-remote', `${origin}/git/w.git`], work);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain('refs/heads/main');
      expect(listed.stdout).not.toContain('refs/braid');
    }
    const full = await git(['-c', 'protocol.version=1', 'clone', '-q', `${origin}/git/w.git`, 'v1-client'], work);
    expect(full.status, full.stderr).toBe(0);
  }, 60_000);
  it('refuses anonymous clones of private and unknown repositories alike', async () => {
    const { origin, work, git } = await remote();
    expect((await git(['clone', '-q', `${origin}/git/w.git`, 'private-client'], work)).status).not.toBe(0);
    for (const id of ['w', 'unknown']) {
      const response = await fetch(`${origin}/git/${id}.git/info/refs?service=git-upload-pack`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Basic realm="Braid"');
      expect(await response.text()).toBe('Authenticate with your Braid agent token as the password.\n');
    }
  }, 60_000);

  it('clones main, and turns a push to refs/for/main into a change while main stays put', async () => {
    const { harness, directory, base, origin, work, token, url, git, local, commit, change } = await remote();
    const activity = vi.spyOn(directory, 'repositoryActivity');
    const team = directory.list(maya)[0];
    const secret = await token();
    expect((await git(['clone', '-q', url(secret), 'client'], work)).status).toBe(0);
    expect(local(['rev-parse', 'origin/main']).stdout.trim()).toBe(base);
    const tip = commit('src/router.ts', router.replace("  '/health',\n", "  '/health',\n  '/metrics',\n"), 'Add a metrics route\n\nAdds /metrics for load balancers.\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>');
    const pushed = await git(['push', 'origin', 'HEAD:refs/for/main']);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect(activity).toHaveBeenCalledWith('w', expect.any(String));
    expect(pushed.stderr).toContain(`remote: Change #1: ${origin}/${team.slug}/${team.workspaces[0].slug}/pull/1`);
    // Main only moves through the queue, and the hidden incoming ref is gone.
    expect(harness.head()).toBe(base);
    expect(harness.git.native(['for-each-ref', 'refs/braid/incoming'])).toBe('');
    expect(harness.git.native(['for-each-ref', 'refs/braid/revisions'])).not.toBe('');
    const opened = await change(1);
    expect(opened).toMatchObject({ title: 'Add a metrics route', summary: 'Adds /metrics for load balancers.', baseCommit: base, revision: 1,
      author: { kind: 'agent', id: 'agent:conn-1', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner }, files: [{ path: 'src/router.ts', additions: 1, deletions: 0 }] });
    // It lands like any change, keeping the co-author line its commit carried.
    await harness.trunk.configure(harness.repository, { enabled: true, authorization: { user: maya, workspaceId: 'w', teamId: 't' }, actor: 'maya@example.test' });
    await harness.settle();
    const landed = await change(1);
    expect(landed.status).toBe('landed');
    expect(harness.git.native(['log', '-1', '--format=%an%n%B', landed.landedCommit!]).trimEnd()).toBe('Maya Chen\nAdd a metrics route\n\nAdds /metrics for load balancers.\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>');
    expect(landed.landedCommit).not.toBe(tip);
    // A fetch brings the landed main back, with its notes.
    expect((await git(['fetch', '-q', 'origin', 'refs/notes/braid:refs/notes/braid'])).status).toBe(0);
    expect((await git(['fetch', '-q', 'origin'])).status).toBe(0);
    expect(local(['rev-parse', 'origin/main']).stdout.trim()).toBe(harness.head());
    expect(JSON.parse(local(['notes', '--ref=braid', 'show', 'origin/main']).stdout)).toMatchObject({ change: { number: 1 } });
  }, 60_000);

  it('disposes every Artifacts answer while Git clones, pushes, lands and fetches through Braid', async () => {
    const { harness, env, work, token, url, git, commit } = await remote();
    const answers = recordingAnswers(env.ARTIFACTS);
    env.ARTIFACTS = answers.binding;
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('docs/metrics.md', '# Metrics\n', 'Document metrics');
    expect((await git(['push', 'origin', 'HEAD:refs/for/main'])).status).toBe(0);
    await harness.trunk.configure(harness.repository, { enabled: true, authorization: { user: maya, workspaceId: 'w', teamId: 't' }, actor: 'maya@example.test' });
    await harness.settle();
    expect((await git(['fetch', '-q', 'origin'])).status).toBe(0);
    expect(harness.git.native(['show', 'main:docs/metrics.md'])).toBe('# Metrics\n');
    expect(answers.undisposed()).toEqual([]);
  }, 60_000);

  it('uploads 50 MiB in two private Git packs, then opens one pull request with a tiny final push', async () => {
    const { harness, env, directory, base, origin, work, token, url, git, local, changes, change } = await remote();
    const secret = await token();
    expect((await git(['clone', '-q', url(secret), 'client'], work)).status).toBe(0);
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', visibility: 'public' });
    for (const name of ['first', 'second']) {
      writeFileSync(join(work, 'client', `${name}.bin`), randomBytes(25 * 1024 * 1024));
      expect(local(['add', `${name}.bin`]).status).toBe(0);
      expect(local(['commit', '-q', '-m', `Add ${name} asset`]).status).toBe(0);
      const uploaded = await git(['push', 'origin', `HEAD:refs/braid/uploads/${name}`]);
      expect(uploaded.status, uploaded.stderr).toBe(0);
    }
    expect(await changes()).toHaveLength(0);
    expect(harness.head()).toBe(base);
    expect(harness.git.requests.filter(request => request.path.endsWith('/git-receive-pack')).every(request => request.bytes < 29_000_000)).toBe(true);
    const advertised = await fetch(`${origin}/git/w.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from(`agent:${secret}`).toString('base64')}` } });
    expect(await advertised.text()).toContain('refs/braid/uploads/second');
    const other = await mintAccess(env, { grant: 'grant-other', user: maya, workspace: 'w', team: 't', scope: 'work', agent: 'conn-other', name: 'Other', owner, exp: Date.now() + 300_000 });
    const otherAdvertisement = await fetch(`${origin}/git/w.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from(`agent:${other}`).toString('base64')}` } });
    expect(await otherAdvertisement.text()).not.toContain('refs/braid/uploads/');
    const visible = await git(['ls-remote', `${origin}/git/w.git`]);
    expect(visible.stdout).not.toContain('refs/braid');
    const start = harness.git.requests.length;
    const submitted = await git(['push', 'origin', 'HEAD:refs/for/main']);
    expect(submitted.status, submitted.stderr).toBe(0);
    expect((await change(1)).files).toHaveLength(2);
    expect(harness.git.requests.slice(start).filter(request => request.path.endsWith('/git-receive-pack')).every(request => request.bytes < 4096)).toBe(true);
    const removed = await git(['push', 'origin', ':refs/braid/uploads/first', ':refs/braid/uploads/second']);
    // One upload operation is atomic; delete each retained ref separately.
    expect(removed.status).not.toBe(0);
    for (const name of ['first', 'second']) expect((await git(['push', 'origin', `:refs/braid/uploads/${name}`])).status).toBe(0);
    harness.git.native(['reflog', 'expire', '--expire=now', '--all']);
    harness.git.native(['prune', '--expire=now']);
    const retained = await change(1);
    for (const name of ['first', 'second']) expect(harness.git.native(['cat-file', '-s', `${retained.headCommit}:${name}.bin`]).trim()).toBe(String(25 * 1024 * 1024));
    expect((await git(['ls-remote', `${origin}/git/w.git`])).stdout).not.toContain('refs/braid');
  }, 120_000);

  it('submits 1,000 files above the old 8 MiB JSON envelope through the CLI and Worker API', async () => {
    const { harness, origin, work, connection, url, git, local, change } = await remote();
    const secret = await connection(), root = join(work, 'client');
    expect((await git(['clone', '-q', url(secret), 'client'], work)).status).toBe(0);
    for (let index = 0; index < 1000; index++) writeFileSync(join(root, `${index}.txt`), `${index}: documentation line\n`.repeat(500));
    expect(local(['add', '.']).status).toBe(0);
    expect(local(['commit', '-q', '-m', 'Add documentation']).status).toBe(0);
    const env = environment(work);
    writeLink(root, { url: origin, workspaceId: 'w' });
    saveCredentials(env, { origin, workspaceId: 'w', accessToken: secret, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const get = harness.artifacts.get.getMockImplementation()!;
    harness.artifacts.get.mockImplementation(async () => {
      const handle = await get();
      handle.createToken.mockImplementation(async () => ({ plaintext: 'fixture-token', expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      return handle;
    });
    let bytes = 0;
    const response = await braid(['submit'], { cwd: root, env, fetch: (input, init) => {
      if (String(input).endsWith('/api/changes')) bytes = Buffer.byteLength(String(init?.body));
      // Synchronous CLI Git reads share this test's event loop with the server; do not reuse a timed-out fixture socket.
      const headers = new Headers(init?.headers); headers.set('connection', 'close');
      return fetch(input, { ...init, headers });
    } });
    expect(response.exitCode, response.stderr).toBe(0);
    expect(response.stdout).toContain('Pull request #1');
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect((await change(1)).files).toHaveLength(1000);
  }, 120_000);

  it('restricts upload ref mutations to the submitting agent and refuses revision ref mutations', async () => {
    const { harness, env, origin, base, token } = await remote();
    const ownerToken = await token();
    const otherToken = await mintAccess(env, { grant: 'grant-other', user: maya, workspace: 'w', team: 't', scope: 'work', agent: 'conn-other', name: 'Other', owner, exp: Date.now() + 300_000 });
    const ref = `refs/braid/uploads/${await digest('agent:conn-1')}/asset`;
    const send = async (secret: string, name: string, old: string, next: string) => {
      const pack = spawnSync('git', ['--git-dir', join(harness.git.root, 'repo.git'), 'pack-objects', '--stdout'], { input: '' });
      expect(pack.status).toBe(0);
      const response = await api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST',
        headers: { authorization: `Basic ${btoa(`agent:${secret}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
        body: new Blob([pktLine(`${old} ${next} ${name}\0report-status\n`), FLUSH, pack.stdout] as BlobPart[]) }), env);
      return response.text();
    };
    expect(await send(ownerToken, 'refs/braid/uploads/asset', ZERO, base)).toContain('ok refs/braid/uploads/asset');
    for (const [old, next] of [[base, ZERO], [base, base]]) expect(await send(otherToken, ref, old, next)).toContain(`ng ${ref}`);
    expect(await send(otherToken, 'refs/braid/uploads/asset', base, ZERO)).toContain('ng refs/braid/uploads/asset');
    expect(harness.git.native(['rev-parse', ref]).trim()).toBe(base);
    const retained = `refs/braid/revisions/${base}`;
    for (const secret of [ownerToken, otherToken]) expect(await send(secret, retained, ZERO, base)).toContain(`ng ${retained}`);
    expect(await send(ownerToken, 'refs/braid/uploads/asset', base, ZERO)).toContain('ok refs/braid/uploads/asset');
    expect(harness.git.native(['for-each-ref', 'refs/braid/uploads'])).toBe('');
  });

  it('shares uploaded objects by known hash with other agents authorized to read the same repository', async () => {
    const { harness, env, work, token, url, git, commit } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    const tip = commit('asset.bin', 'pending\0asset', 'Upload asset');
    expect((await git(['push', 'origin', 'HEAD:refs/braid/uploads/asset'])).status).toBe(0);
    const other = await mintAccess(env, { grant: 'grant-other', user: maya, workspace: 'w', team: 't', scope: 'work', agent: 'conn-other', name: 'Other', owner, exp: Date.now() + 300_000 });
    expect((await git(['ls-remote', url(other)])).stdout).not.toContain(tip);
    expect((await git(['clone', '-q', url(other), 'reader'], work)).status).toBe(0);
    const reader = join(work, 'reader');
    const fetched = await git(['-c', 'protocol.version=2', 'fetch', '-q', 'origin', tip], reader);
    expect(fetched.status, fetched.stderr).toBe(0);
    expect((await git(['show', `${tip}:asset.bin`], reader)).stdout).toBe('pending\0asset');
    expect((await git(['push', 'origin', `${tip}:refs/braid/uploads/copied`], reader)).status).toBe(0);
    expect(harness.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/uploads']).trim().split('\n')).toHaveLength(2);
  });

  it.each(['full', 'too_large'])('names the Artifacts platform limit when an upload is refused with %s', async code => {
    const { harness, work, token, url, git, commit } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('asset.bin', 'binary\0', 'Add asset');
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input) === `${harness.git.remote}/git-receive-pack`
      ? Promise.resolve(code === 'too_large' ? new Response(null, { status: 413 }) : new Response(new Blob([pktLine('ERR artifacts_git_receive_pack_storage_limit\n'), FLUSH] as BlobPart[])))
      : realFetch(input, init));
    const pushed = await git(['push', 'origin', 'HEAD:refs/braid/uploads/asset']);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain(code === 'full' ? 'limits each repository to 1 GB' : 'about 30 MB per push');
  });

  it('revises the change a topic names, and pushing the same commit again changes nothing', async () => {
    const { directory, origin, work, token, url, git, commit, change, changes } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('src/retry.ts', 'export const attempts = 3;\n', 'Retry deliveries');
    expect((await git(['push', 'origin', 'HEAD:refs/for/main%topic=retries'])).stderr).toMatch(/Change #1:/);
    directory.updateTeam(maya.id, { teamId: 't', slug: 'renamed-team' });
    directory.updateWorkspace(maya.id, { teamId: 't', workspaceId: 'w', slug: 'renamed-repo' });
    commit('src/retry.ts', 'export const attempts = 5;\n', 'Retry five times\n\nFive attempts cover a minute of outage.');
    const revised = await git(['push', 'origin', 'HEAD:refs/for/main%topic=retries']);
    expect(revised.stderr).toMatch(/Change #1, revision 2:/);
    expect(revised.stderr).toContain(`${origin}/renamed-team/renamed-repo/pull/1`);
    expect(await change(1)).toMatchObject({ revision: 2, title: 'Retry deliveries', summary: '- Retry deliveries\n- Retry five times', files: [{ path: 'src/retry.ts', added: true }] });
    expect((await git(['push', 'origin', 'HEAD:refs/for/main%topic=retries'])).stderr).toMatch(/Change #1, revision 2:/);
    expect((await change(1)).revision).toBe(2);
    // Without a topic, each push is a change of its own.
    expect((await git(['push', 'origin', 'HEAD:refs/for/main'])).stderr).toMatch(/Change #2:/);
    expect((await changes()).map(item => item.number)).toEqual([1, 2]);
  }, 60_000);

  it("pushes with the long-lived connection token Git's credential helper keeps, as the CLI sets it up", async () => {
    const { origin, work, connection, url, git, commit, change, directory } = await remote();
    const team = directory.list(maya)[0];
    const secret = await connection();
    expect((await git(['clone', '-q', url(secret).replace('agent:', 'x:'), 'client'], work)).status).toBe(0);
    commit('docs/guide.md', '# Guide\n', 'Write the guide');
    const pushed = await git(['push', 'origin', 'HEAD:refs/for/main']);
    expect(pushed.stderr).toContain(`remote: Change #1: ${origin}/${team.slug}/${team.workspaces[0].slug}/pull/1`);
    // The connection names the agent and the person who approved it. It names no model, so the agent goes by "Agent", never its label.
    expect((await change(1)).author).toEqual({ kind: 'agent', id: 'agent:conn-laptop', name: 'Agent', owner: { id: 'user:u-maya', publicId: directory.publicPerson(maya.id), name: 'Maya Chen' } });
    expect((await git(['push', url(await connection('read')), 'HEAD:refs/for/main'])).stderr).toContain('403');
  }, 60_000);

  it('takes the model, tool and session from a Braid note pushed with the commit', async () => {
    const { work, token, url, git, local, commit, change } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('docs/guide.md', '# Guide\n', 'Write the guide');
    expect(local(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 's_77', parentSession: 's_1' } }), 'HEAD']).status).toBe(0);
    const pushed = await git(['push', 'origin', 'HEAD:refs/for/main', 'refs/notes/braid:refs/notes/braid']);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect((await change(1)).author).toEqual({ kind: 'agent', id: 'agent:conn-1', name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', owner, tool: 'codex/1.8.0', session: 's_77', parentSession: 's_1' });
  }, 60_000);

  it('refuses pushes to branches, several changes at once, history main does not share, and pushes without work access', async () => {
    const { harness, base, work, token, url, git, local, commit, changes } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('src/a.ts', 'export const a = 1;\n', 'Add a');
    const branch = await git(['push', 'origin', 'HEAD:refs/heads/main']);
    expect(branch.status).not.toBe(0);
    expect(branch.stderr).toContain('main only moves through the merge queue. Push to refs/for/main to open a change.');
    const several = await git(['push', 'origin', 'HEAD:refs/for/main', 'HEAD:refs/for/main%topic=other']);
    expect(several.stderr).toContain('Push one change at a time');
    const elsewhere = await git(['push', 'origin', 'HEAD:refs/for/develop']);
    expect(elsewhere.stderr).toContain('Changes land on main: push to refs/for/main.');
    expect(local(['checkout', '-q', '--orphan', 'unrelated']).status).toBe(0);
    commit('src/b.ts', 'export const b = 2;\n', 'Start over');
    expect((await git(['push', 'origin', 'HEAD:refs/for/main'])).stderr).toContain("This push is not based on main's history.");
    // A read-only connection fetches but cannot push.
    expect((await git(['push', url(await token('read')), 'HEAD:refs/for/main'])).stderr).toContain('403');
    expect((await git(['ls-remote', url(await token('read'))])).stdout).toContain(base);
    expect((await git(['ls-remote', url('braid_at_forged.token')])).status).not.toBe(0);
    expect(await changes()).toEqual([]);
    expect(harness.head()).toBe(base);
    expect(harness.git.native(['for-each-ref', 'refs/braid'])).toBe('');
  }, 60_000);

  it('asks Git for credentials, and refuses deletes and oversized pushes before keeping anything', async () => {
    const { env, base, origin, token } = await remote();
    const unauthenticated = await api.fetch(new Request(`${origin}/git/w.git/info/refs?service=git-upload-pack`), env);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Basic realm="Braid"');
    const authorization = `Basic ${btoa(`agent:${await token()}`)}`;
    const send = (body: BodyInit, headers: Record<string, string> = {}) => api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`,
      { method: 'POST', body, headers: { authorization, 'content-type': 'application/x-git-receive-pack-request', ...headers } }), env);
    const deleted = await send(new Blob([pktLine(`${base} ${ZERO} refs/for/main\0report-status\n`), FLUSH] as BlobPart[]));
    expect(await deleted.text()).toContain('ng refs/for/main Braid does not delete refs.');
    const large = await send(new Blob([pktLine(`${ZERO} ${base} refs/for/main\0report-status\n`), FLUSH] as BlobPart[]), { 'content-length': String(33 * 1024 * 1024) });
    expect(large.status).toBe(413);
  }, 60_000);

  it.each(['refs/for/main', 'refs/braid/uploads/asset'])('rechecks owner access before writing %s', async ref => {
    const { env, origin, token, harness, directory, base, changes } = await remote();
    const allowed = await directory.access(maya, 'w', true);
    const access = vi.spyOn(directory, 'access').mockResolvedValue({ ok: false, status: 403, error: 'private access diagnostic' }).mockResolvedValueOnce(allowed);
    const response = await api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST',
      headers: { authorization: `Basic ${btoa(`agent:${await token()}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: new Blob([pktLine(`${ZERO} ${base} ${ref}\0report-status\n`), FLUSH] as BlobPart[]) }), env);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('The owner who authorized this operation no longer has repository access.');
    expect(access).toHaveBeenCalledTimes(2);
    expect(harness.git.requests.some(request => request.path.endsWith('/git-receive-pack'))).toBe(false);
    expect(await changes()).toEqual([]);
    expect(harness.git.native(['for-each-ref', 'refs/braid'])).toBe('');
    expect(harness.head()).toBe(base);
  });

  it('refuses malformed Git commands before asking Artifacts to store a pack', async () => {
    const { env, origin, token, harness } = await remote();
    const authorization = `Basic ${btoa(`agent:${await token()}`)}`;
    for (const command of ['not a command', `${ZERO} ${'a'.repeat(40)}`, `${ZERO} not-an-oid refs/for/main`, `${ZERO} ${'a'.repeat(40)} refs/for/main extra`]) {
      const response = await api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST',
        headers: { authorization, 'content-type': 'application/x-git-receive-pack-request' }, body: new Blob([pktLine(`${command}\0report-status\n`), FLUSH] as BlobPart[]) }), env);
      expect(response.status).toBe(400);
    }
    expect(harness.git.native(['for-each-ref', 'refs/braid'])).toBe('');
  }, 60_000);

  it('stops reading a protocol v2 fetch request once it passes the size limit', async () => {
    const { env, origin, token } = await remote();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull: controller => { if (++pulled > 512) controller.close(); else controller.enqueue(new Uint8Array(64 * 1024)); } });
    const response = await api.fetch(new Request(`${origin}/git/w.git/git-upload-pack`, { method: 'POST', body, duplex: 'half',
      headers: { authorization: `Basic ${btoa(`agent:${await token('read')}`)}`, 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' } } as RequestInit), env);
    expect(response.status).toBe(413);
    expect(pulled * 64 * 1024).toBeLessThan(9 * 1024 * 1024);
  }, 60_000);

  it('cleans incoming refs even when Artifacts accepts one ref but refuses the notes ref', async () => {
    const { harness, work, token, url, git, local, commit, changes } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('docs/guide.md', '# Guide\n', 'Write the guide');
    expect(local(['notes', '--ref=braid', 'add', '-m', '{"v":1}', 'HEAD']).status).toBe(0);
    const hook = join(harness.git.root, 'repo.git', 'hooks', 'update');
    writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/braid/incoming/*-notes) exit 1;; esac\nexit 0\n');
    chmodSync(hook, 0o755);
    expect((await git(['push', 'origin', 'HEAD:refs/for/main', 'refs/notes/braid:refs/notes/braid'])).status).not.toBe(0);
    expect(await changes()).toEqual([]);
    expect(harness.git.native(['for-each-ref', 'refs/braid'])).toBe('');
  }, 60_000);

  it('keeps raw upstream errors out of both the Git response and the logs', async () => {
    const { harness, work, token, url, git, commit } = await remote();
    expect((await git(['clone', '-q', url(await token()), 'client'], work)).status).toBe(0);
    commit('docs/guide.md', '# Guide\n', 'Write the guide');
    const sensitive = 'upstream-credential-fixture-value';
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(harness.git.repository, 'readCommit').mockRejectedValue(new Error(`Request failed with ${sensitive}`));
    const pushed = await git(['push', 'origin', 'HEAD:refs/for/main']);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).not.toContain(sensitive);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(sensitive);
  }, 60_000);
});

  it.each(['refs/for/main', 'refs/braid/uploads/asset'])('rechecks authorization after issuing the write token for %s', async ref => {
    const { env, origin, token, harness, directory, base } = await remote();
    const get = harness.artifacts.get.getMockImplementation()!;
    harness.artifacts.get.mockImplementation(async () => {
      const handle = await get();
      handle.createToken.mockImplementation(async () => {
        vi.spyOn(directory, 'access').mockResolvedValue({ ok: false, status: 403, error: 'private access diagnostic' });
        return { plaintext: 'fixture-token' };
      });
      return handle;
    });
    const response = await api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST',
      headers: { authorization: `Basic ${btoa(`agent:${await token()}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: new Blob([pktLine(`${ZERO} ${base} ${ref}\0report-status\n`), FLUSH] as BlobPart[]) }), env);
    await response.text();
    expect(harness.git.requests.filter(request => request.path.endsWith('/git-receive-pack'))).toEqual([]);
    expect(harness.git.native(['for-each-ref', 'refs/braid'])).toBe('');
    const handles = await Promise.all(harness.artifacts.get.mock.results.map(result => result.value));
    expect(handles.flatMap(handle => handle.revokeToken.mock.calls)).toContainEqual(['fixture-token']);
  });

  it('rechecks authorization before the cleanup push after receiving an incoming ref', async () => {
    const { harness, env, origin, token, directory, base } = await remote();
    const upstream = globalThis.fetch;
    let writes = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await upstream(input, init);
      if (String(input) === `${harness.git.remote}/git-receive-pack` && ++writes === 1)
        vi.spyOn(directory, 'access').mockResolvedValue({ ok: false, status: 403, error: 'private access diagnostic' });
      return response;
    });
    const pack = spawnSync('git', ['--git-dir', join(harness.git.root, 'repo.git'), 'pack-objects', '--stdout'], { input: '' });
    expect(pack.status).toBe(0);
    const response = await api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST',
      headers: { authorization: `Basic ${btoa(`agent:${await token()}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: new Blob([pktLine(`${ZERO} ${base} refs/for/main\0report-status\n`), FLUSH, pack.stdout] as BlobPart[]) }), env);
    expect(await response.text()).toContain('ng refs/for/main');
    expect(writes).toBe(1);
  });
