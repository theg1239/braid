import { expect, it, vi } from 'vitest';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from '../workspace/seed';
import { Workspace } from '../workspace/workspace';
import type { BraidEnv } from '../env';

async function fixture() {
  const f = await publicRepository(), store = storageFixture();
  const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false,
    authenticated: true, storage: 'durable-object', model: 'fixture', namespace: 'fixture' });
  seed.project = { ...seed.project, id: 'repo', head: f.base, branch: 'main' };
  await store.storage.put('workspace', seed);
  const workspace = new Workspace(store.ctx, f.env); await store.ready();
  f.env.WORKSPACES = { idFromName: (name: string) => name, get: () => workspace, getByName: () => f.h.workspace } as unknown as BraidEnv['WORKSPACES'];
  return { ...f, store, close: async () => { await store.settled(); store.db.close(); await f.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); } };
}

it('charges every cold anonymous search to the ten-build per-network repository budget', async () => {
  const f = await fixture();
  try {
    // Eleven different published historical commits keep every search cold despite the three-head cache.
    const commits: string[] = []; let parent = f.base;
    for (let i = 0; i < 11; i++) {
      parent = f.h.git.commitTree({ 'code.ts': `export const needle = ${i};\n` }, parent);
      commits.push(parent);
    }
    f.h.git.native(['update-ref', 'refs/heads/main', parent]);
    const statuses: number[] = [];
    for (const ref of commits) statuses.push((await f.anonymous(`/api/repository/search?q=needle&ref=${ref}`, { 'x-braid-public-network': ref })).status);
    expect(statuses).toEqual([...Array(10).fill(200), 503]);
    const refused = await f.anonymous(`/api/repository/search?q=needle&ref=${commits[10]}`);
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // A completed index remains readable after the cold-build allowance is exhausted.
    const warm = await f.anonymous(`/api/repository/search?q=needle&ref=${commits[9]}`);
    expect(warm.status).toBe(200);
    expect(await warm.json()).toMatchObject({ matchCount: 1 });
  } finally { await f.close(); }
});

it('also respects an exhausted repository build budget through global search', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 30; i++) expect(f.h.trunk.publicBuild(`network-${i}`).allowed).toBe(true);
    expect(f.h.trunk.publicBuild('another-network').allowed).toBe(false);
    const tree = vi.spyOn(f.h.git.repository, 'readTree');
    const q = `repo:${f.team.slug}/${f.team.workspaces[0].slug} Relay`;
    const response = await f.anonymous(`/api/search?${new URLSearchParams({ q })}`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect.soft(data).toMatchObject({ repositories: [], searched: [], unavailable: [{ name: f.team.workspaces[0].slug }], matchCount: 0, truncated: true });
    expect.soft(tree).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
