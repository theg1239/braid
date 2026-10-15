import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { Miniflare } from 'miniflare';

let runtime: Miniflare;
beforeAll(async () => {
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { cachedPublicRead } from ${JSON.stringify(`${process.cwd()}/worker/http/read-cache.ts`)};
    export class Origin extends DurableObject {
      calls = 0;
      async fetch(request) {
        const url = new URL(request.url), call = ++this.calls, status = Number(url.searchParams.get('status'));
        await new Promise(resolve => setTimeout(resolve, 50));
        const init = { status, statusText: 'Origin result', headers: { etag: '"origin"',
          ...(url.searchParams.has('cookie') ? { 'set-cookie': 'session=personal' } : {}) } };
        return status === 304 ? new Response(null, init) : Response.json({ call }, init);
      }
    }
    export default { async fetch(request, env) {
      const url = new URL(request.url), name = url.searchParams.get('case');
      try {
        const response = await cachedPublicRead(new Request('https://reads.braid.invalid/' + name), 5, async () => {
          const origin = await env.ORIGIN.getByName(name).fetch(request);
          return url.searchParams.has('local') ? Response.json(await origin.json(), origin) : origin;
        });
        return Response.json({ status: response.status, statusText: response.statusText, etag: response.headers.get('etag'),
          cookie: response.headers.get('set-cookie'), body: response.body ? await response.json() : null });
      } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
    } };
  `;
  const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, plugins: [{ name: 'read-cache-runtime',
    resolveId: id => id === 'read-cache-runtime' ? '\0read-cache-runtime' : undefined,
    load: id => id === '\0read-cache-runtime' ? source : undefined,
  }], build: { ssr: true, write: false, minify: false, rolldownOptions: { platform: 'neutral', input: 'read-cache-runtime', external: ['cloudflare:workers'], output: { codeSplitting: false } } } });
  if (!('output' in built)) throw new Error('Expected one in-memory Worker bundle.');
  const main = built.output.find(item => item.type === 'chunk');
  if (!main) throw new Error('Missing cache fixture bundle.');
  runtime = new Miniflare({ workers: [{ config: {
    name: 'read-cache-runtime-test', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: main.code } } },
    exports: { Origin: { type: 'durable-object', storage: 'sqlite' } },
    env: { ORIGIN: { type: 'durable-object', worker: 'read-cache-runtime-test', exportName: 'Origin' } },
  } }] });
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

it.each(['status=200', 'status=503', 'status=200&cookie=1', 'status=200&local=1', 'status=304'])('shares plain response data across concurrent Worker request contexts (%s)', async query => {
  const url = `https://local.test/api/state?case=${crypto.randomUUID()}&${query}`;
  const responses = await Promise.all(Array.from({ length: 5 }, async () => {
    const response = await runtime.dispatchFetch(url);
    return { status: response.status, body: await response.json() };
  }));
  const params = new URLSearchParams(query), status = Number(params.get('status'));
  const expected = { status, statusText: 'Origin result', etag: '"origin"', cookie: params.has('cookie') ? 'session=personal' : null,
    body: status === 304 ? null : { call: 1 } };
  expect(responses, JSON.stringify(responses)).toEqual(Array.from({ length: 5 }, () => ({ status: 200, body: expected })));
  const cacheable = status === 200 && !params.has('cookie');
  expect(await (await runtime.dispatchFetch(url)).json()).toEqual({ ...expected,
    statusText: cacheable ? 'OK' : expected.statusText,
    body: status === 304 ? null : { call: cacheable ? 1 : 2 } });
});
