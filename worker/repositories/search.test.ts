import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RepositorySearch } from '../../shared/search';
import type { WorkspaceSnapshot } from '../../shared/types';
import { agentPathAllowed, publicPathAllowed } from '../http/agent-auth';
import type { BraidEnv } from '../env';
import { recordedSearch, repositorySearch, searchRequest, SEARCH_LIMITS } from './search';
import { seedWorkspace } from '../workspace/seed';
import { startGitServer } from '../test/git-server';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';
import { Timings } from '../http/timing';

let git: Awaited<ReturnType<typeof startGitServer>>;
let head: string, other: string;
const files = {
  'README.md': '# Relay\r\nDelivery to an endpoint\r\n',
  'src/delivery.ts': 'export function deliver() {\n  return "Delivery DELIVERY";\n}\n',
  'test/literal.txt': 'İ 😀 a.[b] + $dollar \\ slash\nLast Delivery',
  'owner@example.test.txt': 'Contact owner@example.test\n',
};
const query = (q: string, ref = 'main') => searchRequest(new URLSearchParams({ q, ref }), 'main');
const search = (q: string, ref = head, owner = {}) => repositorySearch(owner, git.repository, query(q, ref));
const observedRepo = () => ({ ...git.repository, readBlob: vi.fn(git.repository.readBlob), readTree: vi.fn(git.repository.readTree), log: vi.fn(git.repository.log) });
const commitTree = (rows: string[]) => git.native(['commit-tree', git.native(['mktree'], rows.join('')).trim()], 'Search fixture\n').trim();
const blob = (text: string) => git.native(['hash-object', '-w', '--stdin'], text).trim();

beforeAll(async () => {
  git = await startGitServer();
  head = git.commitTree(files);
  other = git.commitTree({ 'README.md': 'Only on the feature branch\n' }, head);
  git.native(['update-ref', 'refs/heads/main', head]);
  git.native(['update-ref', 'refs/heads/feature/search', other]);
}, 30_000);
afterAll(async () => { await git?.close(); });

