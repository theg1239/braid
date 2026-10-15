import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { advertisement, concat, FLUSH, pktLine, readSection, relay, updateRef, ZERO } from './transport';
import { pushCommits } from './push';
import { startGitServer } from '../test/git-server';

let git: Awaited<ReturnType<typeof startGitServer>>;
let other: { remote: string; native: (args: string[]) => string; path: string };
beforeAll(async () => {
  git = await startGitServer();
  const path = join(git.root, 'other.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', path], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', path, 'config', 'http.receivepack', 'true']);
  other = { path, remote: git.remote.replace(/repo\.git$/, 'other.git'), native: args => execFileSync('git', ['--git-dir', path, ...args], { encoding: 'utf8' }) };
});
afterAll(async () => { await git?.close(); });

const source = () => ({ remote: git.remote, token: 'source-token' });
const target = () => ({ remote: other.remote, token: 'target-token', username: 'x-access-token' });

it('reads command metadata separately from a large pack in the same network chunk', async () => {
  const line = `${ZERO} ${'a'.repeat(40)} refs/for/main\0report-status\n`;
  const pack = new Uint8Array(128_000).fill(42);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(concat([pktLine(line), FLUSH, pack])); controller.close(); } });
  const result = await readSection(body);
  expect(result.lines).toEqual([line]);
  expect(new Uint8Array(await new Response(result.rest).arrayBuffer())).toEqual(pack);
});

it('bounds the whole command section and rejects partially hexadecimal packet lengths', async () => {
  const packets = [pktLine('a'.repeat(40)), pktLine('b'.repeat(40)), FLUSH];
  const body = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = packets.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } });
  await expect(readSection(body, 64)).rejects.toThrow(/more than it should/);
  await expect(readSection(new Blob(['00zz']).stream())).rejects.toThrow(/not a Git request/);
});

it('mirrors history between hosts and then sends only new objects', async () => {
  const first = git.commitTree({ 'README.md': '# Mirror\n', 'src/a.ts': 'export const a = 1;\n' });
  const second = git.commitTree({ 'src/b.ts': 'export const b = 2;\n' }, first);
  git.native(['update-ref', 'refs/heads/main', second]);
  await relay({ source: source(), target: target(), want: second, ref: 'refs/heads/main', expected: ZERO });
  expect(other.native(['rev-parse', 'main']).trim()).toBe(second);
  expect(other.native(['show', 'main:src/b.ts'])).toBe('export const b = 2;\n');
  other.native(['fsck', '--full', '--no-dangling']);

  const third = git.commitTree({ 'src/c.ts': 'export const c = 3;\n' }, second);
  git.native(['update-ref', 'refs/heads/main', third]);
  const start = git.requests.length;
  await relay({ source: source(), target: target(), want: third, ref: 'refs/heads/main', expected: second });
  expect(other.native(['rev-parse', 'main']).trim()).toBe(third);
  const upload = git.requests.slice(start).find(request => request.path.startsWith('/repo.git/git-upload-pack'))!;
  const receive = git.requests.slice(start).find(request => request.path.startsWith('/other.git/git-receive-pack'))!;
  expect(upload).toBeDefined();
  // One new blob, two trees and a commit: far smaller than the repository.
  expect(receive.bytes).toBeLessThan(2000);
  other.native(['fsck', '--full', '--no-dangling']);
  expect((await advertisement(target(), 'git-receive-pack')).refs.get('refs/heads/main')).toBe(third);
});

it('refuses to move a target ref that changed since it was read', async () => {
  const head = other.native(['rev-parse', 'main']).trim();
  const next = git.commitTree({ 'src/d.ts': 'export const d = 4;\n' }, git.native(['rev-parse', 'main']).trim());
  git.native(['update-ref', 'refs/heads/main', next]);
  await expect(relay({ source: source(), target: target(), want: next, ref: 'refs/heads/main', expected: ZERO })).rejects.toThrow(/moved/);
  expect(other.native(['rev-parse', 'main']).trim()).toBe(head);
});

