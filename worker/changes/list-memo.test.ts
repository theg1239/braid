import { afterEach, describe, expect, it, vi } from 'vitest';
import { listChanges } from './router';
import type { BraidEnv } from '../env';

const counts = { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 1, closed: 0 };
function env() {
  const list = vi.fn(async () => ({ items: [{ id: 'ch_1', number: 1, updatedAt: '2026-10-13T00:00:00.000Z' }], counts }));
  return { env: { CHANGES: { getByName: () => ({ list }) }, TRUNKS: { getByName: () => ({ stackViews: async () => ({}), occupiedShards: async () => null, recordShards: async () => {} }) } } as unknown as BraidEnv, list };
}
afterEach(() => vi.useRealTimers());

describe('visitors\' change pages', () => {
  it('gathers once per repository and query within ten seconds for visitors, and every time for members', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { env: e, list } = env();
    const query = { statuses: ['landed' as const], limit: 1, publicViewer: true };
    await Promise.all([listChanges(e, 'repo-a', query), listChanges(e, 'repo-a', query), listChanges(e, 'repo-a', { ...query, limit: 2 })]);
    expect(list).toHaveBeenCalledTimes(32);
    await listChanges(e, 'repo-a', { statuses: ['landed'], limit: 1 });
    expect(list).toHaveBeenCalledTimes(48);
    vi.advanceTimersByTime(10_001);
    await listChanges(e, 'repo-a', query);
    expect(list).toHaveBeenCalledTimes(64);
  });
});
