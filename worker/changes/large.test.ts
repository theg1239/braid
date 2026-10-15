import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { composeChanges, TreeSnapshot } from './compose';
import { changedFiles } from '../git/history';
import { pushCommits } from '../git/push';
import { hostedReview, reviewPrompt, type ReviewInput } from './review';
import { scanBlob } from '../git/scan';
import { ZERO } from '../git/transport';
import { unwrap } from '../errors';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); harness = undefined; });
const owner = { kind: 'owner' as const, id: 'owner', name: 'Test owner' };

describe('pull requests without aggregate content limits', () => {
  it.each([false, true])('rechecks owner access before retaining blobs, including after preparation: %s', async duringPreparation => {
    harness = await changeHarness({ env: { AUTH_MODE: 'account' } });
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const blob = harness.git.native(['hash-object', '-w', '--stdin'], 'binary\0asset').trim();
    const authorization = { user: { id: 'owner', email: 'owner@example.test', name: 'Test owner' }, workspaceId: 'w', teamId: 't' };
    const directory = harness.env.DIRECTORY.get(harness.env.DIRECTORY.idFromName('directory'));
    const allowed = { [Symbol.dispose]() {}, ok: true as const, data: { teamId: 't', workspaceId: 'w', role: 'owner' as const, organizationRole: 'owner' as const, ownerSlug: 'team', repoSlug: 'repo' } };
    const access = vi.spyOn(directory, 'access').mockResolvedValue({ [Symbol.dispose]() {}, ok: false, status: 403, error: 'private access diagnostic' });
    if (duringPreparation) access.mockResolvedValueOnce(allowed);
    const shard = harness.shard(0), context = { ...harness.context(owner, 0), authorization };
    const body = { title: 'Add asset', summary: 'Store asset.', baseCommit: base, files: [{ path: 'asset.bin', blob }] };
    expect(await shard.submit(context, body, 'retention-authorization-retry')).toMatchObject({ ok: false, status: 403, error: 'The owner who authorized this operation no longer has repository access.' });
    expect(access).toHaveBeenCalledTimes(duringPreparation ? 2 : 1);
    const handles = await Promise.all(harness.artifacts.get.mock.results.map(result => result.value));
    expect(handles.flatMap(handle => handle.createToken.mock.calls)).toHaveLength(duringPreparation ? 1 : 0);
    expect(handles.flatMap(handle => handle.revokeToken.mock.calls)).toHaveLength(duringPreparation ? 1 : 0);
    expect(harness.git.requests.some(request => request.path.endsWith('/git-receive-pack'))).toBe(false);
    expect(harness.git.native(['for-each-ref', 'refs/braid/revisions/'])).toBe('');
    expect(shard.list({ limit: 10 }).items).toEqual([]);
    expect(harness.head()).toBe(base);
    access.mockResolvedValue(allowed);
    expect(await shard.submit(context, body, 'retention-authorization-retry')).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(harness.git.native(['for-each-ref', 'refs/braid/revisions/'])).not.toBe('');
  });

  it('submits and lands 1,000 files with a note and the submitted message', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `docs/${i}.txt`, content: `Document ${i}\n` }));
    const change = unwrap(await harness.submit('large', { title: 'Add the documentation', summary: 'One thousand documents.', baseCommit: base, files }));
    expect(change.files).toHaveLength(1000);
    const shard = harness.shard(parseInt(change.id[3], 16));
    unwrap(await shard.approve(harness.context(owner, parseInt(change.id[3], 16)), change.id, { revision: 1 }));
    await harness.settle();
    expect(unwrap(await shard.get(change.id))).toMatchObject({ status: 'landed' });
    expect(harness.git.native(['ls-tree', '-r', '--name-only', 'main']).trim().split('\n')).toHaveLength(1001);
    expect(harness.git.native(['log', '-1', '--format=%B', 'main']).trim()).toBe('Add the documentation\n\nOne thousand documents.');
    expect(JSON.parse(harness.git.native(['notes', '--ref=braid', 'show', 'main']))).toMatchObject({ change: { number: change.number } });
  }, 60_000);

  it('submits and lands 50 MiB as Git blob references without loading blobs during composition or push', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const content = 'asset\0'.repeat(Math.ceil(25 * 1024 * 1024 / 6)).slice(0, 25 * 1024 * 1024);
    const proposed = harness.git.commitTree({ 'assets/a.bin': content, 'assets/b.bin': content.slice(0, -1) + 'b' }, base);
    const files = await changedFiles(harness.git.repository, (await harness.git.repository.readCommit(base))!.treeHash, (await harness.git.repository.readCommit(proposed))!.treeHash);
    expect(JSON.stringify(files).length).toBeLessThan(500);
    const change = unwrap(await harness.submit('large', { title: 'Add assets', summary: 'Store both assets.', baseCommit: base, files }));
    expect(change).toMatchObject({ status: 'attention', files: [{ path: 'assets/a.bin' }, { path: 'assets/b.bin' }] });
    // No branch references the proposal. Hash-only REST submissions must pin their blobs before returning.
    harness.git.native(['reflog', 'expire', '--expire=now', '--all']);
    harness.git.native(['prune', '--expire=now']);
    for (const file of files) if ('blob' in file) expect(await harness.git.repository.readBlob(file.blob)).not.toBeNull();
    const reader = { ...harness.git.repository, readBlob: vi.fn(async () => { throw new Error('Landing must use hashes'); }) };
    const edits = Object.fromEntries(files.map(file => [file.path, 'blob' in file ? { blob: file.blob } : null]));
    const [composed] = await composeChanges(reader, base, [{ id: change.id, baseCommit: base, files: edits }]);
    expect(composed.status).toBe('applied');
    const start = harness.git.requests.length;
    await pushCommits({ remote: harness.git.remote, token: 'fixture', repository: reader, branch: 'probe', expectedHead: ZERO, parent: base,
      commits: [{ files: composed.files, message: 'Add assets', authorName: 'Test owner' }] });
    expect(reader.readBlob).not.toHaveBeenCalled();
    expect(harness.git.requests.slice(start).filter(request => request.path.endsWith('/git-receive-pack')).reduce((sum, request) => sum + request.bytes, 0)).toBeLessThan(4096);
    for (const file of files) if ('blob' in file) expect(harness.git.native(['rev-parse', `probe:${file.path}`]).trim()).toBe(file.blob);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
    const index = parseInt(change.id[3], 16);
    unwrap(await harness.shard(index).approve(harness.context(owner, index), change.id, { revision: 1 }));
    await harness.settle();
    expect(unwrap(await harness.shard(index).get(change.id))).toMatchObject({ status: 'landed' });
    for (const file of files) if ('blob' in file) expect(harness.git.native(['rev-parse', `main:${file.path}`]).trim()).toBe(file.blob);
  }, 60_000);

  it('submits and composes 1,000 distinct binary files totaling 50 MiB using a small hash-only patch', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const tail = 'asset\0'.repeat(9000);
    const content = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `assets/${index}-${'a'.repeat(200)}.bin`, `${index}\0${tail}`.slice(0, 52_429),
    ]));
    const proposed = harness.git.commitTree(content, base);
    expect(Object.values(content).reduce((sum, value) => sum + Buffer.byteLength(value), 0)).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    const files = await changedFiles(harness.git.repository, (await harness.git.repository.readCommit(base))!.treeHash, (await harness.git.repository.readCommit(proposed))!.treeHash);
    expect(Buffer.byteLength(JSON.stringify(files))).toBeLessThan(350_000);
    const change = unwrap(await harness.submit('large-many', { title: 'Add generated assets', summary: 'Keep the asset set.', baseCommit: base, files }));
    expect(change.files).toHaveLength(1000);
    const reader = { ...harness.git.repository, readBlob: vi.fn(async () => { throw new Error('Composition must use hashes'); }) };
    const edits = Object.fromEntries(files.map(file => [file.path, 'blob' in file ? { blob: file.blob } : null]));
    const [composed] = await composeChanges(reader, base, [{ id: change.id, baseCommit: base, files: edits }]);
    expect(composed.status).toBe('applied');
    expect(Object.keys(composed.files)).toHaveLength(1000);
    expect(reader.readBlob).not.toHaveBeenCalled();
  }, 120_000);

  it.each(['__proto__', 'constructor'])('lands a binary file named %s without losing a record key', async path => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const blob = harness.git.native(['hash-object', '-w', '--stdin'], 'binary\0asset').trim();
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
    const change = unwrap(await harness.submit('binary-name', { title: 'Add asset', summary: 'Store asset.', baseCommit: base, files: [{ path, blob }] }));
    const index = parseInt(change.id[3], 16), shard = harness.shard(index);
    unwrap(await shard.approve(harness.context(owner, index), change.id, { revision: 1 }));
    await harness.settle();
    expect(unwrap(await shard.get(change.id)).status).toBe('landed');
    expect(harness.git.native(['rev-parse', `main:${path}`]).trim()).toBe(blob);
  });

  it('merges binary additions and independent changes by hash, and leaves concurrent binary edits conflicted', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'old\0asset', 'other.txt': 'before\n' });
    const theirs = harness.git.commitTree({ 'asset.bin': 'new\0asset', 'added.bin': 'added\0asset' }, base);
    const oid = (commit: string, path: string) => harness!.git.native(['rev-parse', `${commit}:${path}`]).trim();
    const files = { 'asset.bin': { blob: oid(theirs, 'asset.bin') }, 'added.bin': { blob: oid(theirs, 'added.bin') } };
    const head = harness.git.commitTree({ 'other.txt': 'after\n' }, base);
    expect((await composeChanges(harness.git.repository, head, [{ id: 'binary', baseCommit: base, files }]))[0]).toMatchObject({ status: 'applied', files });
    const conflict = harness.git.commitTree({ 'asset.bin': 'rival\0asset' }, head);
    expect((await composeChanges(harness.git.repository, conflict, [{ id: 'binary', baseCommit: base, files }]))[0])
      .toMatchObject({ status: 'conflicted', files: {}, conflicts: [{ path: 'asset.bin', kind: 'binary' }] });
    expect((await composeChanges(harness.git.repository, theirs, [{ id: 'binary', baseCommit: base, files }]))[0].status).toBe('empty');
  });

  it('does not call the model or approve a review whose files exceed its context', async () => {
    const run = vi.fn(), input: ReviewInput = { title: 'Large', intent: '', summary: '', rationale: '', instructions: [], notes: [],
      files: Array.from({ length: 1000 }, (_, i) => ({ path: `${i}.txt`, before: '', after: 'line\n'.repeat(100) })) };
    expect(await hostedReview({ run } as unknown as Ai, 'fixture', input)).toMatchObject({ verdict: 'escalate' });
    expect(run).not.toHaveBeenCalled();
    expect(reviewPrompt(input).map(message => message.content).join('').length).toBeLessThan(125_000);
  });

  it('conflicts on binary edit/delete races in either order without reading the blob', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'old\0asset' });
    const edited = harness.git.commitTree({ 'asset.bin': 'new\0asset' }, base);
    const deleted = harness.git.commitTree({ 'asset.bin': null }, base);
    const blob = harness.git.native(['rev-parse', `${edited}:asset.bin`]).trim();
    expect(() => harness!.git.native(['merge-tree', '--write-tree', edited, deleted])).toThrow();
    const reader = { ...harness.git.repository, readBlob: vi.fn(async () => { throw new Error('Hashes suffice'); }) };
    expect((await composeChanges(reader, edited, [{ id: 'delete', baseCommit: base, files: { 'asset.bin': null } }]))[0])
      .toMatchObject({ status: 'conflicted', files: {}, conflicts: [{ path: 'asset.bin', kind: 'delete-modify' }] });
    expect((await composeChanges(reader, deleted, [{ id: 'edit', baseCommit: base, files: { 'asset.bin': { blob } } }]))[0])
      .toMatchObject({ status: 'conflicted', files: {}, conflicts: [{ path: 'asset.bin', kind: 'modify-delete' }] });
    expect(reader.readBlob).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a moved main with blob edits and recomposes against it (same file: %s)', async sameFile => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'old\0asset', 'other.txt': 'before\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const blob = harness.git.native(['hash-object', '-w', '--stdin'], 'new\0asset').trim();
    const advanced = harness.git.commitTree(sameFile ? { 'asset.bin': 'rival\0asset' } : { 'other.txt': 'after\n' }, base);
    const changes = [{ id: 'binary-cas', baseCommit: base, files: { 'asset.bin': { blob } } }];
    const [first] = await composeChanges(harness.git.repository, base, changes);
    const options = { repository: harness.git.repository, remote: harness.git.remote, token: 'fixture', branch: 'main' };
    await expect(pushCommits({ ...options, expectedHead: base, commits: [{ files: first.files, message: 'Update asset' }],
      onPrepared: async () => { harness!.git.native(['update-ref', 'refs/heads/main', advanced, base]); } }))
      .rejects.toMatchObject({ code: 'rejected' });
    expect(harness.head()).toBe(advanced);
    const [retried] = await composeChanges(harness.git.repository, advanced, changes);
    if (sameFile) expect(retried).toMatchObject({ status: 'conflicted', files: {}, conflicts: [{ path: 'asset.bin', kind: 'binary' }] });
    else {
      expect(retried.status).toBe('applied');
      await pushCommits({ ...options, expectedHead: advanced, commits: [{ files: retried.files, message: 'Update asset' }] });
      expect(harness.git.native(['show', 'main:other.txt'])).toBe('after\n');
      expect(harness.git.native(['rev-parse', 'main:asset.bin']).trim()).toBe(blob);
    }
  });

  it('matches Git when binary content and executable-bit changes are independent', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'old\0asset' });
    const changed = harness.git.commitTree({ 'asset.bin': 'new\0asset' }, base);
    const original = harness.git.native(['rev-parse', `${base}:asset.bin`]).trim();
    const blob = harness.git.native(['rev-parse', `${changed}:asset.bin`]).trim();
    const modeTree = harness.git.native(['mktree'], `100755 blob ${original}\tasset.bin\n`).trim();
    const modeCommit = harness.git.native(['commit-tree', modeTree, '-p', base], 'Make executable\n').trim();
    const gitTree = harness.git.native(['merge-tree', '--write-tree', modeCommit, changed]).trim();
    expect(harness.git.native(['ls-tree', gitTree]).trim()).toBe(`100755 blob ${blob}\tasset.bin`);
    const reader = { ...harness.git.repository, readBlob: vi.fn(async () => { throw new Error('Binary merge needs only hashes'); }) };
    for (const [head, files] of [
      [modeCommit, { 'asset.bin': { blob } }],
      [changed, { 'asset.bin': { blob: original, mode: '100755' as const } }],
    ] as const) {
      expect((await composeChanges(reader, head, [{ id: 'binary-mode', baseCommit: base, files }]))[0])
        .toMatchObject({ status: 'applied', files: { 'asset.bin': { blob, mode: '100755' } } });
    }
    expect(reader.readBlob).not.toHaveBeenCalled();
  });

  it('does not treat an unavailable tree as an absent file', async () => {
    const reader = { readCommit: async () => ({ treeHash: 'a'.repeat(40) }), readTree: async () => null, readBlob: async () => null };
    await expect(composeChanges(reader, 'b'.repeat(40), [{ id: 'missing-tree', baseCommit: 'c'.repeat(40), files: { 'asset.bin': { blob: 'd'.repeat(40) } } }]))
      .rejects.toThrow('A tree needed for this landing is not available yet.');
  });

  it('matches Git when two additions have identical binary content but different executable bits', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    const plain = harness.git.commitTree({ 'asset.bin': 'binary\0asset' }, base);
    const blob = harness.git.native(['rev-parse', `${plain}:asset.bin`]).trim();
    const entries = harness.git.native(['ls-tree', `${plain}^{tree}`]).replace('100644 blob ' + blob, '100755 blob ' + blob);
    const tree = harness.git.native(['mktree'], entries).trim();
    const executable = harness.git.native(['commit-tree', tree, '-p', base], 'Executable asset\n').trim();
    expect(() => harness!.git.native(['merge-tree', '--write-tree', plain, executable])).toThrow();
    for (const [head, mode] of [[plain, '100755'], [executable, '100644']] as const) {
      expect((await composeChanges(harness.git.repository, head, [{ id: 'binary-add-mode', baseCommit: base, files: { 'asset.bin': { blob, mode } } }]))[0])
        .toMatchObject({ status: 'conflicted', files: {}, conflicts: [{ path: 'asset.bin', kind: 'mode' }] });
    }
  });

  it('applies the line-review byte budget to inline UTF-8 and requires owner approval', async () => {
    const text = '文'.repeat(400_000);
    const snapshot = new TreeSnapshot({ readCommit: async () => null, readTree: async () => null, readBlob: async () => null });
    expect(await snapshot.text({ kind: 'file', hash: 'a'.repeat(40), mode: '100644', text })).toBeNull();
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'README.md': 'Base\n' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    expect(unwrap(await harness.submit('unicode', { title: 'Add generated text', summary: 'Record generated text.', baseCommit: base, files: [{ path: 'large.txt', content: text }] })))
      .toMatchObject({ status: 'attention', policy: { requirements: expect.arrayContaining([expect.objectContaining({ label: 'File review', satisfied: false })]) } });
  });

  it('reverts binary content and the executable bit through the authorized queue', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'old\0asset' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const changed = harness.git.commitTree({ 'asset.bin': 'new\0asset' }, base);
    const blob = harness.git.native(['rev-parse', `${changed}:asset.bin`]).trim();
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
    const change = unwrap(await harness.submit('binary', { title: 'Replace binary', summary: 'Update asset.', baseCommit: base,
      files: [{ path: 'asset.bin', blob, mode: '100755' }] }));
    const index = parseInt(change.id[3], 16), shard = harness.shard(index);
    unwrap(await shard.approve(harness.context(owner, index), change.id, { revision: 1 }));
    await harness.settle();
    expect(unwrap(await shard.get(change.id)).status).toBe('landed');
    expect(harness.git.native(['ls-tree', 'main', 'asset.bin'])).toContain('100755');
    const reverted = unwrap(await shard.revert(harness.context(owner, index), change.id, 'binary-revert-0001'));
    await harness.settle();
    expect(unwrap(await harness.shard(parseInt(reverted.id[3], 16)).get(reverted.id)).status).toBe('landed');
    expect(harness.git.native(['ls-tree', 'main', 'asset.bin'])).toBe(harness.git.native(['ls-tree', base, 'asset.bin']));
    expect(JSON.parse(harness.git.native(['notes', '--ref=braid', 'show', 'main']))).toMatchObject({ change: { number: reverted.number } });
  });

  it('accepts changes whose original files exceed the old 6 MiB total', async () => {
    harness = await changeHarness();
    const original = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`file-${i}.txt`, `${i}\n${'x'.repeat(900_000)}`]));
    const base = harness.git.commitTree(original);
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const change = unwrap(await harness.submit('large-base', { title: 'Replace generated text', summary: 'Reduce the generated files.', baseCommit: base,
      files: Object.keys(original).map(path => ({ path, content: 'replacement\n' })) }));
    expect(change.files).toHaveLength(8);
  });

  it('scans binary and large content across chunk boundaries without materializing a whole blob', async () => {
    const secret = `ghp_${'aB3d'.repeat(9)}`, text = `${'x'.repeat(32_760)}\n${secret}\0${'y'.repeat(2_000_000)}`;
    const blob = new Blob([text]);
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('No buffering'));
    expect((await scanBlob('asset.bin', blob)).findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'secrets' })]));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('escalates truncated hunks and file headers that exhaust context even when source text fits', async () => {
    const run = vi.fn(), common = { title: 'Large', intent: '', summary: '', rationale: '', instructions: [], notes: [] };
    for (const files of [
      [{ path: 'large.txt', before: '', after: 'line\n'.repeat(12_000) }],
      Array.from({ length: 1000 }, (_, i) => ({ path: `${i}/${'x'.repeat(200)}`, before: '', after: 'x' })),
    ]) expect(await hostedReview({ run } as unknown as Ai, 'fixture', { ...common, files })).toMatchObject({ verdict: 'escalate' });
    expect(run).not.toHaveBeenCalled();
  });

  it('shows binary revision changes instead of confusing unreadable text with deletion', async () => {
    harness = await changeHarness();
    const base = harness.git.commitTree({ 'asset.bin': 'base\0' });
    harness.git.native(['update-ref', 'refs/heads/main', base]);
    const first = harness.git.commitTree({ 'asset.bin': 'first\0' }, base), second = harness.git.commitTree({ 'asset.bin': 'second\0' }, base);
    const edit = (commit: string) => [{ path: 'asset.bin', blob: harness!.git.native(['rev-parse', `${commit}:asset.bin`]).trim() }];
    const change = unwrap(await harness.submit('binary', { title: 'Revise asset', summary: 'Update asset.', baseCommit: base, files: edit(first) }));
    const index = parseInt(change.id[3], 16), shard = harness.shard(index);
    unwrap(await shard.revise(harness.context('binary', index), change.id, { previousRevision: 1, baseCommit: base, files: edit(second), summary: 'Update again.' }, 'binary-revision-key'));
    expect(unwrap(await shard.diff(harness.repository, change.id, 'asset.bin'))).toMatchObject({ binary: true });
    expect(unwrap(await shard.compare(harness.repository, change.id, 1))).toMatchObject({ files: [{ path: 'asset.bin', additions: 0, deletions: 0 }] });
    expect(unwrap(await shard.compare(harness.repository, change.id, 1)).files[0]).not.toHaveProperty('deleted');
  });
});