describe('code search against real Git', () => {
  it('groups case-insensitive literal occurrences by file and line, with filename matches separately', async () => {
    const result = await search('delivery');
    expect(result).toMatchObject({ ref: head, matchCount: 4, truncated: false, files: [{ path: 'src/delivery.ts', highlights: [{ start: 4, end: 12 }] }] });
    expect(result.results.map(file => file.path)).toEqual(['README.md', 'src/delivery.ts', 'test/literal.txt']);
    expect(result.results[0].matches).toEqual([{ line: 2, content: 'Delivery to an endpoint', highlights: [{ start: 0, end: 8 }] }]);
    expect(result.results[1].matches).toEqual([{ line: 2, content: '  return "Delivery DELIVERY";', highlights: [{ start: 10, end: 18 }, { start: 19, end: 27 }] }]);
    expect(result.results[2].matches[0].line).toBe(2);
  });

  it('treats regexp punctuation literally and keeps Unicode highlight offsets correct', async () => {
    for (const text of ['a.[b]', '$dollar', '\\', '+', '😀']) {
      const result = await search(text);
      expect(result.matchCount).toBe(1);
      const row = result.results[0].matches[0], range = row.highlights[0];
      expect(row.content.slice(range.start, range.end)).toBe(text);
    }
    expect((await search('not here')).results).toEqual([]);
  });

  it('reads the requested branch or immutable commit and rejects missing revisions', async () => {
    expect(await search('feature', 'feature/search')).toMatchObject({ ref: other, matchCount: 1 });
    expect(await search('feature', head)).toMatchObject({ ref: head, matchCount: 0 });
    await expect(search('delivery', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('skips generated and vendored subtrees, lockfiles, minified files, binary and large content', async () => {
    const skipped = ['node_modules/pkg/x.ts', 'dist/x.ts', 'nested/build/x.ts', 'vendor/x.ts', '__generated__/x.ts', '.next/x.ts', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'bundle.min.js', 'style.min.css', 'x.js.map', 'image.png'];
    const ref = git.commitTree({ ...Object.fromEntries(skipped.map(path => [path, 'NEEDLE'])), 'binary.dat': 'NEEDLE\0data', 'too-big.txt': `NEEDLE${'x'.repeat(SEARCH_LIMITS.fileBytes)}`, 'keep.ts': 'NEEDLE' });
    const repo = observedRepo();
    const result = await repositorySearch({}, repo, query('NEEDLE', ref));
    expect(result.results.map(file => file.path)).toEqual(['keep.ts']);
    expect(result.matchCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(repo.readBlob).toHaveBeenCalledTimes(3);
    expect(repo.readTree).toHaveBeenCalledTimes(2); // Root and nested; none of the generated subtrees.
  });

  it('skips invalid UTF-8, symlinks and submodules while searching executable files', async () => {
    const raw = git.native(['hash-object', '-w', '--stdin'], Buffer.from([0xff, 0xfe, 0x61])).trim();
    const text = blob('needle'), ref = commitTree([`100644 blob ${raw}\tbad.txt\n`, `100755 blob ${text}\trun.sh\n`, `120000 blob ${text}\tlink\n`, `160000 commit ${head}\tmodule\n`]);
    const repo = observedRepo();
    expect((await repositorySearch({}, repo, query('needle', ref))).results.map(file => file.path)).toEqual(['run.sh']);
    expect(repo.readBlob).toHaveBeenCalledTimes(2);
  });

  it('caps occurrences at 100 including many matches on one line, and reports only real truncation', async () => {
    const exact = git.commitTree({ 'many.txt': 'needle '.repeat(SEARCH_LIMITS.matches) });
    expect(await search('needle', exact)).toMatchObject({ matchCount: 100, truncated: false });
    const over = git.commitTree({ 'many.txt': 'needle '.repeat(SEARCH_LIMITS.matches + 1) });
    const result = await search('needle', over);
    expect(result).toMatchObject({ matchCount: 100, truncated: true });
    expect(result.results[0].matches.reduce((count, match) => count + match.highlights.length, 0)).toBe(100);
    expect(result.results[0].matches.every(match => match.line === 1 && match.content.length <= SEARCH_LIMITS.snippet + 2)).toBe(true);
  });

  it('keeps a long literal intact in a short excerpt far into a line', async () => {
    const term = 'Z'.repeat(256), ref = git.commitTree({ 'long.txt': `${'a'.repeat(2000)}${term}${'b'.repeat(2000)}\n` });
    const row = (await search(term, ref)).results[0].matches[0];
    expect(row.content.startsWith('…')).toBe(true);
    expect(row.content.endsWith('…')).toBe(true);
    expect(row.content.length).toBeLessThanOrEqual(SEARCH_LIMITS.snippet + 2);
    expect(row.content.slice(row.highlights[0].start, row.highlights[0].end)).toBe(term);
  });

  it('bounds indexed files and filename results, sharing repeated Git blobs', async () => {
    const hash = blob('plain text'), ref = commitTree(Array.from({ length: SEARCH_LIMITS.files + 1 }, (_, i) => `100644 blob ${hash}\tfile-${String(i).padStart(4, '0')}.txt\n`));
    const repo = observedRepo(), owner = {};
    const result = await repositorySearch(owner, repo, query('file-', ref));
    expect(result).toMatchObject({ truncated: true, matchCount: 0 });
    expect(result.files).toHaveLength(SEARCH_LIMITS.filenames);
    expect(repo.readBlob).toHaveBeenCalledTimes(1);
    expect(await repositorySearch(owner, repo, query('file-1000', ref))).toMatchObject({ files: [], truncated: true });
  });

  it('bounds bytes read and still returns filename matches after the byte budget is exhausted', async () => {
    const contents = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`file-${String(i).padStart(2, '0')}.txt`, `${i} needle `.padEnd(SEARCH_LIMITS.fileBytes, 'x')]));
    const ref = git.commitTree(contents), repo = observedRepo(), owner = {};
    const result = await repositorySearch(owner, repo, query('needle', ref));
    expect(result).toMatchObject({ matchCount: 16, truncated: true });
    expect(repo.readBlob).toHaveBeenCalledTimes(16);
    expect((await repositorySearch(owner, repo, query('file-19', ref))).files).toHaveLength(1);
  }, 30_000);

  it('bounds deep traversal and the number of tree entries even without searchable files', async () => {
    const deep = git.commitTree({ [`${'nested/'.repeat(SEARCH_LIMITS.depth + 1)}file.txt`]: 'needle' });
    const reader = observedRepo();
    expect(await repositorySearch({}, reader, query('needle', deep))).toMatchObject({ results: [], truncated: true });
    expect(reader.readTree).toHaveBeenCalledTimes(SEARCH_LIMITS.depth + 1);
    const hash = blob('needle');
    const links = git.native(['mktree'], Array.from({ length: SEARCH_LIMITS.entries / 2 + 1 }, (_, i) => `120000 blob ${hash}\tlink-${String(i).padStart(5, '0')}\n`).join('')).trim();
    const wide = commitTree([`040000 tree ${links}\ta\n`, `040000 tree ${links}\tb\n`]);
    expect(await search('needle', wide)).toMatchObject({ results: [], truncated: true });
  }, 30_000);

  it('counts duplicate blob contents toward the scan budget without reading them again', async () => {
    const hash = blob('needle'.padEnd(SEARCH_LIMITS.fileBytes, 'x'));
    const ref = commitTree(Array.from({ length: 20 }, (_, i) => `100644 blob ${hash}\tfile-${String(i).padStart(2, '0')}.txt\n`));
    const repo = observedRepo();
    expect(await repositorySearch({}, repo, query('needle', ref))).toMatchObject({ matchCount: 16, truncated: true });
    expect(repo.readBlob).toHaveBeenCalledTimes(1);
  });

  it('handles Artifacts memory limits without returning a false complete result', async () => {
    const repo = observedRepo();
    repo.readBlob.mockRejectedValueOnce(Object.assign(new Error('too big'), { code: 'MEMORY_LIMIT' }));
    expect(await repositorySearch({}, repo, query('delivery'))).toMatchObject({ truncated: true, matchCount: 3 });
  });

  it('shares concurrent scans, reuses blobs for a different query and isolates Durable Objects', async () => {
    const repo = observedRepo(), owner = {};
    await Promise.all([repositorySearch(owner, repo, query('delivery')), repositorySearch(owner, repo, query('endpoint'))]);
    expect(repo.readBlob).toHaveBeenCalledTimes(4);
    repo.readBlob.mockClear(); repo.readTree.mockClear();
    expect((await repositorySearch(owner, repo, query('export'))).matchCount).toBe(1);
    expect(repo.readBlob).not.toHaveBeenCalled(); expect(repo.readTree).not.toHaveBeenCalled();
    await repositorySearch({}, repo, query('export'));
    expect(repo.readBlob).toHaveBeenCalledTimes(4);
  });

  it('resolves a moving branch again and evicts the least recently used head', async () => {
    const repo = observedRepo(), owner = {};
    git.native(['update-ref', 'refs/heads/moving', head]);
    expect((await repositorySearch(owner, repo, query('feature', 'moving'))).matchCount).toBe(0);
    git.native(['update-ref', 'refs/heads/moving', other]);
    expect((await repositorySearch(owner, repo, query('feature', 'moving'))).matchCount).toBe(1);
    const more = [git.commitTree({ 'a.txt': 'three' }), git.commitTree({ 'b.txt': 'four' })];
    await repositorySearch(owner, repo, query('three', more[0]));
    await repositorySearch(owner, repo, query('delivery', head)); // Touch the oldest head.
    await repositorySearch(owner, repo, query('four', more[1]));
    repo.readBlob.mockClear();
    await repositorySearch(owner, repo, query('delivery', head));
    expect(repo.readBlob).not.toHaveBeenCalled();
    await repositorySearch(owner, repo, query('feature', other));
    expect(repo.readBlob).toHaveBeenCalledTimes(4);
  });

  it('retries incomplete reads instead of caching a failed scan', async () => {
    const repo = observedRepo(), owner = {};
    repo.readBlob.mockResolvedValueOnce(null);
    await expect(repositorySearch(owner, repo, query('delivery'))).rejects.toMatchObject({ status: 503 });
    expect((await repositorySearch(owner, repo, query('delivery'))).matchCount).toBe(4);
  });

  it('overlaps tree and blob reads within one bounded wave and keeps deterministic results', async () => {
    const ref = git.commitTree(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`dir-${i}/file.ts`, `needle ${i}`])));
    const active = { tree: 0, blob: 0 }, peak = { tree: 0, blob: 0 };
    const observe = <T,>(kind: 'tree' | 'blob', read: (hash: string) => Promise<T>) => async (hash: string) => {
      peak[kind] = Math.max(peak[kind], ++active[kind]);
      await Promise.resolve();
      try { return await read(hash); } finally { active[kind]--; }
    };
    const repo = { ...git.repository, readTree: observe('tree', git.repository.readTree), readBlob: observe('blob', git.repository.readBlob) };
    const result = await repositorySearch({}, repo, query('needle', ref));
    expect(result.matchCount).toBe(24);
    expect(result.results.map(file => file.path)).toEqual(result.results.map(file => file.path).sort());
    expect(peak).toEqual({ tree: SEARCH_LIMITS.concurrency, blob: SEARCH_LIMITS.concurrency });
    expect(active).toEqual({ tree: 0, blob: 0 });
  });

  it('waits for sibling reads before rejecting a failed batch', async () => {
    const repo = observedRepo();
    let active = 0, calls = 0;
    repo.readBlob.mockImplementation(async hash => {
      const call = ++calls;
      active++;
      try {
        await Promise.resolve();
        if (call === 1) throw new Error('Artifacts unavailable');
        await Promise.resolve(); await Promise.resolve();
        return await git.repository.readBlob(hash);
      } finally { active--; }
    });
    await expect(repositorySearch({}, repo, query('delivery'))).rejects.toThrow('Artifacts unavailable');
    expect(active).toBe(0);
  });

  it('recovers a durable index after object eviction without tree or blob reads, but always resolves the ref', async () => {
    const store = storageFixture(), repo = observedRepo();
    try {
      const coldTimings = new Timings(), warmTimings = new Timings();
      const cold = await repositorySearch({}, repo, query('delivery'), { storage: store.storage, timings: coldTimings });
      repo.readBlob.mockClear(); repo.readTree.mockClear();
      const warm = await repositorySearch({}, repo, query('delivery'), { storage: store.storage, timings: warmTimings });
      expect(warm).toEqual(cold);
      expect(repo.readBlob).not.toHaveBeenCalled(); expect(repo.readTree).not.toHaveBeenCalled();
      expect(repo.log).toHaveBeenCalledTimes(2);
      expect(coldTimings.header()).toMatch(/search-head;dur=\d+.*search-tree;dur=\d+.*search-blobs;dur=\d+.*search-index;dur=\d+.*search-match;dur=\d+/);
      expect(warmTimings.header()).not.toMatch(/search-tree|search-blobs/);
      expect(await repositorySearch({}, repo, query('feature', other), { storage: store.storage })).toMatchObject({ ref: other, matchCount: 1 });
    } finally { store.db.close(); }
  });

  it('never persists a failed read as a complete index', async () => {
    const store = storageFixture(), repo = observedRepo();
    try {
      repo.readBlob.mockResolvedValueOnce(null);
      await expect(repositorySearch({}, repo, query('delivery'), { storage: store.storage })).rejects.toMatchObject({ status: 503 });
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM search_heads_v2').get()).toEqual({ count: 0 });
      expect(await repositorySearch({}, repo, query('delivery'), { storage: store.storage })).toMatchObject({ matchCount: 4 });
    } finally { store.db.close(); }
  });

  it.runIf(process.env.BRAID_SEARCH_BENCHMARK === '1')('measures cold and warm searches on the same real Git head', async () => {
    const ref = git.commitTree(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`source-${i}.ts`, `export const value${i} = 'needle';\n`.repeat(100)])));
    const repo = observedRepo(), owner = {}, start = performance.now();
    await repositorySearch(owner, repo, query('absent-cold', ref));
    const coldMs = performance.now() - start;
    repo.readBlob.mockClear(); repo.readTree.mockClear();
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      await repositorySearch(owner, repo, query(`absent-warm-${i}`, ref));
      warm.push(performance.now() - started);
    }
    expect(repo.readBlob).not.toHaveBeenCalled(); expect(repo.readTree).not.toHaveBeenCalled();
    console.info('Search benchmark (real Git, 80 files):', JSON.stringify({ coldMs, warmMs: warm, warmMedianMs: [...warm].sort((a, b) => a - b)[2] }));
  }, 30_000);
});