it('fast-forwards a branch to a verified commit without sending objects again', async () => {
  const head = git.native(['rev-parse', 'main']).trim();
  const [staged] = await pushCommits({ repository: git.repository, remote: git.remote, token: 'fixture', branch: 'braid/verify/b1', expectedHead: ZERO, parent: head, commits: [{ files: { 'verified.txt': 'checked\n' }, message: 'Verified batch' }] });
  expect(git.native(['rev-parse', 'braid/verify/b1']).trim()).toBe(staged);
  expect(git.native(['rev-parse', 'main']).trim()).toBe(head);
  await expect(updateRef({ remote: git.remote, token: 'fixture' }, 'refs/heads/main', ZERO, staged)).rejects.toThrow(/moved/);
  await updateRef({ remote: git.remote, token: 'fixture' }, 'refs/heads/main', head, staged);
  expect(git.native(['rev-parse', 'main']).trim()).toBe(staged);
  // Repeating a completed update is harmless.
  await updateRef({ remote: git.remote, token: 'fixture' }, 'refs/heads/main', head, staged);
  git.native(['fsck', '--full', '--no-dangling']);
});

it('relays into a shallow import, including content restored from older history', async () => {
  const head = git.native(['rev-parse', 'main']).trim();
  // A shallow copy of the current head, like an Artifacts import with depth 1.
  const shallow = join(git.root, 'shallow.git');
  execFileSync('git', ['clone', '--bare', '--depth', '1', '--no-local', `file://${join(git.root, 'repo.git')}`, shallow], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', shallow, 'config', 'http.receivepack', 'true']);
  // Restore README content from the first commit: the blob exists only before the shallow boundary... and
  // reintroduce a file deleted earlier in history.
  const first = git.native(['rev-list', '--max-parents=0', 'main']).trim();
  const original = git.native(['show', `${first}:README.md`]);
  const changed = git.commitTree({ 'README.md': '# Mirror changed\n' }, head);
  const restored = git.commitTree({ 'README.md': original }, changed);
  git.native(['update-ref', 'refs/heads/main', restored]);
  const shallowTarget = { remote: git.remote.replace(/repo\.git$/, 'shallow.git'), token: 'target-token' };
  await relay({ source: source(), target: shallowTarget, want: restored, ref: 'refs/heads/main', expected: head, shallow: [head] });
  expect(execFileSync('git', ['--git-dir', shallow, 'show', 'main:README.md'], { encoding: 'utf8' })).toBe(original);
  execFileSync('git', ['--git-dir', shallow, 'fsck', '--no-dangling'], { stdio: 'ignore' });
});

it('sends a changed file as a delta against what the target has when the pack may be thin', async () => {
  const known = other.native(['rev-parse', 'main']).trim();
  const text = randomBytes(96 * 1024).toString('base64');
  const large = git.commitTree({ 'data.txt': text }, known);
  const edited = git.commitTree({ 'data.txt': `${text}\nedited\n` }, large);
  git.native(['update-ref', 'refs/heads/edited', edited]);
  await relay({ source: source(), target: target(), want: large, ref: 'refs/heads/base', expected: ZERO, have: [known] });
  const pushed = async (ref: string, thin?: true) => {
    const start = git.requests.length;
    await relay({ source: source(), target: target(), want: edited, ref, expected: ZERO, have: [large], ...(thin ? { thin } : {}) });
    return git.requests.slice(start).find(request => request.path.startsWith('/other.git/git-receive-pack'))!.bytes;
  };
  // Without thin the edited file travels whole; thin, only its delta against the copy the target has.
  expect(await pushed('refs/heads/whole')).toBeGreaterThan(64 * 1024);
  expect(await pushed('refs/heads/thin', true)).toBeLessThan(2048);
  expect(other.native(['show', 'thin:data.txt'])).toBe(`${text}\nedited\n`);
  other.native(['fsck', '--full', '--no-dangling']);
});

it('names a repository at its storage limit, which Artifacts holds to even for an update without objects', async () => {
  const head = 'a'.repeat(40), next = 'b'.repeat(40);
  const advertised = concat([pktLine('# service=git-receive-pack\n'), FLUSH, pktLine(`${head} refs/heads/main\0report-status delete-refs ofs-delta\n`), FLUSH]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('/info/refs')
    ? new Response(advertised, { headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } })
    : new Response(concat([pktLine('ERR artifacts_git_receive_pack_storage_limit\n'), FLUSH]), { headers: { 'content-type': 'application/x-git-receive-pack-result' } }));
  try {
    await expect(updateRef({ remote: 'https://artifacts.example/git/full.git', token: 'token' }, 'refs/heads/main', head, next)).rejects.toMatchObject({ name: 'GitError', code: 'full' });
  } finally { fetch.mockRestore(); }
});
