import { expect, it } from 'vitest';
import { build } from 'vite';
import { Miniflare } from 'miniflare';

it('warms Code through a real Workers RPC repository without calling the handle as a factory', async () => {
  const source = `
    import { RpcStub, RpcTarget } from 'cloudflare:workers';
    import { artifactsOf } from ${JSON.stringify(`${process.cwd()}/worker/env.ts`)};
    import { ObjectMemory, directoryEntries, fileAt } from ${JSON.stringify(`${process.cwd()}/worker/repositories/repository.ts`)};
    class Repository extends RpcTarget {
      readCommit(hash) { return { hash, treeHash: 'tree' }; }
      readTree(hash) { return [{ name: 'README.md', hash: 'blob', type: 'blob', mode: '100644' }]; }
      readBlob(hash) { return new Blob(['# Read me']); }
    }
    export default { async fetch() {
      using raw = new RpcStub(new Repository());
      using repo = await artifactsOf({ ARTIFACTS: { get: async () => raw.dup() } }).get('repo');
      const reader = new ObjectMemory().reader(repo);
      try {
        const entries = await directoryEntries(reader, 'head', '');
        const readme = await fileAt(reader, 'head', 'README.md');
        return Response.json({ type: typeof repo, entries, content: readme.content });
      } catch (error) { return Response.json({ type: typeof repo, error: error.name, message: error.message }, { status: 500 }); }
    } };
  `;
  const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, plugins: [{ name: 'rpc-fixture',
    resolveId: id => id === 'rpc-fixture' ? '\0rpc-fixture' : undefined,
    load: id => id === '\0rpc-fixture' ? source : undefined,
  }], build: { ssr: true, write: false, minify: false, rolldownOptions: { input: 'rpc-fixture', external: ['cloudflare:workers'], output: { codeSplitting: false } } } });
  if (!('output' in built)) throw new Error('Expected one in-memory Worker bundle.');
  const main = built.output.find(item => item.type === 'chunk');
  if (!main) throw new Error('Missing RPC fixture bundle.');
  const runtime = new Miniflare({ workers: [{ config: { name: 'object-memory-rpc-test', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: main.code } } },
  } }] });
  try {
    const response = await runtime.dispatchFetch('http://local.test/'), data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data).toMatchObject({ type: 'function', content: '# Read me', entries: [{ name: 'README.md' }] });
  } finally { await runtime.dispose(); }
}, 30_000);
