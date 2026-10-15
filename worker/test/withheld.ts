import { expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import api from '../http/api';
import { digest, sessionToken } from '../http/auth';
import { publicRepository } from './public-repository';
import { storageFixture } from './storage';
import { Workspace } from '../workspace/workspace';
import { seedWorkspace } from '../workspace/seed';
import { concat, FLUSH, pktLine, ZERO } from '../git/transport';
import type { BraidEnv } from '../env';
import type { Change } from '../../shared/types';

export const secret = 'ghp_' + 'A1b2'.repeat(9); // Synthetic; never a credential.
export const tipText = `export const key = '${secret}';\n// unpublished-ledger-tip\n`;
export const parentText = `const key = '${secret}';\n// unpublished-ledger-parent\n`;
export const marker = 'unpublished-ledger';
export const origin = 'https://braid.example';

/**
 * A public repository with a real workspace object and Git server, a signed-in member, and an agent that pushes to
 * `refs/for/main`. `parent` and `tip` are two pushed commits that both hold a secret. `calls` lists every Artifacts
 * call the gateway and the workspace make, in order, with the ref of each `log`. `branches` are the other branches the
 * repository lists, as an import records the branches it copied.
 */
export async function withheldFixture(options: { branches?: string[] } = {}) {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const f = await publicRepository(), store = storageFixture();
  // Any accidental nonlocal fetch is a test failure. api.fetch itself runs in process.
  const fetchLocal = globalThis.fetch;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' || url.port === '5173') throw new Error('Only fixture localhost traffic is allowed');
    return fetchLocal(input, init);
  });
  const calls: string[] = [], events: string[] = [];
  // Artifacts reads a branch, a tag or a commit ID and nothing else: a full `refs/...` name names nothing there.
  const asArtifacts = (repo: ArtifactsRepo) => new Proxy(repo, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (typeof value !== 'function') return value;
    if (prop !== 'log' && prop !== 'readFile') return value.bind(target);
    return (options: { ref?: string } = {}) => options.ref?.startsWith('refs/') ? Promise.resolve(prop === 'log' ? [] : null) : value.call(target, options);
  } });
  const artifacts = f.env.ARTIFACTS;
  f.env.ARTIFACTS = { get: async (id: string) => {
    const repo = asArtifacts(await artifacts.get(id));
    return new Proxy(repo, { get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const name = prop === 'log' ? `log:${(args[0] as { ref?: string } | undefined)?.ref}` : prop;
        calls.push(name); events.push(`start ${name}`);
        return Promise.resolve(value.apply(target, args)).finally(() => events.push(`end ${name}`));
      };
    } });
  } } as unknown as BraidEnv['ARTIFACTS'];
  // The trunk and change shards read the same repository, through the same Artifacts.
  const harness = f.h.env.ARTIFACTS;
  f.h.env.ARTIFACTS = { get: async (id: string) => asArtifacts(await harness.get(id)) } as unknown as BraidEnv['ARTIFACTS'];
  const state = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false,
    authenticated: true, storage: 'durable-object', model: 'fixture', namespace: 'fixture' });
  state.project = { ...state.project, id: 'repo', head: f.base, branch: 'main', remote: f.h.git.remote, ...(options.branches ? { branches: ['main', ...options.branches] } : {}) };
  await store.storage.put('workspace', state);
  const workspace = new Workspace(store.ctx, f.env); await store.ready();
  f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => workspace, getByName: () => workspace } as unknown as BraidEnv['WORKSPACES'];
  const token = await sessionToken(f.env.SESSION_SECRET);
  await f.security.issue(await digest(token), Date.now() + 86_400_000, f.alice);
  const connection = 'braid_agent_' + '12345678'.repeat(8);
  await f.security.issueAgent(await digest(connection), { id: 'audit-agent', user: f.alice, workspaceId: 'w', scope: 'work', label: 'Audit', expires: Date.now() + 86_400_000 });
  const call = (path: string, member = false) => api.fetch(new Request(`${origin}${path}`, { headers: {
    'x-braid-workspace': 'w', 'cf-connecting-ip': '198.51.100.7', ...(member ? { cookie: `__Host-braid-session=${token}` } : {}),
  } }), f.env);
  const parent = f.h.git.commitTree({ 'past.txt': parentText }, f.base, 'unpublished-ledger parent');
  const tip = f.h.git.commitTree({ 'past.txt': null, 'client.ts': tipText }, parent, 'Withheld tip');
  let release = () => {}, stopped: Promise<unknown> | undefined;
  /** Pushes `hash` and holds the push open, with its hidden ref in place, until `finish()`. */
  const beginPush = async (hash = tip, topic = 'audit') => {
    let ready!: (change: Change) => void;
    const arrived = new Promise<Change>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const changes = f.env.CHANGES;
    f.env.CHANGES = { getByName(name: string) {
      const shard = changes.getByName(name);
      return new Proxy(shard, { get(target, prop) {
        if (prop === 'push') return async (...args: Parameters<typeof shard.push>) => {
          const result = await target.push(...args);
          if (!result.ok) throw new Error(result.error);
          ready(result.data); await gate; return result;
        };
        const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } as BraidEnv['CHANGES'];
    const pack = execFileSync('git', ['--git-dir', join(f.h.git.root, 'repo.git'), 'pack-objects', '--stdout', '--revs'], { input: `${hash}\n^${f.base}\n` });
    const body = concat([pktLine(`${ZERO} ${hash} refs/for/main%topic=${topic}\0report-status\n`), FLUSH, new Uint8Array(pack)]);
    const done = api.fetch(new Request(`${origin}/git/w.git/git-receive-pack`, { method: 'POST', headers: {
      authorization: `Basic ${btoa(`agent:${connection}`)}`, 'content-type': 'application/x-git-receive-pack-request',
    }, body }), f.env).then(async response => { expect(response.status).toBe(200); expect(await response.text()).toContain('ok refs/for/main'); });
    stopped = done;
    const change = await Promise.race([arrived, done.then(() => { throw new Error('Push finished before publishing a change'); })]);
    const incoming = f.h.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/incoming/']).trim();
    expect(incoming).toMatch(/^refs\/braid\/incoming\//);
    return { change, incoming, finish: async () => { release(); await done; f.env.CHANGES = changes; stopped = undefined; expect(f.h.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/incoming/'])).toBe(''); } };
  };
  const upload = async (hash: string, version: 1 | 2, gzip = false) => {
    const bytes = version === 1 ? concat([pktLine(`want ${hash}\n`), FLUSH, pktLine('done\n')])
      : concat([pktLine('command=fetch\n'), new TextEncoder().encode('0001'), pktLine(`want ${hash}\n`), pktLine('done\n'), FLUSH]);
    const body = gzip ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()) : bytes;
    const response = await api.fetch(new Request(`${origin}/git/w.git/git-upload-pack`, { method: 'POST', headers: {
      'content-type': 'application/x-git-upload-pack-request', 'cf-connecting-ip': '198.51.100.7',
      ...(version === 2 ? { 'git-protocol': 'version=2' } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    }, body }), f.env);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  return { ...f, store, workspace, call, cookie: `__Host-braid-session=${token}`, parent, tip, beginPush, upload, calls, events, async close() {
    release(); await stopped; network.mockRestore(); await store.settled(); store.db.close(); await f.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  } };
}

export function extractPack(bytes: Buffer, version: 1 | 2) {
  if (version === 1) { const index = bytes.indexOf('PACK'); return index < 0 ? null : bytes.subarray(index); }
  const chunks: Buffer[] = [];
  let packing = false;
  for (let at = 0; at + 4 <= bytes.length;) {
    const size = Number.parseInt(bytes.subarray(at, at + 4).toString(), 16);
    if (!Number.isInteger(size) || size < 0 || at + Math.max(4, size) > bytes.length) return null;
    if (size < 4) { at += 4; continue; }
    const line = bytes.subarray(at + 4, at + size); at += size;
    if (line.toString() === 'packfile\n') { packing = true; continue; }
    if (packing && line[0] === 1) chunks.push(line.subarray(1));
  }
  const pack = Buffer.concat(chunks); return pack.subarray(0, 4).toString() === 'PACK' ? pack : null;
}
/** Decodes a returned pack in a fresh repository: PACK bytes alone are not proof of disclosure. */
export function recovered(pack: Buffer, hash: string, path: string) {
  const root = mkdtempSync(join(tmpdir(), 'braid-audit-pack-'));
  try {
    execFileSync('git', ['init', '--bare', root], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', root, 'index-pack', '--stdin'], { input: pack, stdio: ['pipe', 'pipe', 'pipe'] });
    return execFileSync('git', ['--git-dir', root, 'show', `${hash}:${path}`], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** One observed case, kept as evidence when BRAID_AUDIT_EVIDENCE names a file. */
export function observe(record: Record<string, unknown>) {
  if (process.env.BRAID_AUDIT_EVIDENCE) appendFileSync(process.env.BRAID_AUDIT_EVIDENCE, JSON.stringify(record) + '\n');
}

type Fixture = Awaited<ReturnType<typeof withheldFixture>>;
/**
 * `count` commits on main above the fixture's base, an hour apart, written by one fast-import; commit `i` sets `n.txt`
 * to `i`. Every `mergeEvery`th commit is a merge whose second parent, `side.get(i)`, no ref names, and every
 * `branchEvery`th starts a branch `stale-<i>` of one commit, `stale.get(i)`.
 */
export function grow(f: Fixture, count: number, { mergeEvery = 0, branchEvery = 0 } = {}) {
  const start = Number(f.h.git.native(['log', '-1', '--format=%ct', f.base]).trim()) + 3_600;
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const commit = (ref: string, mark: number, at: number, parents: string[], path: string, text: string) =>
    `commit ${ref}\nmark :${mark}\ncommitter Test <test@example.test> ${at} +0000\n${data(`${path} ${text}`)}`
    + parents.map((parent, index) => `${index ? 'merge' : 'from'} ${parent}\n`).join('') + `M 100644 inline ${path}\n${data(`${text}\n`)}`;
  let stream = '';
  for (let i = 1; i <= count; i++) {
    const at = start + i * 3_600, previous = i === 1 ? f.base : `:${i - 1}`;
    const merge = mergeEvery && i % mergeEvery === 0;
    if (merge) stream += commit(`refs/side/${i}`, 100_000 + i, at - 1_800, [previous], `side-${i}.txt`, `side ${i}`);
    stream += commit('refs/heads/main', i, at, merge ? [previous, `:${100_000 + i}`] : [previous], 'n.txt', String(i));
    if (branchEvery && i % branchEvery === 0) stream += commit(`refs/heads/stale-${i}`, 200_000 + i, at + 1_800, [`:${i}`], `stale-${i}.txt`, `stale ${i}`);
  }
  const folder = mkdtempSync(join(tmpdir(), 'braid-marks-')), file = join(folder, 'marks');
  try {
    f.h.git.native(['fast-import', '--quiet', `--export-marks=${file}`], stream);
    const marks = new Map(readFileSync(file, 'utf8').trim().split('\n').map(line => { const [mark, hash] = line.split(' '); return [Number(mark.slice(1)), hash] as const; }));
    const deletes = f.h.git.native(['for-each-ref', '--format=delete %(refname)', 'refs/side/']);
    if (deletes) f.h.git.native(['update-ref', '--stdin'], deletes);
    const pick = (offset: number) => new Map([...marks].filter(([mark]) => mark > offset && mark < offset + 100_000).map(([mark, hash]) => [mark - offset, hash]));
    return { main: pick(0), side: pick(100_000), stale: pick(200_000) };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** A commit on `parent`, dated a minute after it, that no ref names. */
export function hide(f: Fixture, parent: string) {
  const at = Number(f.h.git.native(['log', '-1', '--format=%ct', parent]).trim()) + 60;
  f.h.git.native(['fast-import', '--quiet'], `commit refs/hidden\ncommitter Test <test@example.test> ${at} +0000\ndata 6\nHidden\nfrom ${parent}\nM 100644 inline hidden.txt\ndata 12\nunpublished\n\n`);
  const hash = f.h.git.native(['rev-parse', 'refs/hidden']).trim();
  f.h.git.native(['update-ref', '-d', 'refs/hidden']);
  return hash;
}
