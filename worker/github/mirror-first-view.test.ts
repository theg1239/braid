import { afterEach, expect, it, vi } from 'vitest';
import type { RepositoryAddress } from '../../shared/account';
import { mirrorFixture } from '../test/mirror';

let f: Awaited<ReturnType<typeof mirrorFixture>>;
afterEach(async () => { vi.restoreAllMocks(); if (f) await f.close(); vi.unstubAllGlobals(); });

async function opening() {
  f = await mirrorFixture();
  const address = await (await f.request('/api/repos/alice/repo')).json() as RepositoryAddress;
  await f.directoryDb.settled();
  const mirror = f.directory.mirrorRecord(address.workspaceId)!;
  const ws = f.getWorkspace(`team:${mirror.teamId}:repository:${mirror.workspaceId}`);
  return { ws, headers: { 'x-braid-workspace': address.workspaceId } };
}

it('starts with one source probe and publishes a mirror without waiting for an alarm or discovering its known branch', async () => {
  const { headers, ws } = await opening();
  expect(f.artifacts.import).toHaveBeenCalledTimes(1);
  expect(f.network.mock.calls.filter(([url]) => String(url).startsWith('https://github.com') && String(url).includes('/info/refs'))).toHaveLength(1);
  const token = vi.spyOn(f.repo, 'createToken');
  f.completeImport(); await f.drain();
  const snapshot = await (await f.request('/api/state', undefined, headers)).json();
  expect(snapshot).toMatchObject({ project: { head: f.head, branch: 'main' } });
  expect(snapshot).not.toHaveProperty('importing');
  expect(await ws.db.storage.get('pending-project')).toBeUndefined();
  expect(token).not.toHaveBeenCalledWith('read', 60);
});

it('warms the first tree and README in the same object cache the Code requests read', async () => {
  const { headers } = await opening();
  const commit = vi.spyOn(f.repo, 'readCommit'), tree = vi.spyOn(f.repo, 'readTree'), blob = vi.spyOn(f.repo, 'readBlob');
  f.completeImport(); await f.drain();
  expect(commit).toHaveBeenCalledWith(f.head);
  expect(tree).toHaveBeenCalled(); expect(blob).toHaveBeenCalled();
  commit.mockClear(); tree.mockClear(); blob.mockClear();
  const files = await f.request(`/api/repository/tree?ref=${f.head}`, undefined, headers);
  expect(files.status).toBe(200);
  const readme = await f.request(`/api/repository?ref=${f.head}&path=README.md`, undefined, headers);
  expect(await readme.json()).toMatchObject({ content: '# Mirror\nHello\n' });
  expect(commit).not.toHaveBeenCalled(); expect(tree).not.toHaveBeenCalled(); expect(blob).not.toHaveBeenCalled();
});

it('answers the completed snapshot while grant and token cleanup are still pending', async () => {
  const { headers, ws } = await opening();
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.security, 'finishGitHubImports').mockImplementation(() => cleanup);
  vi.spyOn(f.repo, 'revokeToken').mockImplementation(async () => { await cleanup; return true; });
  try {
    f.completeImport();
    await vi.waitFor(async () => expect(await ws.db.storage.get('pending-project')).toBeUndefined());
    const snapshot = await (await f.request('/api/state', undefined, headers)).json();
    expect(snapshot).toMatchObject({ project: { head: f.head } });
    expect(snapshot).not.toHaveProperty('importing');
  } finally { release(); await f.drain(); }
});

it('logs failed credential cleanup safely without stranding a completed mirror', async () => {
  const { headers } = await opening();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = Object.assign(new Error('remote private-fixture-token'), { code: 'UPSTREAM_UNAVAILABLE' });
  vi.spyOn(f.security, 'finishGitHubImports').mockImplementationOnce(() => { throw error; });
  vi.spyOn(f.repo, 'revokeToken').mockRejectedValueOnce(error);
  f.completeImport(); await f.drain();
  const snapshot = await (await f.request('/api/state', undefined, headers)).json();
  expect(snapshot).toMatchObject({ project: { head: f.head } }); expect(snapshot).not.toHaveProperty('importing');
  const logs = warning.mock.calls.map(([line]) => JSON.parse(String(line)));
  for (const event of ['import_grant_cleanup_failed', 'import_token_cleanup_failed']) expect(logs).toContainEqual(expect.objectContaining({ event, code: 'UPSTREAM_UNAVAILABLE' }));
  expect(JSON.stringify(logs)).not.toContain('private-fixture-token');
});

