import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { copyBranches, HISTORY_REF, type HistoryCopy } from './branches';
import { startGitServer } from '../test/git-server';

let git: Awaited<ReturnType<typeof startGitServer>>;
let main: string[], feature: string, stable: string;
const copyPath = () => join(git.root, 'copy.git');
const copy = (args: string[]) => execFileSync('git', ['--git-dir', copyPath(), ...args], { encoding: 'utf8' });
const has = (hash: string) => { try { copy(['cat-file', '-e', hash]); return true; } catch { return false; } };

beforeAll(async () => {
  git = await startGitServer();
  // main is eight commits long; feature/login branches from its second commit and stable from its tip.
  main = [];
  for (let n = 1; n <= 8; n++) main.push(git.commitTree({ [`src/${n}.ts`]: `export const n = ${n};\n` }, main.at(-1), `Commit ${n}`));
  feature = git.commitTree({ 'src/login.ts': 'export const login = true;\n' }, main[1]);
  stable = git.commitTree({ 'src/stable.ts': 'export const stable = true;\n' }, main[7]);
  git.native(['update-ref', 'refs/heads/main', main[7]]);
  git.native(['update-ref', 'refs/heads/feature/login', feature]);
  git.native(['update-ref', 'refs/heads/stable', stable]);
});
afterAll(async () => { await git?.close(); });
// Each test starts from what Artifacts makes of an import: the default branch alone, one commit deep, taking shallow pushes.
beforeEach(() => {
  rmSync(copyPath(), { recursive: true, force: true });
  execFileSync('git', ['clone', '--quiet', '--bare', '--depth', '1', '--branch', 'main', `file://${join(git.root, 'repo.git')}`, copyPath()]);
  copy(['config', 'http.receivepack', 'true']);
  copy(['config', 'receive.shallowUpdate', 'true']);
});

const source = () => ({ remote: git.remote, token: 'source-token' });
const target = () => ({ remote: git.remote.replace(/repo\.git$/, 'copy.git'), token: 'copy-token', username: 'x-access-token' });
/** As Artifacts reads the copy: a commit's parents come from its object, whether or not the copy has them yet. */
async function missing(boundary: string[]) {
  const found = { boundary: [] as string[], parents: [] as string[] };
  for (const hash of boundary.filter(has)) {
    const parents = copy(['cat-file', 'commit', hash]).split('\n\n', 1)[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)).filter(parent => !has(parent));
    if (parents.length) { found.boundary.push(hash); found.parents.push(...parents); }
  }
  return found;
}
const history = (state: HistoryCopy, saves: (HistoryCopy | undefined)[] = []) => ({ copy: state, missing, saved: async (part: HistoryCopy | undefined) => { saves.push(part); } });

it('copies the history beneath the import in growing parts, then every other branch with only its own commits', async () => {
  const saves: (HistoryCopy | undefined)[] = [];
  expect(main.slice(0, 7).some(has)).toBe(false);
  const result = await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() + 60_000, history: history({ boundary: [main[7]], depth: 2 }, saves) });
  expect(result).toEqual({ branches: ['main', 'feature/login', 'stable'], failed: [], remaining: 0 });
  // Two commits, then four, then the last part reaches the root.
  expect(saves).toEqual([{ boundary: [main[5]], depth: 4, copied: 2 }, { boundary: [main[1]], depth: 8, copied: 6 }, undefined]);
  expect(main.every(has)).toBe(true);
  expect(copy(['rev-parse', HISTORY_REF]).trim()).toBe(main[0]);
  expect(copy(['rev-parse', 'feature/login', 'stable']).split('\n').filter(Boolean)).toEqual([feature, stable]);
  expect(copy(['show', 'feature/login:src/login.ts'])).toBe('export const login = true;\n');
  // History in place, a later run has nothing left to copy.
  expect(await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() + 60_000 }))
    .toEqual({ branches: ['main', 'feature/login', 'stable'], failed: [], remaining: 0 });
});

it('copies history before branches, stops at its deadline and reports what is left', async () => {
  expect(await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() - 1, history: history({ boundary: [main[7]] }) }))
    .toEqual({ branches: ['main'], failed: [], remaining: 2, history: { boundary: [main[7]] } });
  expect(await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() + 60_000, skip: new Set(['stable']), history: history({ boundary: [main[7]] }) }))
    .toEqual({ branches: ['main', 'feature/login'], failed: [], remaining: 0 });
  expect(main.every(has)).toBe(true);
});

it('keeps copying when the copy refuses one branch', async () => {
  const hook = join(copyPath(), 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/stable" ]; then echo "declined"; exit 1; fi; done\n');
  chmodSync(hook, 0o755);
  expect(await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() + 60_000, history: history({ boundary: [main[7]] }) }))
    .toEqual({ branches: ['main', 'feature/login'], failed: ['stable'], remaining: 0 });
});

