import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitFiles, pushCommits } from './push';
import { gitBlobHash } from './objects';
import { startGitServer } from '../test/git-server';

let git: Awaited<ReturnType<typeof startGitServer>>;
let root: string, remote: string, native: typeof git.native, repository: typeof git.repository, requests: typeof git.requests;
beforeAll(async () => { git = await startGitServer(); ({ root, remote, native, repository, requests } = git); });
afterAll(async () => { await git?.close(); });
it('creates real Git objects, pushes integration, and refuses a stale base', async () => {
  const initial = await commitFiles({ remote, token: 'fixture?expires=123', branch: 'main', files: { 'src/index.ts': 'export const value = 1;\n' }, message: 'Initialize fixture', initialize: true });
  expect(initial).toMatch(/^[a-f0-9]{40}$/);
  let receipt: string | undefined;
  const selectedFiles = { 'src/index.ts': 'export const value = 2;\n', '.braid/decision.json': '{"reason":"Reviewed"}\n' };
  const next = await commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: initial, files: selectedFiles, message: 'Integrate reviewed fixture', onPrepared: async commit => { receipt = commit; } });
  expect(next).not.toEqual(initial);
  expect(receipt).toBe(next);
  const recovered = await commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: initial, files: selectedFiles, message: 'Retry after losing the successful response', preparedCommit: receipt });
  expect(recovered).toBe(next);
  expect(native(['show', 'main:.braid/decision.json'])).toContain('Reviewed');
  await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: initial, files: { 'src/index.ts': 'SHOULD NOT SHIP' }, message: 'Stale update' })).rejects.toThrow(/branch moved/);
  expect(native(['rev-parse', 'main']).trim()).toEqual(next);
}, 20_000);

it('publishes a small patch without fetching a large repository, preserving untouched objects and file modes', async () => {
  const base = native(['rev-parse', 'main']).trim();
  const binaryPath = join(root, 'large.bin');
  writeFileSync(binaryPath, randomBytes(12 * 1024 * 1024));
  const large = native(['hash-object', '-w', binaryPath]).trim();
  const script = native(['hash-object', '-w', '--stdin'], '#!/bin/sh\nexit 0\n').trim();
  const link = native(['hash-object', '-w', '--stdin'], 'src/index.ts').trim();
  const tree = native(['mktree', '-z'], native(['ls-tree', '-z', base]) + `100644 blob ${large}\tlarge.bin\0` + `100755 blob ${script}\trun.sh\0` + `120000 blob ${link}\tlink\0` + `160000 commit ${base}\tdependency\0`).trim();
  const seeded = native(['commit-tree', tree, '-p', base], 'Large fixture\n').trim();
  native(['update-ref', 'refs/heads/main', seeded, base]);
  const start = requests.length;
  const commit = await commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: seeded,
    files: { 'docs/é.txt': 'A small UTF-8 change.\n', 'run.sh': '#!/bin/sh\nexit 1\n' }, message: 'A bounded patch in a large repository' });
  expect(native(['rev-parse', 'main:large.bin']).trim()).toBe(large);
  expect(native(['rev-parse', 'main:link']).trim()).toBe(link);
  expect(native(['rev-parse', 'main:dependency']).trim()).toBe(base);
  expect(native(['ls-tree', 'main', 'dependency'])).toMatch(/^160000 commit /);
  expect(native(['ls-tree', 'main', 'run.sh'])).toMatch(/^100755 /);
  expect(native(['show', 'main:docs/é.txt'])).toBe('A small UTF-8 change.\n');
  expect(native(['rev-parse', `${commit}^`]).trim()).toBe(seeded);
  expect(requests.slice(start).every(r => !r.path.includes('upload-pack'))).toBe(true);
  expect(requests.slice(start).find(r => r.path.endsWith('/git-receive-pack'))!.bytes).toBeLessThan(10_000);
  native(['fsck', '--full', '--no-dangling']);
  for (const path of ['link', 'link/child.txt']) {
    await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: commit, files: { [path]: 'unsafe' }, message: 'Reject symlink' })).rejects.toThrow(/symlinks/);
  }
  for (const path of ['dependency', 'dependency/child.txt', 'src']) {
    await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: commit, files: { [path]: 'unsafe' }, message: 'Reject type replacement' })).rejects.toThrow(/cannot replace/);
  }
  expect(native(['rev-parse', 'main']).trim()).toBe(commit);
}, 20_000);

