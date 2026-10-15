import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { RepositorySearch } from '../../shared/search';
import type { BraidEnv } from '../env';
import { seedWorkspace } from '../workspace/seed';
import { startGitServer } from '../test/git-server';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';

async function measure(workspace: Workspace, mode: 'demo' | 'live', query: string) {
  const start = performance.now();
  const response = await workspace.fetch(new Request(`https://braid.test/api/repository/search?q=${query}`, { headers: { 'x-braid-mode': mode } }));
  const result = await response.json() as RepositorySearch;
  const milliseconds = performance.now() - start;
  expect(response.status).toBe(200);
  expect(result.matchCount).toBeGreaterThan(0);
  return { result, milliseconds };
}

describe.runIf(process.env.BRAID_SEARCH_BENCHMARK === '1')('cold and warm search measurements', () => {
  it('measures real source files imported over Git HTTP and proves warm searches reuse the index', async () => {
    const source = await startGitServer(), imported = await startGitServer(), store = storageFixture();
    try {
      const paths = ['shared/history.ts', 'shared/compare.ts', 'shared/search.ts', 'shared/types.ts', 'worker/repositories/history.ts', 'worker/repositories/commit.ts', 'worker/repositories/compare.ts', 'worker/repositories/search.ts'];
      const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')])));
      const head = source.commitTree(files, undefined, 'Import Braid source fixture');
      source.native(['update-ref', 'refs/heads/main', head]);
      await promisify(execFile)('git', ['--git-dir', join(imported.root, 'repo.git'), 'fetch', '--quiet', source.remote, 'refs/heads/main:refs/heads/main']);
      expect(imported.native(['rev-parse', 'main']).trim()).toBe(head);
      expect(source.requests.some(request => request.path.endsWith('/git-upload-pack'))).toBe(true);
      const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
      seed.project = { ...seed.project, id: 'imported-search-fixture', branch: 'main', head };
      await store.storage.put('workspace', seed);
      const readBlob = vi.fn(imported.repository.readBlob), readTree = vi.fn(imported.repository.readTree), log = vi.fn(imported.repository.log);
      const env = { ARTIFACTS: { get: async () => ({ ...imported.repository, readBlob, readTree, log, [Symbol.dispose]() {} }) } } as unknown as BraidEnv;
      const workspace = new Workspace(store.ctx, env);
      await store.ready();
      const cold = await measure(workspace, 'live', 'commit');
      const reads = { blobs: readBlob.mock.calls.length, trees: readTree.mock.calls.length };
      expect(reads.blobs).toBe(paths.length);
      const warm = await measure(workspace, 'live', 'commit');
      expect(warm.result).toEqual(cold.result);
      expect(readBlob).toHaveBeenCalledTimes(reads.blobs);
      expect(readTree).toHaveBeenCalledTimes(reads.trees);
      expect(log).toHaveBeenCalledTimes(2);
      console.info(`SEARCH_TIMING imported-git-http files=${paths.length} bytes=${Buffer.byteLength(Object.values(files).join(''))} cold=${cold.milliseconds.toFixed(2)}ms warm=${warm.milliseconds.toFixed(2)}ms blobs=${reads.blobs} warmBlobs=0`);
    } finally { store.db.close(); await imported.close(); await source.close(); }
  }, 30_000);
});
