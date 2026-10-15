import { expect, it, vi } from 'vitest';
import { Workspace } from './workspace';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from './seed';
import type { BraidEnv } from '../env';

const old = 'a'.repeat(40), current = 'b'.repeat(40);
it.each(['/api/repository/tree?ref=&path=', '/api/repository?ref=&path=README.md'])(
  'refreshes an implicit default-branch read after a lost trunkAdvanced notification: %s', async path => {
    const f = storageFixture();
    const data = seedWorkspace('live', { mode: 'live', artifacts: true, ai: false, storage: 'durable-object', authenticated: true, model: '', namespace: 'test', canWrite: true });
    data.project = { ...data.project, id: 'repo', head: old, branch: 'main' };
    await f.storage.put('workspace', data);
    const repo = {
      [Symbol.dispose]() {}, log: vi.fn(async () => [{ hash: current }]),
      readCommit: async (hash: string) => ({ treeHash: hash }),
      readTree: async (hash: string) => [{ type: 'blob', mode: '100644', name: 'README.md', hash }],
      readBlob: async (hash: string) => new Blob([hash === current ? 'new content' : 'old content']),
    };
    const env = { AUTH_MODE: 'owner-key', LIVE_ENABLED: 'true', ARTIFACTS: { get: async () => repo } } as unknown as BraidEnv;
    const workspace = new Workspace(f.ctx, env); await f.ready();
    try {
      const response = await workspace.fetch(new Request(`https://braid.example${path}`, { headers: { 'x-braid-mode': 'live', 'x-braid-role': 'viewer' } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-braid-ref')).toBe(current);
      expect(repo.log).toHaveBeenCalledWith({ ref: 'main', limit: 1 });
    } finally { await f.settled(); f.db.close(); }
  },
);
