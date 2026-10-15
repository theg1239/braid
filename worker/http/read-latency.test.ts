import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api';
import type { BraidEnv } from '../env';
import { edgeCache } from '../test/edge-cache';

const pause = async () => { if (process.env.BRAID_READ_BENCHMARK === '1') await new Promise(resolve => setTimeout(resolve, 40)); };
function fixture() {
  edgeCache();
  let revision = 1;
  const publicRead = vi.fn(async () => { await pause(); return { ok: true, data: { teamId: 'team', ownerSlug: 'owner', repoSlug: 'repo' } }; });
  const fetch = vi.fn(async () => {
    await pause();
    return Response.json({ project: { head: String(revision) }, missions: [], files: {}, capabilities: { mode: 'live' } }, { headers: { etag: `"state-${revision}"` } });
  });
  const touching = vi.fn(async () => { await pause(); return {}; });
  const occupiedShards = vi.fn(async () => { await pause(); return [0]; });
  const list = vi.fn(async () => { await pause(); return { items: [], counts: { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 } }; });
  const env = {
    AUTH_MODE: 'github', BUILD_ID: crypto.randomUUID(), SESSION_SECRET: 'read-latency-tests-secret-with-at-least-32-characters',
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    SECURITY: { idFromName: () => 'security', get: () => ({}) },
    DIRECTORY: { idFromName: () => 'directory', get: () => ({ publicRead }) },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch }) },
    PATHS: { getByName: () => ({ touching }) },
    TRUNKS: { getByName: () => ({ occupiedShards }) }, CHANGES: { getByName: () => ({ list }) },
  } as unknown as BraidEnv;
  const call = (path: string, headers: Record<string, string> = {}) => api.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-workspace': 'repository', ...headers } }), env);
  return { env, call, publicRead, fetch, touching, occupiedShards, list, advance: () => revision++ };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public read latency', () => {
  it.each(['/api/state', '/api/coordination?paths=README.md', '/api/changes'])('keeps %s at the edge while rechecking access', async path => {
    const f = fixture(), start = performance.now();
    const first = await f.call(path), data = await first.json();
    const cold = performance.now() - start, etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    const originCalls = () => f.fetch.mock.calls.length + f.touching.mock.calls.length + f.occupiedShards.mock.calls.length + f.list.mock.calls.length;
    const before = originCalls(), warmStart = performance.now();
    const again = await f.call(path, etag ? { 'if-none-match': etag } : {});
    const warm = performance.now() - warmStart;
    if (process.env.BRAID_READ_BENCHMARK === '1') console.info(`READ_TIMING ${path} cold=${cold.toFixed(2)}ms warm=${warm.toFixed(2)}ms originCalls=${before}/${originCalls() - before}`);
    expect(again.status).toBe(etag ? 304 : 200);
    expect(etag ? await again.text() : await again.json()).toEqual(etag ? '' : data);
    expect(f.publicRead).toHaveBeenCalledTimes(2);
    expect(originCalls()).toBe(before);
  });

  it('refreshes public state and coordination after five seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const state = await f.call('/api/state'), etag = state.headers.get('etag')!;
    await f.call('/api/coordination?paths=README.md');
    f.advance();
    expect((await f.call('/api/state', { 'if-none-match': etag })).status).toBe(304);
    await f.call('/api/coordination?paths=README.md');
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.touching).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 5_001);
    expect(await (await f.call('/api/state', { 'if-none-match': etag })).json()).toMatchObject({ project: { head: '2' } });
    await f.call('/api/coordination?paths=README.md');
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.touching).toHaveBeenCalledTimes(2);
  });

  it('denies an inaccessible repository before consulting its cached state', async () => {
    const f = fixture(), first = await f.call('/api/state');
    f.publicRead.mockResolvedValue({ ok: false, status: 404, error: 'Repository not found.' } as never);
    const response = await f.call('/api/state', { 'if-none-match': first.headers.get('etag')! });
    expect(response.status).toBe(404);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