it('rejects a branch advance between preparing and pushing the commit', async () => {
  const base = native(['rev-parse', 'main']).trim();
  const competing = native(['commit-tree', native(['rev-parse', 'main^{tree}']).trim(), '-p', base], 'Concurrent commit\n').trim();
  await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, files: { 'race.txt': 'Must not ship\n' }, message: 'Competing write',
    onPrepared: async () => { native(['update-ref', 'refs/heads/main', competing, base]); },
  })).rejects.toThrow(/branch changed or rejected/);
  expect(native(['rev-parse', 'main']).trim()).toBe(competing);
});

it('does not send a push after authorization fails or a change exceeds the bounded memory budget', async () => {
  const base = native(['rev-parse', 'main']).trim(), start = requests.length;
  await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, files: { 'safe.txt': 'A change' }, message: 'Revoked before push',
    onPrepared: async () => { throw new Error('Owner access revoked'); },
  })).rejects.toThrow('Owner access revoked');
  await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, files: { 'large.txt': 'x'.repeat(29_000_001) }, message: 'Oversize update' })).rejects.toThrow('Cloudflare Artifacts accepts about 30 MB per push');
  expect(requests.slice(start).some(r => r.path.endsWith('/git-receive-pack'))).toBe(false);
  expect(native(['rev-parse', 'main']).trim()).toBe(base);
});

it('never accepts incomplete or rejected receive-pack acknowledgments as a successful push', async () => {
  const base = native(['rev-parse', 'main']).trim(), fetcher = globalThis.fetch;
  const packet = (line: string) => (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line;
  for (const body of [
    packet('unpack ok\n') + '0000',
    packet('unpack ok\n') + packet('ng refs/heads/main denied\n') + '0000',
    packet('unpack ok\n') + packet('ok refs/heads/other\n') + '0000',
    packet('unpack ok\n') + packet('ok refs/heads/main\n'),
  ]) {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => options?.method === 'POST' ? Promise.resolve(new Response(body)) : fetcher(input, options));
    try {
      await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, files: { 'report.txt': 'Unconfirmed' }, message: 'Require a complete acknowledgment' })).rejects.toThrow(/branch changed or rejected/);
    } finally { mock.mockRestore(); }
  }
  expect(native(['rev-parse', 'main']).trim()).toBe(base);
});
it('reads a full repository from the answer to a landing or a proposal, as every push does', async () => {
  const base = native(['rev-parse', 'main']).trim(), fetcher = globalThis.fetch;
  const full = (Buffer.byteLength('ERR artifacts_git_receive_pack_storage_limit\n') + 4).toString(16).padStart(4, '0') + 'ERR artifacts_git_receive_pack_storage_limit\n0000';
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => options?.method === 'POST' ? Promise.resolve(new Response(full)) : fetcher(input, options));
  try {
    await expect(pushCommits({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, commits: [{ files: { 'full.txt': 'No room\n' }, message: 'Land into a full repository' }] }))
      .rejects.toMatchObject({ name: 'GitError', code: 'full', message: 'This repository reached its storage limit.' });
    await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, files: { 'full.txt': 'No room\n' }, message: 'Publish into a full repository' }))
      .rejects.toMatchObject({ name: 'GitError', code: 'full' });
  } finally { mock.mockRestore(); }
  expect(native(['rev-parse', 'main']).trim()).toBe(base);
});
it('uses Workers-supported manual redirects and never forwards Git credentials to a redirect target', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => {
    expect(options?.redirect).toBe('manual');
    return new Response(null, { status: 307, headers: { location: 'https://untrusted.example/repo.git' } });
  });
  try {
    await expect(commitFiles({ remote: 'https://git.example/repo.git', token: 'private-git-token', branch: 'main', files: { 'README.md': 'Updated' }, message: 'Redirect blocked' })).rejects.toThrow('Git redirects are not allowed. No credentials were forwarded.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('https://git.example/');
  } finally { fetcher.mockRestore(); }
});

it('parents an isolated proposal on its pinned base even when the fork ref advanced', async () => {
  const base = native(['rev-parse', 'main']).trim();
  const advanced = await commitFiles({ repository, remote, token: 'fixture', branch: 'late-fork', initialize: true, parentCommit: base, files: { 'arrived-later.txt': 'Other task\n' }, message: 'Simulate main advancing before fork' });
  const result = await commitFiles({ repository, remote, token: 'fixture', branch: 'late-fork', expectedHead: advanced, parentCommit: base, files: { 'this-task.txt': 'Pinned task\n' }, message: 'Pinned proposal' });
  expect(native(['show', '-s', '--format=%P', result]).trim()).toBe(base);
  expect(native(['ls-tree', '--name-only', result])).not.toContain('arrived-later.txt');
  expect(native(['show', `${result}:this-task.txt`])).toBe('Pinned task\n');
  expect(native(['rev-parse', 'main']).trim()).toBe(base);
});

