import { afterEach, describe, expect, it, vi } from 'vitest';
import api from '../http/api';
import { Directory } from '../accounts/directory';
import { Security } from '../accounts/security';
import { Workspace } from '../workspace/workspace';
import type { BraidEnv } from '../env';
import { storageFixture } from '../test/storage';
import { edgeCache } from '../test/edge-cache';
import { exampleMain, recordedExample, type ExampleState } from '../changes/demo';
import { historyRequest, recordedHistory } from './history';
import { recordedCommit } from './commit';
import type { CommitDetail, CommitDiff, CommitPage } from '../../shared/history';
import type { RepositoryFile, RepositoryTree } from '../../shared/repository';
import type { FileBlame, Provenance } from '../../shared/types';

const ledger = 'src/billing/ledger.ts';
const opened = Date.parse('2026-10-13T09:05:00Z');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Exercise the real gateway and demo workspace, including the shared-copy edge cache. */
async function fixture() {
  const directoryStore = storageFixture(), securityStore = storageFixture();
  const directory = new Directory(directoryStore.ctx, {} as BraidEnv), security = new Security(securityStore.ctx, {} as BraidEnv);
  const stores = [directoryStore, securityStore], workspaces = new Map<string, Promise<Workspace>>();
  const forwarded: { workspace: string; url: string }[] = [];
  const workspace = (name: string) => {
    if (!workspaces.has(name)) {
      const store = storageFixture(); stores.push(store);
      const instance = new Workspace(store.ctx, env);
      workspaces.set(name, store.ready().then(() => instance));
    }
    return workspaces.get(name)!;
  };
  const env = {
    AUTH_MODE: 'github', SESSION_SECRET: 'strong-session-secret-for-branch-tests', LIVE_ENABLED: 'true',
    PUBLIC_ORIGIN: 'https://braid.example', BUILD_ID: 'branch-first',
    DIRECTORY: { idFromName: (name: string) => name, get: () => directory },
    SECURITY: { idFromName: (name: string) => name, get: () => security },
    WORKSPACES: { idFromName: (name: string) => name, get: (name: string) => ({
      fetch: async (request: Request) => {
        forwarded.push({ workspace: name, url: request.url });
        return (await workspace(name)).fetch(request);
      },
      exampleState: async () => (await workspace(name)).exampleState(),
    }) },
    ASSETS: { fetch: () => new Response('') },
  } as unknown as BraidEnv;
  await Promise.all(stores.map(store => store.ready()));
  const cache = edgeCache();
  const get = (path: string) => api.fetch(new Request(`https://braid.example${path}`, { headers: { 'x-braid-workspace': 'demo', 'cf-connecting-ip': '198.51.100.7' } }), env);
  const json = async <T>(path: string): Promise<T> => {
    const response = await get(path); expect(response.status).toBe(200);
    return await response.json() as T;
  };
  return { env, cache, forwarded, get, json, close: () => stores.forEach(store => store.db.close()) };
}

