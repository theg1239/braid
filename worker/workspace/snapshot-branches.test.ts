import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities, WorkspaceSnapshot } from '../../shared/types';
import type { RepositoryBranches } from '../../shared/compare';
import type { BraidEnv } from '../env';
import { exampleMain, recordedExample } from '../changes/demo';
import { seedWorkspace } from './seed';
import { Workspace } from './workspace';
import { storageFixture } from '../test/storage';

const stores: ReturnType<typeof storageFixture>[] = [];
const capabilities: Capabilities = { mode: 'demo', artifacts: false, ai: false, storage: 'durable-object', authenticated: false, model: '', namespace: '', canWrite: false };
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.db.close(); });
async function fixture(seed?: WorkspaceSnapshot) {
  const store = storageFixture(); stores.push(store);
  if (seed) await store.storage.put('workspace', seed);
  const workspace = new Workspace(store.ctx, { AI_MODEL: '', ARTIFACTS_NAMESPACE: '' } as BraidEnv);
  await store.ready();
  const get = (path: string, headers: Record<string, string> = {}) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': seed?.capabilities.mode ?? 'demo', ...headers } }));
  const snapshot = async (headers?: Record<string, string>) => {
    const response = await get('/api/state', headers); expect(response.status, response.ok ? '' : await response.clone().text()).toBe(200);
    return response.json() as Promise<WorkspaceSnapshot>;
  };
  return { get, snapshot };
}

describe('snapshot branch list', () => {
  it.each([false, true])('includes recorded branches immediately in a %s existing example', async existing => {
    const seed = seedWorkspace('demo', capabilities);
    expect(seed.project.branches).toBeUndefined();
    const f = await fixture(existing ? seed : undefined);
    for (const headers of [{}, { 'x-braid-public': 'true' }] as Record<string, string>[]) {
      const state = await f.snapshot(headers);
      const response = await f.get('/api/repository/branches');
      const branches = await response.json() as RepositoryBranches;
      expect(state.project.branches).toEqual(branches.branches.map(branch => branch.name));
      expect(state.project.branches).toEqual(['main', ...(await recordedExample()).branches().map(branch => branch.name)]);
      expect(state.project.branches).toContain('refund-rounding');
      expect(state.project.head).toBe(exampleMain().head);
      expect(state.files).toEqual(exampleMain().files);
    }
  });
  it('keeps the shared example content and branch list frozen across repeated reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-13T12:00:00Z');
    const f = await fixture(), before = await f.snapshot();
    const response = await f.get('/api/state');
    expect((await f.get('/api/state', { 'if-none-match': response.headers.get('etag')! })).status).toBe(304);
    vi.setSystemTime('2026-10-13T16:00:00Z');
    const after = await f.snapshot();
    expect(after).toEqual(before);
  });
  it.each([
    { id: 'imported-relay', branch: 'stable', branches: ['stable', 'feature/retries'], head: 'a'.repeat(40) },
    { id: '', branch: 'main', head: '' },
  ])('preserves live repository metadata for $branch with head "$head"', async project => {
    const seed = seedWorkspace('live', { ...capabilities, mode: 'live' });
    seed.project = { ...seed.project, ...project };
    const state = await (await fixture(seed)).snapshot();
    expect(state.project).toEqual(seed.project);
    expect(state.project.branches ?? []).not.toContain('refund-rounding');
  });
});
