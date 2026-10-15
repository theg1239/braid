import { afterEach, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { changedFiles, scanPushedHistory } from '../git/history';
import { unwrap } from '../errors';
import { ChangeRecords } from './records';

let h: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = undefined; });

it.each(['before', 'after'])('reports the typed Artifacts blob memory limit while reading the %s version', async side => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'asset.bin': 'before\0' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  const before = h.git.native(['rev-parse', `${base}:asset.bin`]).trim();
  const after = h.git.native(['hash-object', '-w', '--stdin'], 'after\0').trim();
  const read = h.git.repository.readBlob;
  vi.spyOn(h.git.repository, 'readBlob').mockImplementation(hash => hash === (side === 'before' ? before : after)
    ? Promise.reject(Object.assign(new Error('private upstream diagnostic'), { code: 'MEMORY_LIMIT' })) : read(hash));
  expect(await h.submit('author', { title: 'Replace asset', summary: 'Update asset.', baseCommit: base, files: [{ path: 'asset.bin', blob: after }] }))
    .toMatchObject({ ok: false, status: 413, error: 'Cloudflare Artifacts cannot buffer this Git blob within its memory limit. Split this file before submitting.' });
  expect(h.git.native(['for-each-ref', 'refs/braid/revisions'])).toBe('');
});

it('retains a clean patch without retaining the secret ancestors of its pushed tip', async () => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Base\n' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  const secret = `ghp_${'A1b2'.repeat(9)}`;
  const parent = h.git.commitTree({ 'secret.txt': secret }, base);
  const tip = h.git.commitTree({ 'secret.txt': null, 'safe.txt': 'Clean patch\n' }, parent);
  const baseTree = (await h.git.repository.readCommit(base))!.treeHash;
  const commits = await Promise.all([tip, parent].map(hash => h!.git.repository.readCommit(hash)));
  const history = await scanPushedHistory(h.git.repository, baseTree, commits.map(commit => commit!));
  expect(history).toEqual([{ commit: tip, secrets: false }, { commit: parent, secrets: true }]);
  const files = await changedFiles(h.git.repository, baseTree, commits[0]!.treeHash);
  const change = unwrap(await h.shard(0).push(h.context('author', 0), { commit: tip, history }, {
    title: 'Clean patch', summary: 'Remove the credential.', baseCommit: base, files,
  }));
  expect(change.guards?.some(finding => finding.kind === 'secrets')).not.toBe(true);
  h.git.native(['reflog', 'expire', '--expire=now', '--all']);
  h.git.native(['prune', '--expire=now']);
  expect(await h.git.repository.readCommit(parent)).toBeNull();
  expect(await h.git.repository.readCommit(tip)).toBeNull();
  expect(unwrap(await h.shard(0).diff(h.repository, change.id, 'safe.txt'))).toMatchObject({ after: 'Clean patch\n' });
});

it('reuses the retention ref after a failure between its push and writing the change record', async () => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Base\n' });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  const blob = h.git.native(['hash-object', '-w', '--stdin'], 'binary\0asset').trim();
  const shard = h.shard(0), context = h.context('author', 0), key = 'retention-crash-retry';
  const body = { title: 'Add asset', summary: 'Keep asset.', baseCommit: base, files: [{ path: 'asset.bin', blob }] };
  vi.spyOn(ChangeRecords.prototype, 'write').mockImplementationOnce(() => { throw new Error('Interrupted before record write'); });
  expect(await shard.submit(context, body, key)).toMatchObject({ ok: false, status: 500 });
  expect(shard.list({ limit: 10 }).items).toHaveLength(0);
  const refs = h.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/revisions']).trim().split('\n');
  expect(refs).toHaveLength(1);
  expect(h.head()).toBe(base);
  const writes = h.git.requests.filter(request => request.path.endsWith('/git-receive-pack')).length;
  const change = unwrap(await shard.submit(context, body, key));
  expect(unwrap(await shard.submit(context, body, key)).id).toBe(change.id);
  expect(shard.list({ limit: 10 }).items).toHaveLength(1);
  expect(h.git.requests.filter(request => request.path.endsWith('/git-receive-pack'))).toHaveLength(writes);
  expect(h.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/revisions']).trim().split('\n')).toEqual(refs);
});