describe('recorded proposal branch readers', () => {
  it('pins Code and folder trees to the branch tip for names and commit hashes', async () => {
    const f = await fixture();
    try {
      const branch = (await recordedExample()).branch('refund-rounding')!;
      for (const ref of [branch.name, `refs/heads/${branch.name}`, branch.tip.hash, branch.tip.hash.slice(0, 7)]) {
        const response = await f.get(`/api/repository/tree?ref=${encodeURIComponent(ref)}`);
        expect(response.headers.get('x-braid-ref')).toBe(branch.tip.hash);
        const tree = await response.json() as RepositoryTree;
        expect(tree).toMatchObject({ ref: branch.tip.hash, path: '', nextCursor: null });
        expect(tree.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src', kind: 'dir' })]));
        const folder = await f.json<RepositoryTree>(`/api/repository/tree?ref=${encodeURIComponent(ref)}&path=src/billing`);
        expect(folder).toMatchObject({ ref: branch.tip.hash, path: 'src/billing', entries: [expect.objectContaining({ path: ledger, kind: 'file' })] });
      }
    } finally { f.close(); }
  });

  it('serves the branch patch, directory detection and download without substituting main', async () => {
    const f = await fixture();
    try {
      const branch = (await recordedExample()).branch('refund-rounding')!;
      const file = await f.json<RepositoryFile>(`/api/repository?ref=${branch.name}&path=${ledger}`);
      expect(file).toEqual({ ref: branch.tip.hash, path: ledger, content: branch.files[ledger] });
      expect(file.content).toContain('Math.round');
      const main = await f.json<RepositoryFile>(`/api/repository?ref=main&path=${ledger}`);
      expect(main).toMatchObject({ ref: exampleMain().head, content: expect.stringContaining('Math.floor') });
      expect(await f.json('/api/repository?ref=refund-rounding&path=src/billing')).toEqual({ ref: branch.tip.hash, path: 'src/billing', kind: 'dir', content: '' });
      const download = await f.get(`/api/repository?ref=${branch.tip.hash}&path=${ledger}&download=1`);
      expect(download.headers.get('x-braid-ref')).toBe(branch.tip.hash);
      expect(download.headers.get('content-disposition')).toContain('ledger.ts');
      expect(await download.text()).toBe(branch.files[ledger]);
    } finally { f.close(); }
  });

  it('shows the real branch commit, parent and patch while its proposal remains open', async () => {
    const f = await fixture();
    try {
      const example = await recordedExample(), branch = example.branch('refund-rounding')!, source = example.change(branch.changeId);
      for (const sha of [branch.tip.hash, branch.tip.hash.slice(0, 7).toUpperCase()]) {
        const detail = await f.json<CommitDetail>(`/api/repository/commit?sha=${sha}`);
        expect(detail).toMatchObject({ hash: branch.tip.hash, title: source.title, message: `${source.title}\n\n${source.summary}`, parents: [branch.base],
          author: source.author, pullRequest: 7, filesTruncated: false, parentUnavailable: false,
          files: [{ path: ledger, status: 'modified', additions: 1, deletions: 1, binary: false, tooLarge: false }] });
        expect(await f.json<CommitDiff>(`/api/repository/commit/diff?sha=${sha}&path=${ledger}`))
          .toMatchObject({ before: exampleMain().files[ledger], after: branch.files[ledger], binary: false, tooLarge: false });
      }
      const history = await f.json<CommitPage>('/api/repository/commits?ref=refund-rounding');
      expect(history.ref).toBe(branch.tip.hash);
      expect(history.items[0]).toMatchObject({ hash: branch.tip.hash, title: source.title, author: source.author, pullRequest: 7 });
      expect(history.items[1].hash).toBe(branch.base);
      expect(example.change('7').status).toBe('attention');
      expect(example.change('7').landedCommit).toBeUndefined();
      const main = await f.json<CommitPage>('/api/repository/commits?ref=main');
      expect(main.items[0]).toMatchObject({ hash: exampleMain().head, pullRequest: 51 });
      expect(main.items.some(commit => commit.hash === branch.tip.hash)).toBe(false);
    } finally { f.close(); }
  });

  it('attributes the branch line to its proposal without claiming it landed, preserving unchanged blame', async () => {
    const f = await fixture();
    try {
      const example = await recordedExample(), branch = example.branch('refund-rounding')!;
      const blame = await f.json<FileBlame>(`/api/blame?ref=${branch.name}&path=${ledger}`);
      expect(blame).toMatchObject({ ref: branch.tip.hash, path: ledger, ranges: [expect.objectContaining({ start: 1, lines: 1,
        provenance: expect.objectContaining({ commit: branch.tip.hash, confidence: 'inferred', change: expect.objectContaining({ number: 7 }), agent: expect.objectContaining({ name: 'GPT-6 Astra' }) }) })] });
      expect(await f.json(`/api/blame?ref=${branch.tip.hash}&path=${ledger}`)).toEqual(blame);
      const branchUnchanged = await f.json<FileBlame>(`/api/blame?ref=${branch.name}&path=src/delivery.ts`);
      const mainUnchanged = await f.json<FileBlame>('/api/blame?ref=main&path=src/delivery.ts');
      expect(branchUnchanged).toEqual({ ...mainUnchanged, ref: branch.tip.hash });
      const provenance = await f.json<Provenance[]>(`/api/provenance?commits=${branch.tip.hash}`);
      expect(provenance).toEqual([blame.ranges[0].provenance]);
    } finally { f.close(); }
  });

  it('rejects unknown revisions and missing files instead of falling back to main', async () => {
    const f = await fixture();
    try {
      const branch = (await recordedExample()).branch('refund-rounding')!;
      for (const path of [
        '/api/repository/tree?ref=missing', `/api/repository?ref=missing&path=${ledger}`,
        '/api/repository?ref=refund-rounding&path=missing.ts', `/api/blame?ref=missing&path=${ledger}`,
        '/api/repository/commits?ref=missing', '/api/repository/commit?sha=0000000',
        `/api/repository/commit/diff?sha=${branch.tip.hash}&path=missing.ts`,
      ]) expect((await f.get(path)).status, path).toBe(404);
    } finally { f.close(); }
  });

  it('keeps branch history and blame pinned when an approval moves main later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(opened);
    const example = await recordedExample(), state: ExampleState = { since: opened, decisions: {}, changes: [] };
    const branch = example.branch('refund-rounding', state)!;
    const history = (ref: string, path = '') => recordedHistory(example, state, historyRequest(new URLSearchParams({ ref, path }), 'main'));
    const before = { branch, history: history(branch.name), blame: example.blame(ledger, state, branch.name), commit: recordedCommit(example, state, branch.tip.hash) };
    const refund = example.change('7', state);
    state.decisions[refund.id] = { action: 'approve', revision: refund.revision, at: opened };
    vi.setSystemTime(opened + 11_000);
    const moved = example.change('7', state);
    expect(moved.status).toBe('landed');
    expect(history('main').items.slice(0, 2).map(commit => commit.hash)).toEqual([moved.landedCommit, branch.base]);
    expect(recordedCommit(example, state, moved.landedCommit!).parents).toEqual([branch.base]);
    expect({ branch: example.branch(branch.name, state), history: history(branch.name), blame: example.blame(ledger, state, branch.name), commit: recordedCommit(example, state, branch.tip.hash) }).toEqual(before);
    expect(history(branch.name, ledger).items.map(commit => commit.hash)).toEqual([branch.tip.hash]);
    expect(example.blame(ledger, state, branch.base).ranges.some(range => range.provenance.commit === moved.landedCommit)).toBe(false);
  });

  it('paginates the branch ancestry once, with cursors bound to the branch and path', async () => {
    const example = await recordedExample(), state = { since: opened, decisions: {}, changes: [] };
    const branch = example.branch('refund-rounding', state)!;
    const first = recordedHistory(example, state, historyRequest(new URLSearchParams({ ref: branch.name }), 'main'));
    expect(first.nextCursor).not.toBeNull();
    const query = new URLSearchParams({ ref: branch.name, cursor: first.nextCursor! });
    const second = recordedHistory(example, state, historyRequest(query, 'main'));
    expect(second.ref).toBe(branch.tip.hash);
    const commits = [...first.items, ...second.items].map(commit => commit.hash);
    expect(new Set(commits).size).toBe(commits.length);
    expect(commits).toHaveLength(example.changes({ statuses: ['landed'], limit: 100 }, state).items.length + 1);
    query.set('ref', 'main'); expect(() => historyRequest(query, 'main')).toThrow('another branch or path');
  });

  it('keeps an untouched copy identical after hours without advancing the branch or main', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(opened);
    const example = await recordedExample(), state = { since: opened, decisions: {}, changes: [] };
    const branch = example.branch('refund-rounding', state)!;
    const snapshot = () => ({ branch: example.branch(branch.name, state), commit: recordedCommit(example, state, branch.tip.hash),
      history: recordedHistory(example, state, historyRequest(new URLSearchParams({ ref: branch.name }), 'main')), blame: example.blame(ledger, state, branch.name) });
    const before = snapshot();
    for (const elapsed of [11_000, 3_600_000, 86_400_000]) { vi.setSystemTime(opened + elapsed); expect(snapshot()).toEqual(before); }
  });

  it('separates cached branches, commits and paths across deploys without changing a shared copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(opened);
    const f = await fixture();
    try {
      const branch = (await recordedExample()).branch('refund-rounding')!;
      const paths = [`/api/repository?ref=main&path=${ledger}`, `/api/repository?ref=${branch.name}&path=${ledger}`,
        `/api/repository?ref=${branch.tip.hash}&path=${ledger}`, `/api/repository?ref=${branch.tip.hash}&path=README.md`, `/api/repository/tree?ref=${branch.tip.hash}&path=src/billing`];
      const before = [];
      for (const path of paths) before.push(await f.json(path));
      const reads = f.forwarded.length;
      vi.setSystemTime(opened + 11_000);
      for (const [index, path] of paths.entries()) expect(await f.json(path)).toEqual(before[index]);
      expect(f.forwarded).toHaveLength(reads);
      const prefix = `https://example.braid.invalid/${Math.floor(opened / 3_600_000)}.`;
      expect([...f.cache.keys()]).toEqual(paths.map(path => `${prefix}branch-first${path}`));
      f.env.BUILD_ID = 'branch-second';
      for (const path of paths) await f.json(path);
      expect(f.forwarded).toHaveLength(reads * 2);
      expect([...f.cache.keys()]).toEqual(['branch-first', 'branch-second'].flatMap(build => paths.map(path => `${prefix}${build}${path}`)));
      expect(new Set(f.forwarded.map(read => read.workspace)).size).toBe(2);
    } finally { f.close(); }
  });
});