describe('search API boundaries, access and recorded example', () => {
  it('validates query length, control characters and refs at the boundary', () => {
    for (const q of ['', 'a'.repeat(257), 'one\ntwo', 'x\0y', 'x\ty']) expect(() => searchRequest(new URLSearchParams({ q }), 'main')).toThrow();
    expect(() => searchRequest(new URLSearchParams(), 'main')).toThrow();
    for (const ref of ['', 'main..other', 'main^', 'x\ny']) expect(() => query('text', ref)).toThrow();
    expect(searchRequest(new URLSearchParams({ q: 'literal [text]' }), 'trunk')).toEqual({ q: 'literal [text]', ref: 'trunk' });
  });

  it('allows public GET/HEAD and agent reads, without enabling writes', () => {
    expect(publicPathAllowed('/api/repository/search', 'GET')).toBe(true);
    expect(publicPathAllowed('/api/repository/search', 'HEAD')).toBe(true);
    expect(agentPathAllowed('/api/repository/search', 'GET', 'read')).toBe(true);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect(publicPathAllowed('/api/repository/search', method)).toBe(false);
      expect(agentPathAllowed('/api/repository/search', method, 'work')).toBe(false);
    }
  });

  it('charges public search to the expensive-read budget and preserves published code and offsets', async () => {
    const f = await publicRepository();
    try {
      const result = await search('owner@example.test');
      const read = vi.fn(async () => Response.json(result));
      f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => ({ fetch: read }) } as unknown as BraidEnv['WORKSPACES'];
      const url = '/api/repository/search?q=owner%40example.test';
      expect(await (await f.anonymous(url)).json()).toEqual(result);
      for (let i = 1; i < 60; i++) expect((await f.anonymous(url)).status).toBe(200);
      const limited = await f.anonymous(url);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(read).toHaveBeenCalledTimes(60);
    } finally { await f.close(); }
  });

  it('serves live requests, validates before opening Artifacts, and shares the workspace cache', async () => {
    const store = storageFixture(), repo = observedRepo(), dispose = vi.fn();
    const get = vi.fn(async () => ({ ...repo, [Symbol.dispose]: dispose }));
    const env = { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true', ARTIFACTS: { get } } as unknown as BraidEnv;
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
    seed.project = { ...seed.project, id: 'project', head, branch: 'main' };
    await store.storage.put('workspace', seed);
    const workspace = new Workspace(store.ctx, env); await store.ready();
    const request = (qs: string) => workspace.fetch(new Request(`https://braid.test/api/repository/search?${qs}`, { headers: { 'x-braid-mode': 'live' } }));
    try {
      expect((await request('q=')).status).toBe(400);
      expect(get).not.toHaveBeenCalled();
      expect(await (await request('q=delivery')).json()).toMatchObject({ matchCount: 4, ref: head });
      repo.readBlob.mockClear();
      expect(await (await request('q=endpoint')).json()).toMatchObject({ matchCount: 1, ref: head });
      expect(repo.readBlob).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(2);
    } finally { store.db.close(); }
  });

  it('searches the recorded workspace files without Artifacts and never fabricates another ref', async () => {
    const store = storageFixture(), workspace = new Workspace(store.ctx, {} as BraidEnv); await store.ready();
    const request = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': 'demo' } }));
    try {
      const snapshot = await (await request('/api/state')).json() as WorkspaceSnapshot;
      const response = await request('/api/repository/search?q=delivery');
      expect(response.status).toBe(200);
      const result = await response.json() as RepositorySearch;
      expect(result).toEqual(recordedSearch(snapshot.files, snapshot.project.head, 'delivery'));
      expect(result.matchCount).toBeGreaterThan(0);
      expect((await request('/api/repository/search?q=delivery&ref=missing')).status).toBe(404);
    } finally { store.db.close(); }
  });

  it('applies exclusion, size and match limits to demo files too', () => {
    const result = recordedSearch({ 'src/needle.ts': 'Needle\n'.repeat(101), 'node_modules/package/index.ts': 'Needle', 'large.txt': 'Needle'.repeat(SEARCH_LIMITS.fileBytes), 'binary.bin': '\0Needle' }, head, 'needle');
    expect(result).toMatchObject({ ref: head, matchCount: 100, truncated: true, files: [{ path: 'src/needle.ts' }] });
    expect(result.results.map(file => file.path)).toEqual(['src/needle.ts']);
  });
});
