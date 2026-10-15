import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRoster, listChanges } from './router';
import type { BraidEnv } from '../env';
import { edgeCache } from '../test/edge-cache';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent change reads', () => {
  it('starts stored line totals while finding the roster shards', async () => {
    let finish!: (value: number[]) => void;
    const occupiedShards = vi.fn(() => new Promise<number[]>(resolve => { finish = resolve; }));
    const agentLines = vi.fn(async () => ({}));
    const env = { TRUNKS: { getByName: () => ({ occupiedShards, agentLines }) } } as unknown as BraidEnv;
    const roster = agentRoster(env, 'repository');
    try { expect(agentLines).toHaveBeenCalledOnce(); }
    finally { finish([]); }
    expect(await roster).toEqual([]);
  });

  it('loads stack links while completing the legacy shard directory', async () => {
    let finish!: () => void;
    const recordShards = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stackViews = vi.fn(async () => ({ one: { stack: { position: 1, total: 2 } } }));
    const env = {
      TRUNKS: { getByName: () => ({ occupiedShards: async () => null, recordShards, stackViews }) },
      CHANGES: { getByName: () => ({ list: async () => ({ items: [{ id: 'one', number: 1, updatedAt: '2026-10-14T00:00:00Z' }], counts: { open: 1, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 } }) }) },
    } as unknown as BraidEnv;
    const page = listChanges(env, 'repository', { limit: 1 });
    await vi.waitFor(() => expect(recordShards).toHaveBeenCalledOnce());
    try { expect(stackViews).toHaveBeenCalledOnce(); }
    finally { finish(); }
    expect((await page).items[0]).toMatchObject({ id: 'one', stack: { position: 1, total: 2 } });
  });

  it('keeps a public page when a new isolate handles the next read', async () => {
    edgeCache();
    const pause = async () => { if (process.env.BRAID_READ_BENCHMARK === '1') await new Promise(resolve => setTimeout(resolve, 40)); };
    const occupiedShards = vi.fn(async () => { await pause(); return [0]; });
    const list = vi.fn(async () => { await pause(); return { items: [], counts: { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 } }; });
    const env = {
      BUILD_ID: crypto.randomUUID(), TRUNKS: { getByName: () => ({ occupiedShards }) }, CHANGES: { getByName: () => ({ list }) },
    } as unknown as BraidEnv;
    const query = { limit: 20, publicViewer: true }, start = performance.now();
    const first = await listChanges(env, 'repository', query), cold = performance.now() - start;
    vi.resetModules();
    const isolated = (await import('./router')).listChanges, warmStart = performance.now();
    expect(await isolated(env, 'repository', query)).toEqual(first);
    const warm = performance.now() - warmStart;
    if (process.env.BRAID_READ_BENCHMARK === '1') console.info(`CHANGES_ISOLATE_TIMING cold=${cold.toFixed(2)}ms warm=${warm.toFixed(2)}ms calls=${occupiedShards.mock.calls.length + list.mock.calls.length}`);
    expect(occupiedShards).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledOnce();
  });
});
