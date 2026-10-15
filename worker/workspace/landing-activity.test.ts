import { expect, it, vi } from 'vitest';
import { Workspace } from './workspace';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from './seed';
import type { BraidEnv } from '../env';

it('counts consecutive queue landings in one activity entry, and starts another after a minute', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = storageFixture();
  const data = seedWorkspace('live', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, model: '', namespace: 'test', canWrite: true });
  data.project = { ...data.project, id: 'repo', head: 'a'.repeat(40), branch: 'main' };
  await f.storage.put('workspace', data);
  const workspace = new Workspace(f.ctx, { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true' } as unknown as BraidEnv); await f.ready();
  const activity = async () => (await (await workspace.fetch(new Request('https://braid.example/api/state', { headers: { 'x-braid-mode': 'live', 'x-braid-role': 'owner' } }))).json() as { activity: { message: string; landed?: number }[] }).activity;
  try {
    await workspace.trunkAdvanced('b'.repeat(40), { batchId: 'one', landed: 2, ejected: 0 });
    await workspace.trunkAdvanced('c'.repeat(40), { batchId: 'two', landed: 1, ejected: 1 });
    expect((await activity())[0]).toMatchObject({ message: 'Landed 3 changes through the queue', landed: 3 });
    vi.setSystemTime(Date.now() + 61_000);
    await workspace.trunkAdvanced('d'.repeat(40), { batchId: 'three', landed: 1, ejected: 0 });
    expect((await activity()).slice(0, 2)).toMatchObject([{ message: 'Landed 1 change through the queue', landed: 1 }, { landed: 3 }]);
  } finally { vi.useRealTimers(); await f.settled(); f.db.close(); }
});
