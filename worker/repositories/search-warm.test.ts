import { describe, expect, it, vi } from 'vitest';
import { digest } from '../http/auth';
import type { BraidEnv } from '../env';
import { repositorySearch } from './search';
import { SEARCH_WARM_LIMITS, SearchWarmBudget, warmRepositorySearch } from './search-warm';
import { storageFixture } from '../test/storage';
import { publicRepository } from '../test/public-repository';

const view = { repository: 'team:team:repository:workspace', address: '2001:db8:abcd:12:1234:5678:9abc:def0' };
function fixture() {
  const store = storageFixture(), state = { head: 'one' }, owner = {};
  const log = vi.fn(async () => [{ hash: state.head, treeHash: `tree-${state.head}` }] as ArtifactsCommitMetadata[]);
  const readTree = vi.fn(async () => [{ name: 'file.ts', type: 'blob', hash: 'unchanged', mode: '100644' }] as ArtifactsTreeEntry[]);
  const readBlob = vi.fn(async () => new Blob(['needle']));
  const dispose = vi.fn(), repo = { log, readTree, readBlob, [Symbol.dispose]: dispose };
  const get = vi.fn(async () => repo);
  const publicRead = vi.fn(async () => ({ ok: true, data: { teamId: 'team' } }));
  const limit = vi.fn(async () => ({ success: true }));
  const consume = vi.fn(async () => ({ allowed: true }));
  const env = { ARTIFACTS: { get }, DIRECTORY: { idFromName: (name: string) => name, get: () => ({ publicRead }) },
    SECURITY: { idFromName: (name: string) => name, get: () => ({ consume }) }, PUBLIC_EXPENSIVE_LIMITER: { limit } } as unknown as BraidEnv;
  const project = () => ({ id: 'project', branch: 'main', head: state.head });
  const warm = (publicView = false, host = owner) => warmRepositorySearch(host, store.storage, env, project(), publicView ? view : undefined);
  return { ...store, state, owner, repo, get, publicRead, limit, consume, env, project, warm, log, readTree, readBlob, dispose };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('background search budget', () => {
  it('persists deduplication and enforces two view attempts and six total in a rolling hour', () => {
    const f = storageFixture();
    const start = 1_000_000;
    try {
      const claim = (head: string, view: boolean, now = start) => new SearchWarmBudget(f.storage).claim(head, view, now);
      expect(claim('a', true)).toBe(true); expect(claim('a', false)).toBe(false);
      expect(claim('b', true, start + 1)).toBe(true); expect(claim('c', true)).toBe(false);
      for (const head of ['c', 'd', 'e', 'f']) expect(claim(head, false, start + 2)).toBe(true);
      expect(claim('g', false)).toBe(false);
      expect(claim('g', false, start + SEARCH_WARM_LIMITS.window - 1)).toBe(false);
      expect(claim('g', false, start + SEARCH_WARM_LIMITS.window)).toBe(true);
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM search_warm_v1').get()).toEqual({ count: 6 });
    } finally { f.db.close(); }
  });
});

describe('background search builds', () => {
  it('makes the first search warm after object eviction, still resolving the current ref', async () => {
    const f = fixture();
    try {
      await f.warm();
      expect(f.readTree).toHaveBeenCalledTimes(1); expect(f.readBlob).toHaveBeenCalledTimes(1);
      expect(f.dispose).toHaveBeenCalledTimes(1);
      f.readTree.mockClear(); f.readBlob.mockClear();
      expect(await repositorySearch({}, f.repo, { q: 'needle', ref: 'main' }, { storage: f.storage })).toMatchObject({ ref: 'one', matchCount: 1 });
      expect(f.readTree).not.toHaveBeenCalled(); expect(f.readBlob).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledTimes(2);
      await f.warm(false, {});
      expect(f.get).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });

  it('shares a pending build with visitors and foreground searches', async () => {
    const f = fixture(), entered = gate(), waiting = gate();
    const tree = await f.readTree(); f.readTree.mockClear();
    f.readTree.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return tree; });
    try {
      const first = f.warm(true);
      await entered.promise;
      const others = Array.from({ length: 20 }, () => f.warm(true));
      const query = repositorySearch(f.owner, f.repo, { q: 'needle', ref: 'main' }, { storage: f.storage });
      waiting.release();
      await Promise.all([first, ...others]);
      expect(await query).toMatchObject({ matchCount: 1 });
      expect(f.get).toHaveBeenCalledTimes(1); expect(f.limit).toHaveBeenCalledTimes(1);
      expect(f.readTree).toHaveBeenCalledTimes(1); expect(f.readBlob).toHaveBeenCalledTimes(1);
    } finally { waiting.release(); f.db.close(); }
  });

  it('coalesces rapid head changes into one latest pending build and reuses the blob', async () => {
    const f = fixture(), entered = gate(), waiting = gate();
    const tree = await f.readTree(); f.readTree.mockClear();
    f.readTree.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return tree; });
    try {
      const first = f.warm(); await entered.promise;
      for (let i = 0; i < 30; i++) { f.state.head = `next-${i}`; void f.warm(); }
      waiting.release(); await first;
      expect(f.get).toHaveBeenCalledTimes(2);
      expect(f.readTree).toHaveBeenCalledTimes(2); expect(f.readBlob).toHaveBeenCalledTimes(1);
      expect(await repositorySearch({}, f.repo, { q: 'needle', ref: 'main' }, { storage: f.storage })).toMatchObject({ ref: 'next-29', matchCount: 1 });
      expect(f.db.prepare('SELECT head FROM search_heads_v2 ORDER BY head').all()).toEqual([{ head: 'next-29' }, { head: 'one' }]);
    } finally { waiting.release(); f.db.close(); }
  });

  it('caps public-triggered builds and reserves the remaining slots for head changes', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 10; i++) { f.state.head = `view-${i}`; await f.warm(true, {}); }
      expect(f.get).toHaveBeenCalledTimes(2); expect(f.limit).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 10; i++) { f.state.head = `event-${i}`; await f.warm(false, {}); }
      expect(f.get).toHaveBeenCalledTimes(6);
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM search_heads_v2').get()).toEqual({ count: 3 });
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM search_blobs_v2').get()).toEqual({ count: 1 });
      // Exhausting background work does not disable explicitly requested searches.
      expect(await repositorySearch({}, f.repo, { q: 'needle', ref: 'main' }, { storage: f.storage })).toMatchObject({ ref: 'event-9', matchCount: 1 });
    } finally { f.db.close(); }
  });

  it('reauthorizes public views before Artifacts reads and charges the normalized network budget', async () => {
    const f = fixture();
    try {
      await f.warm(true);
      expect(f.publicRead).toHaveBeenCalledWith('workspace');
      expect(f.publicRead.mock.invocationCallOrder[0]).toBeLessThan(f.get.mock.invocationCallOrder[0]);
      expect(f.limit).toHaveBeenCalledWith({ key: await digest('2001:db8:abcd:12::/64') });
      expect(f.limit.mock.invocationCallOrder[0]).toBeLessThan(f.get.mock.invocationCallOrder[0]);
    } finally { f.db.close(); }
  });

  it.each(['private', 'different-team', 'rate-limited'])('does not open Artifacts for a %s view', async reason => {
    const f = fixture();
    try {
      if (reason === 'private') f.publicRead.mockResolvedValue({ ok: false, data: { teamId: 'team' } });
      if (reason === 'different-team') f.publicRead.mockResolvedValue({ ok: true, data: { teamId: 'elsewhere' } });
      if (reason === 'rate-limited') f.limit.mockResolvedValue({ success: false });
      await f.warm(true);
      await f.warm(true, {});
      expect(f.get).not.toHaveBeenCalled();
      expect(f.publicRead).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });

  it('preserves the Security fallback expensive-read budget', async () => {
    const f = fixture();
    try {
      delete f.env.PUBLIC_EXPENSIVE_LIMITER;
      f.consume.mockResolvedValue({ allowed: false });
      await f.warm(true);
      expect(f.consume).toHaveBeenCalledWith(`public-expensive:${await digest('2001:db8:abcd:12::/64')}`, 60, 60_000);
      expect(f.get).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it('shares the exact budget already spent by anonymous search through the gateway', async () => {
    const published = await publicRepository(), f = storageFixture(), get = vi.fn();
    try {
      delete published.env.PUBLIC_EXPENSIVE_LIMITER;
      published.env.ARTIFACTS = { get } as unknown as BraidEnv['ARTIFACTS'];
      for (let i = 0; i < 60; i++) expect((await published.anonymous('/api/repository/search?q=needle')).status).toBe(200);
      await warmRepositorySearch({}, f.storage, published.env, { id: 'project', head: published.base, branch: 'main' }, { repository: 'team:t:repository:w', address: '198.51.100.7' });
      expect(get).not.toHaveBeenCalled();
    } finally { f.db.close(); await published.close(); }
  });

  it('charges failed attempts across eviction and lets explicit searches retry', async () => {
    const f = fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.readBlob.mockRejectedValueOnce(new Error('upstream secret must not be logged'));
      await f.warm(); await f.warm(false, {});
      expect(f.get).toHaveBeenCalledTimes(1); expect(f.dispose).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(JSON.stringify({ event: 'search_prebuild_failed', error: 'Error' }));
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM search_heads_v2').get()).toEqual({ count: 0 });
      expect(await repositorySearch({}, f.repo, { q: 'needle', ref: 'main' }, { storage: f.storage })).toMatchObject({ matchCount: 1 });
    } finally { warning.mockRestore(); f.db.close(); }
  });

  it('resolves main at execution time instead of trusting a captured head or a page ref', async () => {
    const f = fixture();
    try {
      const warm = f.warm(); f.state.head = 'moved'; await warm;
      expect(f.log).toHaveBeenCalledWith({ ref: 'main', limit: 1 });
      expect(f.db.prepare('SELECT head FROM search_heads_v2').all()).toEqual([{ head: 'moved' }]);
    } finally { f.db.close(); }
  });
});
