import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { Miniflare } from 'miniflare';

let runtime: Miniflare;
const head = 'a'.repeat(40), older = 'c'.repeat(40);

beforeAll(async () => {
  // Exercise the real Workspace in workerd: a Node storage mock cannot model input gates.
  const source = `
    import { RpcStub, RpcTarget } from 'cloudflare:workers';
    import { Workspace } from ${JSON.stringify(`${process.cwd()}/worker/workspace/workspace.ts`)};
    import { seedWorkspace } from ${JSON.stringify(`${process.cwd()}/worker/workspace/seed.ts`)};
    const head = '${head}', parent = 'b'.repeat(40), older = '${older}';
    const commit = hash => ({ hash, treeHash: 'tree-' + hash, parents: hash === head ? [parent] : [],
      message: 'Update README', committedAt: 1700000000, authoredAt: 1700000000,
      author: { name: 'Author', email: 'author@example.test' }, committer: { name: 'Author', email: 'author@example.test' } });
    class Repository extends RpcTarget {
      constructor(gate) { super(); this.gate = gate; }
      async readCommit(hash) { await this.gate.wait('commit'); return commit(hash); }
      async log({ ref }) { await this.gate.wait('history'); return ref.startsWith('refs/notes/') ? [] : [commit(head), commit(parent), commit(older)]; }
      readTree(hash) { return [{ name: 'README.md', hash: 'blob-' + hash, type: 'blob', mode: '100644' }]; }
      async readBlob(hash) { await this.gate.wait('blob'); return new Blob([hash]); }
    }
    export class TestWorkspace extends Workspace {
      constructor(ctx, env) {
        const gate = { wait: async () => {} };
        super(ctx, { ...env, ARTIFACTS: { get: async () => { await gate.wait('open'); return new RpcStub(new Repository(gate)); } },
          TRUNKS: { getByName: () => ({ provenance: async () => [], occupiedShards: async () => [] }) } });
        this.gate = gate;
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/_test/prepare') {
          // Seed a stored, already imported mirror; all requests below use the production handler.
          this.data = seedWorkspace('live', this.capabilities('live'));
          this.data.project = { ...this.data.project, id: 'repo', head, branch: 'main', remote: 'https://git.example/repo' };
          await this.ctx.storage.put('history-copy', 'complete');
          await this.save(undefined, 200, undefined, false);
          const method = url.searchParams.get('method');
          const held = new Promise(resolve => this.release = resolve);
          this.entered = new Promise(resolve => this.markEntered = resolve);
          this.gate.wait = async name => { if (name === method) { this.markEntered(); await held; } };
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/_test/entered') { await this.entered; return new Response(null, { status: 204 }); }
        if (url.pathname === '/_test/release') { this.release(); return new Response(null, { status: 204 }); }
        return super.fetch(request);
      }
    }
    export default { fetch(request, env) { return env.WORKSPACES.getByName(request.headers.get('x-test-case')).fetch(request); } };
  `;
  const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, plugins: [{ name: 'state-concurrency',
    resolveId: id => id === 'state-concurrency' ? '\0state-concurrency' : undefined,
    load: id => id === '\0state-concurrency' ? source : undefined,
  }], build: { ssr: true, write: false, minify: false, rolldownOptions: { platform: 'neutral', input: 'state-concurrency', external: ['cloudflare:workers'], output: { codeSplitting: false } } } });
  if (!('output' in built)) throw new Error('Expected one in-memory Worker bundle.');
  const main = built.output.find(item => item.type === 'chunk');
  if (!main) throw new Error('Missing Workspace fixture bundle.');
  runtime = new Miniflare({ workers: [{ config: {
    name: 'state-concurrency-test', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: main.code } } },
    exports: { TestWorkspace: { type: 'durable-object', storage: 'sqlite' } },
    env: { WORKSPACES: { type: 'durable-object', worker: 'state-concurrency-test', exportName: 'TestWorkspace' } },
  } }] });
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

it.each([
  ['open', `/api/repository/commit?sha=${head}`],
  ['commit', `/api/repository/commit?sha=${head}`],
  ['blob', `/api/repository/commit/diff?sha=${head}&path=README.md`],
  ['history', `/api/repository/commit/diff?sha=${older}&path=README.md`],
])('answers state and its validator while a repository %s read is still unresolved', async (method, path) => {
  const headers = { 'x-test-case': method, 'x-braid-mode': 'live', 'x-braid-public': 'true', 'x-braid-repository': `test:${method}` };
  const read = (path: string, extra: Record<string, string> = {}) => runtime.dispatchFetch(`https://local.test${path}`, { headers: { ...headers, ...extra } });
  const unblocked = async (request: ReturnType<typeof read>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([request, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000); })]);
      expect(response, 'State waited for unresolved repository I/O').not.toBeNull();
      return response!;
    } finally { clearTimeout(timer); }
  };
  expect((await read(`/_test/prepare?method=${method}`)).status).toBe(204);
  let completed = false;
  const repository = read(path).then(async response => { completed = true; return { status: response.status, body: await response.json() }; });
  try {
    await read('/_test/entered');
    const state = await unblocked(read('/api/state'));
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ project: { id: 'repo', head }, missions: [] });
    expect(completed).toBe(false);
    expect((await unblocked(read('/api/state', { 'if-none-match': state.headers.get('etag')! }))).status).toBe(304);
    expect(completed).toBe(false);
  } finally { await read('/_test/release'); }
  expect(await repository).toMatchObject({ status: 200 });
}, 10_000);
