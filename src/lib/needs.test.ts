import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeCounts, WorkspaceSnapshot } from '../../shared/types';

const state = vi.hoisted(() => ({ visitor: true, keys: [] as (string | null)[] }));
const counts: ChangeCounts = { open: 1, revise: 4, attention: 2, queued: 0, landing: 0, landed: 48, closed: 3 };
vi.mock('./api', () => ({ changes: { list: vi.fn() } }));
vi.mock('./polling', () => ({ publicPolling: () => state.visitor }));
vi.mock('./live', () => ({ useLive: (key: string | null) => { state.keys.push(key); return { data: key ? { items: [], counts, nextCursor: null } : null }; } }));
import { ATTENTION_KEY, LATEST_KEY, useHeaderCounts } from './needs';

const snapshot = { project: { id: 'relay' }, missions: [] } as unknown as WorkspaceSnapshot;
beforeEach(() => { state.keys = []; });

describe('repository tab counts', () => {
  it('count open pull requests for a visitor from the latest-merge read the Code page shares, with nothing to review', () => {
    state.visitor = true;
    expect(useHeaderCounts(snapshot)).toEqual({ open: 7, review: 0, tasks: 0 });
    expect(state.keys).toEqual([LATEST_KEY]);
  });
  it('count open pull requests and the reviews waiting for a member from the attention list', () => {
    state.visitor = false;
    expect(useHeaderCounts(snapshot)).toEqual({ open: 7, review: 2, tasks: 0 });
    expect(state.keys).toEqual([ATTENTION_KEY]);
  });
  it('read nothing before the repository exists', () => {
    expect(useHeaderCounts({ ...snapshot, project: { id: '' } } as WorkspaceSnapshot).open).toBe(0);
    expect(state.keys).toEqual([null]);
  });
});