it('publishes text deletions, empty files and executable changes while pruning empty ancestor trees', async () => {
  const base = native(['rev-parse', 'main']).trim();
  const seeded = await commitFiles({ repository, remote, token: 'fixture', branch: 'edit-files', initialize: true, parentCommit: base,
    files: { 'remove/deep/only.txt': 'remove\n', 'mode.sh': { content: '#!/bin/sh\n', mode: '100644' }, 'keep/sibling.txt': 'keep\n' }, message: 'Seed edit fixture' });
  const next = await commitFiles({ repository, remote, token: 'fixture', branch: 'edit-files', expectedHead: seeded,
    files: { 'remove/deep/only.txt': null, 'mode.sh': { content: '#!/bin/sh\n', mode: '100755' }, 'empty.txt': '' }, message: 'Delete and chmod' });
  expect(native(['ls-tree', '--name-only', next])).not.toMatch(/^remove$/m);
  expect(native(['ls-tree', next, 'mode.sh'])).toMatch(/^100755 /);
  expect(native(['show', `${next}:empty.txt`])).toBe('');
  expect(native(['show', `${next}:keep/sibling.txt`])).toBe('keep\n');
  expect(native(['rev-parse', 'main']).trim()).toBe(base);
  for (const path of ['link', 'dependency']) await expect(commitFiles({ repository, remote, token: 'fixture', branch: 'edit-files', expectedHead: next, files: { [path]: null }, message: 'Unsupported deletion' })).rejects.toThrow(/symlink|submodule/);
  native(['fsck', '--full', '--no-dangling']);
});

it('lands a chain of change commits with one compare-and-swap push and recovers a lost response', async () => {
  const base = native(['rev-parse', 'main']).trim();
  let prepared: string[] = [];
  const commits = await pushCommits({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, onPrepared: async chain => { prepared = chain; }, commits: [
    { files: { 'queue/one.txt': 'one\n' }, message: 'Change one', authorName: 'Atlas (Braid)', authorEmail: 'atlas@agents.braid.local' },
    { files: { 'queue/two.txt': 'two\n', 'queue/one.txt': 'one, revised by the second change\n' }, message: 'Change two' },
    { files: { 'queue/two.txt': null }, message: 'Change three' },
  ] });
  expect(commits).toEqual(prepared);
  expect(native(['rev-parse', 'main']).trim()).toBe(commits[2]);
  expect(native(['rev-list', '--first-parent', `${base}..main`]).trim().split('\n').reverse()).toEqual(commits);
  expect(native(['show', `${commits[0]}:queue/one.txt`])).toBe('one\n');
  expect(native(['show', `${commits[1]}:queue/one.txt`])).toBe('one, revised by the second change\n');
  expect(native(['ls-tree', '--name-only', '-r', commits[2]])).not.toContain('queue/two.txt');
  expect(native(['show', '-s', '--format=%an <%ae>', commits[0]]).trim()).toBe('Atlas (Braid) <atlas@agents.braid.local>');
  // The same plan after a lost acknowledgment is recognised without a second push.
  expect(await pushCommits({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, prepared: commits, commits: [{ files: { 'x.txt': 'x' }, message: 'Unused' }] })).toEqual(commits);
  await expect(pushCommits({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, commits: [{ files: { 'stale.txt': 'no' }, message: 'Stale' }] })).rejects.toThrow(/branch moved/);
  expect(await gitBlobHash('one\n')).toBe(native(['rev-parse', `${commits[0]}:queue/one.txt`]).trim());
  native(['fsck', '--full', '--no-dangling']);
});

it('records an integrated pull request head as a second parent', async () => {
  const base = native(['rev-parse', 'main']).trim();
  const side = native(['commit-tree', native(['rev-parse', 'main^{tree}']).trim(), '-p', base], 'Pull request head\n').trim();
  native(['update-ref', 'refs/heads/pull-head', side]);
  const [merged] = await pushCommits({ repository, remote, token: 'fixture', branch: 'main', expectedHead: base, commits: [{ files: { 'pr.txt': 'from a pull request\n' }, message: 'Land pull request', extraParents: [side] }] });
  expect(native(['show', '-s', '--format=%P', merged]).trim()).toBe(`${base} ${side}`);
  expect(native(['merge-base', '--is-ancestor', side, 'main'])).toBe('');
});