it('narrows a part the copy would refuse and stops at one commit larger than a push may carry', async () => {
  const large = await startGitServer();
  try {
    // Random bytes do not compress, and the next commit removes them, so the import's tree never carried them.
    const first = large.commitTree({ 'README.md': '# Large\n' });
    const heavy = large.commitTree({ 'data.bin': randomBytes(48 * 1024).toString('base64') }, first);
    const third = large.commitTree({ 'data.bin': null, 'src/a.ts': 'export const a = 1;\n' }, heavy);
    const tip = large.commitTree({ 'src/b.ts': 'export const b = 2;\n' }, third);
    large.native(['update-ref', 'refs/heads/main', tip]);
    rmSync(copyPath(), { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--bare', '--depth', '1', '--branch', 'main', `file://${join(large.root, 'repo.git')}`, copyPath()]);
    copy(['config', 'http.receivepack', 'true']); copy(['config', 'receive.shallowUpdate', 'true']);
    const saves: (HistoryCopy | undefined)[] = [];
    const result = await copyBranches({ source: { remote: large.remote, token: '' }, target: target(), defaultBranch: 'main', until: Date.now() + 60_000, partBytes: 16 * 1024, history: history({ boundary: [tip], depth: 4 }, saves) });
    // Four deep is refused, one deep copies the third commit, and the heavy one alone is still refused.
    expect(saves).toEqual([{ boundary: [tip], depth: 1 }, { boundary: [third], depth: 2, copied: 1 }, { boundary: [third], depth: 1, copied: 1 }, { boundary: [third], depth: 1, copied: 1, stopped: true }]);
    expect(result).toEqual({ branches: ['main'], failed: [], remaining: 0, history: { boundary: [third], depth: 1, copied: 1, stopped: true } });
    expect([has(third), has(heavy), has(first)]).toEqual([true, false, false]);
  } finally { await large.close(); }
});

it('stops history at its limit, and leaves the other branches out when asked for the default alone', async () => {
  const saves: (HistoryCopy | undefined)[] = [];
  expect(await copyBranches({ source: source(), target: target(), defaultBranch: 'main', until: Date.now() + 60_000, defaultOnly: true, history: history({ boundary: [main[7]], depth: 2, limit: 3 }, saves) }))
    .toEqual({ branches: ['main'], failed: [], remaining: 0, history: { boundary: [main[4]], depth: 2, copied: 3, limit: 3, stopped: true } });
  // Two commits, then the one the limit has room for.
  expect(saves).toEqual([{ boundary: [main[5]], depth: 4, copied: 2, limit: 3 }, { boundary: [main[4]], depth: 2, copied: 3, limit: 3 }, { boundary: [main[4]], depth: 2, copied: 3, limit: 3, stopped: true }]);
  expect([main[4], main[3]].map(has)).toEqual([true, false]);
  expect(copy(['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main\n');
});

it('sends each part of history as changes beneath the boundary, not another snapshot of the repository', async () => {
  const large = await startGitServer();
  try {
    // A large file every commit edits a little: whole, each part would carry it again.
    const text = randomBytes(64 * 1024).toString('base64');
    let tip = large.commitTree({ 'data.txt': text });
    const commits = [tip];
    for (let n = 1; n < 8; n++) commits.push(tip = large.commitTree({ 'data.txt': `${text}\n${n}\n` }, tip));
    large.native(['update-ref', 'refs/heads/main', tip]);
    rmSync(copyPath(), { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--bare', '--depth', '1', '--branch', 'main', `file://${join(large.root, 'repo.git')}`, copyPath()]);
    copy(['config', 'http.receivepack', 'true']); copy(['config', 'receive.shallowUpdate', 'true']);
    const start = git.requests.length;
    const result = await copyBranches({ source: { remote: large.remote, token: '' }, target: target(), defaultBranch: 'main', until: Date.now() + 60_000, history: history({ boundary: [tip], depth: 2 }) });
    expect(result.history).toBeUndefined();
    expect(commits.every(has)).toBe(true);
    // Three parts reach the root; one copy of the file alone is about 64 KiB compressed.
    const pushed = git.requests.slice(start).filter(request => request.path.startsWith('/copy.git/git-receive-pack'));
    expect(pushed).toHaveLength(3);
    expect(pushed.reduce((total, request) => total + request.bytes, 0)).toBeLessThan(16 * 1024);
    expect(copy(['show', `${commits[3]}:data.txt`])).toBe(`${text}\n3\n`);
    copy(['fsck', '--full', '--no-dangling']);
  } finally { await large.close(); }
});