it('logs unexpected import-head failures by code without leaking upstream text and keeps its retry alarm', async () => {
  const { ws } = await opening();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.artifacts.get.mockRejectedValueOnce(Object.assign(new Error('remote credentials: private-fixture-token'), { code: 'UPSTREAM_UNAVAILABLE' }));
  await ws.workspace.alarm();
  expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: 'import_head_failed', code: 'UPSTREAM_UNAVAILABLE' }));
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private-fixture-token');
  expect(await ws.db.storage.getAlarm()).not.toBeNull();
});

it('copies an absent parent when Artifacts reports typed NOT_FOUND and makes its commit page readable', async () => {
  const { ws, headers } = await opening();
  f.env.TRUNKS = { getByName: () => ({ publicBuild: async () => ({ allowed: true }), occupiedShards: async () => [], provenance: async () => [], notesHead: async () => null, warmBlame: async () => {} }) } as unknown as typeof f.env.TRUNKS;
  f.completeImport(); await f.drain();
  expect((await f.request(`/api/repository/commit?sha=${f.first}`, undefined, headers)).status).toBe(404);
  expect(await (await f.request(`/api/repository/commit?sha=${f.head}`, undefined, headers)).json()).toMatchObject({ parentUnavailable: true, files: [] });
  const read = f.repo.readCommit;
  const commits = vi.spyOn(f.repo, 'readCommit').mockImplementation(async hash => {
    const commit = await read(hash);
    if (!commit) throw Object.assign(new Error('Object missing'), { code: 'NOT_FOUND' });
    return commit;
  });
  await ws.db.storage.deleteAlarm(); await ws.workspace.alarm(); await f.drain();
  commits.mockRestore();
  expect(await ws.db.storage.get('history-copy')).toBe('complete');
  expect((await f.request(`/api/repository/commit?sha=${f.first}`, undefined, headers)).status).toBe(200);
  expect(await (await f.request(`/api/repository/commit?sha=${f.head}`, undefined, headers)).json()).toMatchObject({ parentUnavailable: false, files: expect.arrayContaining([expect.objectContaining({ path: 'README.md' })]) });
  expect(f.target.native(['rev-parse', 'refs/heads/main']).trim()).toBe(f.head);
});


it('shares a brief first-read wait, then reads the imported head even while its branch name is unavailable', async () => {
  const { headers } = await opening();
  const tree = f.request('/api/repository/tree?ref=&path=', undefined, headers);
  const file = f.request('/api/repository?ref=&path=README.md', undefined, headers);
  setTimeout(() => f.completeImport(), 150);
  const [listing, readme] = await Promise.all([tree, file]);
  expect(listing.status).toBe(200); expect(await listing.json()).toMatchObject({ ref: f.head, entries: expect.arrayContaining([expect.objectContaining({ path: 'README.md' })]) });
  expect(readme.status).toBe(200); expect(await readme.json()).toMatchObject({ ref: f.head, content: '# Mirror\nHello\n' });
  expect(f.artifacts.import).toHaveBeenCalledTimes(1);
});

it('answers a longer import without an error or an immutable empty-tree cache entry, then serves the finished content', async () => {
  const { headers } = await opening();
  const [tree, file] = await Promise.all([
    f.request('/api/repository/tree?ref=&path=', undefined, headers),
    f.request('/api/repository?ref=&path=README.md', undefined, headers),
  ]);
  for (const response of [tree, file]) {
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-braid-ref')).toBeNull();
    expect(response.headers.get('retry-after')).toBe('2');
  }
  expect(await tree.json()).toMatchObject({ ref: '', entries: [], importing: { source: 'alice/repo' } });
  expect(await file.json()).toMatchObject({ ref: '', content: '', importing: { source: 'alice/repo' } });
  f.completeImport(); await f.drain();
  const ready = await f.request('/api/repository?ref=&path=README.md', undefined, headers);
  expect(ready.status).toBe(200); expect(await ready.json()).toMatchObject({ ref: f.head, content: '# Mirror\nHello\n' });
});

it('bounds the first-read wait even when an Artifacts head read stalls', async () => {
  const { headers } = await opening();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.repo, 'log').mockImplementationOnce(async () => { await stalled; return []; });
  try {
    const response = await f.request('/api/repository/tree?ref=&path=', undefined, headers);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ref: '', entries: [], importing: { source: 'alice/repo' } });
  } finally { release(); f.completeImport(); await f.drain(); }
});
