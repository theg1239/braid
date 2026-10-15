import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESERVED_OWNERS } from '../shared/routes';

const script = readFileSync(new URL('../public/boot.js', import.meta.url), 'utf8');
const manifest = {
  landing: ['/landing.js', '/landing.css'], explore: ['/explore.js'],
  code: ['/code.js', '/shared.js'], pulls: ['/pulls.js'], pull: ['/pull.js'], compare: ['/compare.js', '/shared.js'], search: ['/search.js'],
  files: ['/files.js', '/shared.js'], viewer: ['/viewer.js', '/shared.js'], markdown: ['/markdown.js'], mono: ['/mono.woff2'],
  grammars: { ts: ['/typescript.js'], json: ['/json.js'] }, reserved: [...RESERVED_OWNERS],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The example's home reads, as boot.js names them: the snapshot, the root listing and the latest merge. The README waits for the listing to name it. */
const homeReads = ['/api/state', '/api/repository/tree?ref=&path=', '/api/changes?status=landed&limit=1'];

function boot(path: string, metadata: string | null = JSON.stringify(manifest), respond: (path: string, options?: RequestInit) => Promise<Response> = () => Promise.resolve(new Response('{}'))) {
  const links: Record<string, string>[] = [];
  const fetch = vi.fn(respond);
  const window: { __braidEarly?: { account: Promise<Response>; reads: Record<string, Promise<Response>> }; __braidCodeWorkers?: { url: string }[] } = {};
  const Worker = class { constructor(public url: string) {} terminate() {} };
  runInNewContext(script, {
    window, fetch, URLSearchParams, AbortController, setTimeout, clearTimeout, Worker, location: new URL(path, 'https://braid.test'),
    document: {
      querySelector: () => metadata === null ? null : { content: metadata },
      createElement: () => ({}), head: { appendChild: (link: Record<string, string>) => links.push(link) },
    },
  });
  const scopes = () => fetch.mock.calls.map(([path, init]) => `${(init?.headers as Record<string, string> | undefined)?.['x-braid-workspace'] ?? ''} ${path}`);
  return { links, hrefs: links.map((link) => link.href), fetch, early: window.__braidEarly!, scopes, window };
}

afterEach(() => { vi.useRealTimers(); });

describe('startup resource hints', () => {
  it('starts the account and the example home\'s reads even without build metadata, under its scope', async () => {
    const result = boot('/example/relay', null);
    expect(result.scopes()).toEqual([' /api/account', ...homeReads.map((path) => `demo ${path}`)]);
    expect(await (await result.early.account).json()).toEqual({});
    expect(result.early.reads).toEqual(Object.fromEntries(homeReads.map((path, index) => [`demo ${path}`, result.fetch.mock.results[index + 1].value])));
    expect(result.hrefs).toEqual([]);
  });

  it('asks the server for another repository\'s address and starts its screen\'s reads the moment it answers', async () => {
    const result = boot('/acme/relay', JSON.stringify(manifest), (path) => Promise.resolve(path === '/api/repos/acme/relay' ? Response.json({ workspaceId: 'ws-1', visibility: 'public' }) : Response.json({})));
    expect(result.scopes()).toEqual([' /api/account', ' /api/repos/acme/relay']);
    await settle();
    expect(result.scopes()).toEqual([' /api/account', ' /api/repos/acme/relay', ...homeReads.map((path) => `ws-1 ${path}`)]);
    // The app finds the address answer whole, and each read under the scope the server named.
    expect(await (await result.early.reads[' /api/repos/acme/relay']).json()).toEqual({ workspaceId: 'ws-1', visibility: 'public' });
    expect(Object.keys(result.early.reads)).toEqual([' /api/repos/acme/relay', ...homeReads.map((path) => `ws-1 ${path}`)]);
    expect(result.hrefs).toEqual(['/code.js', '/shared.js', '/markdown.js']);
  });

  it.each(['/acme/relay/blob/main/src/a%20b.ts', '/acme/relay/blame/main/src/a%20b.ts', '/acme/relay/tree/main/src'])('reads what a code address shows beside its snapshot: %s', async (path) => {
    const result = boot(path, JSON.stringify(manifest), (requested) => Promise.resolve(requested === '/api/repos/acme/relay' ? Response.json({ workspaceId: 'ws-1' }) : Response.json({})));
    await settle();
    const file = path.includes('/tree/') ? ['/api/repository/tree?ref=&path=src'] : ['/api/repository?ref=&path=src%2Fa%20b.ts', ...(path.includes('/blame/') ? ['/api/blame?path=src%2Fa%20b.ts&ref='] : [])];
    expect(result.scopes().slice(2)).toEqual(['/api/state', '/api/repository/tree?ref=&path=', ...file].map((read) => `ws-1 ${read}`));
  });

  it('leaves a file at a commit, an unknown repository, an app path and a build without reserved words to the app', async () => {
    const known = (requested: string) => Promise.resolve(requested === '/api/repos/acme/relay' ? Response.json({ workspaceId: 'ws-1' }) : Response.json({ error: 'Repository not found.' }, { status: 404 }));
    const commit = boot(`/acme/relay/blob/${'a'.repeat(40)}/src/a.ts`, JSON.stringify(manifest), known);
    const missing = boot('/acme/gone', JSON.stringify(manifest), known);
    await settle();
    expect(commit.scopes()).toEqual([' /api/account', ' /api/repos/acme/relay', 'ws-1 /api/state']);
    expect(missing.scopes()).toEqual([' /api/account', ' /api/repos/acme/gone']);
    for (const path of ['/settings/account', '/orgs/acme/teams', '/pull/23', '/Acme/relay']) expect(boot(path).scopes()).toEqual([' /api/account']);
    expect(boot('/acme/relay', null).scopes()).toEqual([' /api/account']);
  });

  it('aborts a stalled account after four seconds while leaving the example snapshot independent', async () => {
    vi.useFakeTimers();
    const result = boot('/example/relay', null, (path) => path === '/api/account' ? new Promise(() => {}) : Promise.resolve(Response.json({ project: 'example' })));
    const account = expect(result.early.account).rejects.toThrow('Account request timed out.');
    await vi.advanceTimersByTimeAsync(3999);
    expect(result.fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
    expect(await (await result.early.reads['demo /api/state']).json()).toEqual({ project: 'example' });
    await vi.advanceTimersByTimeAsync(1);
    await account;
    expect(result.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(result.fetch).toHaveBeenCalledTimes(1 + homeReads.length);
    for (const [, init] of result.fetch.mock.calls.slice(1)) expect(init!.signal).toBeUndefined();
  });

  it('also bounds an account whose headers arrive but whose body stalls', async () => {
    vi.useFakeTimers();
    const result = boot('/', null, async () => ({ clone: () => ({ arrayBuffer: () => new Promise(() => {}) }) } as Response));
    const account = expect(result.early.account).rejects.toThrow('Account request timed out.');
    await vi.advanceTimersByTimeAsync(4000);
    await account;
    expect(result.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('warms the landing CSS without claiming it has applied before the screen import', () => {
    const result = boot('/');
    expect(result.links).toEqual([
      { href: '/landing.js', rel: 'modulepreload', crossOrigin: '' },
      { href: '/landing.css', rel: 'preload', as: 'style', crossOrigin: '' },
    ]);
    expect(result.fetch).toHaveBeenCalledTimes(1);
  });

  it('leaves application of shared route CSS to Vite while downloading each file once', () => {
    const result = boot('/example/relay/pull/7/files', JSON.stringify({ ...manifest,
      pull: ['/pull.js', '/pull.css', '/shared.css'], files: ['/files.js', '/shared.css'],
    }));
    expect(result.links.filter(link => link.href.endsWith('.css'))).toEqual([
      { href: '/pull.css', rel: 'preload', as: 'style', crossOrigin: '' },
      { href: '/shared.css', rel: 'preload', as: 'style', crossOrigin: '' },
    ]);
    expect(result.links.some(link => link.rel === 'stylesheet')).toBe(false);
    expect(result.scopes()).toContain('demo /api/changes/7');
  });

  it.each(['/example/relay/blob/main/src/delivery.ts', '/blob/feature%2Ffix/src/delivery%2Ets'])('preloads file code and only its grammar: %s', (path) => {
    const result = boot(path);
    expect(result.hrefs).toEqual(['/code.js', '/shared.js', '/viewer.js', '/mono.woff2', '/typescript.js']);
  });

  it.each(['/example/relay/blame/main/src/delivery.ts', '/acme/repo/blame/main/README.md'])('preloads blame without the unused viewer, grammar, Markdown parser or workers: %s', (path) => {
    const result = boot(path, JSON.stringify({ ...manifest, worker: '/worker.js' }));
    expect(result.hrefs).toEqual(['/code.js', '/shared.js', '/mono.woff2']);
    expect(result.window.__braidCodeWorkers).toBeUndefined();
  });

  it('reads the merge queue under the resolved scope, with exactly the keys the screen consumes', async () => {
    const result = boot('/acme/repo/queue', JSON.stringify(manifest), path => Promise.resolve(path === '/api/repos/acme/repo' ? Response.json({ workspaceId: 'ws-queue' }) : Response.json({})));
    expect(result.scopes()).toEqual([' /api/account', ' /api/repos/acme/repo']);
    await settle();
    expect(result.scopes().slice(2)).toEqual(['ws-queue /api/state', 'ws-queue /api/queue', 'ws-queue /api/changes?status=queued%2Clanding&limit=50', 'ws-queue /api/policy']);
    expect(result.hrefs).toEqual([]);
  });

  it('starts the exact history page including encoded branch, path and the final cursor', () => {
    const result = boot('/example/relay/commits/feature%2Ffix/src/a%20b.ts?cursor=old&cursor=next%2Fpage');
    expect(result.scopes()).toEqual([' /api/account', 'demo /api/state', 'demo /api/repository/commits?ref=feature%2Ffix&path=src%2Fa%20b.ts&cursor=next%2Fpage']);
    expect(result.hrefs).toEqual([]);
    for (const path of ['/example/relay/commits', '/example/relay/commits/%FF']) {
      // Only a named, decodable ref can be read before the snapshot supplies the default branch.
      expect(boot(path).scopes()).toEqual([' /api/account', 'demo /api/state']);
    }
  });

  it('warms Files changed and its selected file without duplicate dependencies', () => {
    expect(boot('/example/relay/pull/23/files?file=package.json').hrefs).toEqual(['/pull.js', '/files.js', '/shared.js', '/viewer.js', '/json.js']);
  });

  it('loads Markdown rendering for a Markdown file and no unrelated grammar', () => {
    expect(boot('/example/relay/blob/main/README.md').hrefs).toEqual(['/code.js', '/shared.js', '/viewer.js', '/markdown.js']);
  });

  it.each([
    ['/explore?q=relay', ['/explore.js']],
    ['/example/relay/', ['/code.js', '/shared.js', '/markdown.js']],
    ['/example/relay/pulls?state=closed', ['/pulls.js']],
    ['/example/relay/pull/23', ['/pull.js']],
    ['/signin', []],
    ['/example/relay/settings', []],
  ])('only preloads the entry route: %s', (path, expected) => {
    expect(boot(path as string).hrefs).toEqual(expected);
  });

  it('keeps account boot working if metadata is unavailable or malformed', () => {
    for (const metadata of [null, '{']) {
      const result = boot('/', metadata);
      expect(result.fetch).toHaveBeenCalledTimes(1);
      expect(result.hrefs).toEqual([]);
    }
  });

  it('treats unknown and malformed extensions as ordinary lazy viewer loads', () => {
    const result = boot('/example/relay/blob/main/file.%FF');
    expect(result.hrefs).toEqual(['/code.js', '/shared.js', '/viewer.js', '/mono.woff2']);
  });

  it('reads a comparison, then its first three diffs from the merge base it names, warming their grammars', async () => {
    const head = 'b'.repeat(40), base = 'c'.repeat(40);
    const files = ['src/a.ts', 'src/b.json', 'README.md', 'src/d.ts'].map((path) => ({ path }));
    const result = boot('/example/relay/compare/main...feature%2Fretries', JSON.stringify({ ...manifest, worker: '/worker.js' }), (path) => Promise.resolve(path.startsWith('/api/repository/compare?')
      ? Response.json({ status: 'ready', mergeBase: base, head, files }) : Response.json({})));
    expect(result.scopes()).toEqual([' /api/account', 'demo /api/state', 'demo /api/changes?status=active&limit=100', 'demo /api/repository/compare?base=main&head=feature%2Fretries']);
    expect(result.hrefs).toEqual(['/compare.js', '/shared.js', '/viewer.js', '/mono.woff2']);
    expect(result.links.find((link) => link.href === '/mono.woff2')).toEqual({ href: '/mono.woff2', rel: 'preload', as: 'font', crossOrigin: '' });
    expect(result.window.__braidCodeWorkers).toBeUndefined();
    await settle(); await settle();
    // The app takes each over by the path it asks: CompareScreen reads a diff from the merge base to the head.
    const diffs = ['src/a.ts', 'src/b.json', 'README.md'].map((path) => `demo /api/repository/compare/diff?base=${base}&head=${head}&path=${encodeURIComponent(path)}`);
    expect(result.scopes().slice(4)).toEqual(diffs);
    expect(Object.keys(result.early.reads)).toEqual(expect.arrayContaining(diffs));
    expect(result.links.map((link) => link.href).slice(4)).toEqual(['/typescript.js', '/json.js']);
  });

  it('reads no diffs for a comparison that is not ready, and no comparison without both refs', async () => {
    const identical = boot('/example/relay/compare/main...main', JSON.stringify(manifest), (path) => Promise.resolve(path.startsWith('/api/repository/compare?') ? Response.json({ status: 'identical', mergeBase: 'c'.repeat(40), head: 'c'.repeat(40), files: [] }) : Response.json({})));
    await settle(); await settle();
    expect(identical.scopes()).toEqual([' /api/account', 'demo /api/state', 'demo /api/changes?status=active&limit=100', 'demo /api/repository/compare?base=main&head=main']);
    for (const path of ['/example/relay/compare/main', '/example/relay/compare/...main', '/example/relay/compare/%E0%A4%A'])
      expect(boot(path).scopes()).toEqual([' /api/account', 'demo /api/state', 'demo /api/changes?status=active&limit=100']);
  });

  it('starts a code search with the page, by the query its screen asks with', () => {
    const result = boot('/search?q=repo%3Aexample%2Frelay%20delivery');
    expect(result.scopes()).toEqual([' /api/account', ' /api/search?q=repo%3Aexample%2Frelay+delivery']);
    expect(result.hrefs).toEqual(['/search.js', '/mono.woff2']);
    expect(boot('/search?q=%20%20').scopes()).toEqual([' /api/account']);
    expect(boot('/search').hrefs).toEqual(['/search.js', '/mono.woff2']);
  });
});
