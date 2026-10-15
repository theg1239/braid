import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { committedFiles, decodeText, LIMITS, treeEntries, validPath } from './collect';
import { realDirectory } from './config';
import { fail, type BraidContext } from './context';
import { isAncestor, REGULAR, strict, strictGit } from './git';
import type { Payload } from './schemas';
import { assertNoSecrets } from './secrets';

/*
 * A task checkout is a directory Braid prepared for one task, or a clean clone bound to it. Every command checks it
 * the way braid.mjs does: the directory is the real root of a full checkout, HEAD keeps the task's base in its
 * history, and work is read from Git's objects, or for checkouts from older releases from the working tree without
 * running any of the repository's filters.
 */

/** An existing sparse or partial checkout must never silently become an agent's whole repository. */
function assertFullCheckout(context: BraidContext, root: string) {
  const config = strict(context, ['config', '--local', '--list', '--null'], { cwd: root }).toString('utf8');
  if (/(?:^|\0)core\.sparsecheckout\n(?:true|1|yes|on)(?:\0|$)/i.test(config) || /(?:^|\0)(?:extensions\.partialclone|remote\.[^\n]+\.promisor)\n/i.test(config)
    || strict(context, ['ls-files', '-t', '-z'], { cwd: root }).toString('utf8').split('\0').some(entry => entry.startsWith('S ')))
    fail('Agents need a full repository checkout. Disable sparse checkout and materialize all files, or use braid task start with --dir NEW_DIRECTORY.');
}

/** The checkout at `dir`, which must be the real root of a full Git checkout. */
export function checkoutRoot(context: BraidContext, dir: string) {
  const root = realpathSync(realDirectory(resolve(context.cwd, dir)));
  const entry = lstatSync(join(root, '.git'));
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('Invalid Git checkout metadata.');
  if (realpathSync(strict(context, ['rev-parse', '--show-toplevel'], { cwd: root }).toString('utf8').trim()) !== root) fail('Run this from the root of the task checkout, or name it with --dir.');
  assertFullCheckout(context, root);
  return root;
}

/** HEAD must keep at least one of the given task bases in its history. */
export function pinnedBase(context: BraidContext, root: string, ...commits: (string | undefined)[]) {
  const bases = commits.filter((commit): commit is string => commit !== undefined);
  if (!bases.length || !bases.some(commit => isAncestor(context, root, commit))) fail('HEAD must descend from the task\'s base commit. Keep the task\'s history before submitting.');
}

/* ---------- reading work from the working tree, for checkouts from older releases ---------- */

const LIMIT_MESSAGE = 'Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.';

/** A repository path as a file inside the checkout, refusing symlinks and special files on the way there. */
function checkedFile(root: string, path: string, mode = '100644', allowMissing = false) {
  const parts = path.split('/'), full = resolve(root, path), fromRoot = relative(root, full);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || parts.some(part => !part || part === '.' || part === '..') || path.includes('\\')) fail('Repository paths must stay inside the checkout.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return fail('Deleted or missing files cannot be submitted.');
    }
    const leaf = index === parts.length - 1;
    if (stat.isSymbolicLink() && !(leaf && mode === '120000')) fail('Symlinks cannot be submitted or followed.');
    const supported = !leaf || mode === '160000' ? stat.isDirectory() : mode === '120000' ? stat.isSymbolicLink() : stat.isFile();
    if (!supported) fail('Only regular files can be submitted; changes to symlinks, submodules and special files are unsupported.');
  }
  return full;
}

/** A file's bytes and its Git object id, hashed as it is read, refusing a file that changes meanwhile. */
function readBlob(path: string, algorithm: 'sha1' | 'sha256') {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) fail('Only regular files can be submitted.');
    const hash = createHash(algorithm).update(`blob ${before.size}\0`), chunk = Buffer.alloc(65_536), kept: Buffer[] = [];
    let size = 0, count;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, count));
      if (size + count <= LIMITS.bytes) kept.push(Buffer.from(chunk.subarray(0, count)));
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('A file changed while braid read the proposal. Retry when edits are finished.');
    return { hash: hash.digest('hex'), size, bytes: size <= LIMITS.bytes ? Buffer.concat(kept) : null };
  } finally { closeSync(fd); }
}

/** Whether a symlink or submodule the base has is still exactly as it was, so it can be left out of the proposal. */
function unchangedSpecialEntry(context: BraidContext, root: string, path: string, prior: Entry | undefined, staged: Entry | undefined, algorithm: 'sha1' | 'sha256') {
  if (!prior || !staged || prior.mode !== staged.mode || prior.hash !== staged.hash) return false;
  const full = checkedFile(root, path, prior.mode)!;
  if (prior.mode === '120000') {
    // Hash the link itself; never read its target, even outside the checkout.
    const target = readlinkSync(full, { encoding: 'buffer' });
    return createHash(algorithm).update(`blob ${target.length}\0`).update(target).digest('hex') === prior.hash;
  }
  if (prior.mode === '160000') {
    // A fresh --no-recurse-submodules checkout leaves an empty directory.
    if (!existsSync(join(full, '.git'))) return readdirSync(full).length === 0;
    return strict(context, ['rev-parse', '--verify', 'HEAD'], { cwd: full }).toString('utf8').trim() === prior.hash
      && strict(context, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], { cwd: full }).length === 0;
  }
  return false;
}
interface Entry { mode: string; hash: string }

/** Staged, unstaged and untracked edits against the base, read from the working tree without Git's filters. */
function workingFiles(context: BraidContext, root: string, base: string, index: string[], secrets: readonly string[]) {
  const staged = new Map<string, Entry>();
  for (const entry of index) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0') fail('Resolve the Git index before submitting.');
    staged.set(match[4], { mode: match[1], hash: match[2] });
  }
  const before = treeEntries(context, root, base);
  const untracked = strict(context, ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const files: Payload['files'] = [], algorithm = base.length === 64 ? 'sha256' : 'sha1';
  for (const path of [...new Set([...before.keys(), ...staged.keys(), ...untracked])].sort()) {
    const prior = before.get(path), entry = staged.get(path);
    if ([prior, entry].some(item => item && !REGULAR.has(item.mode))) {
      if (unchangedSpecialEntry(context, root, path, prior, entry, algorithm)) continue;
      fail('Symlinks and submodules cannot be submitted.');
    }
    const full = checkedFile(root, path, '100644', true);
    if (!full) {
      if (prior) {
        if (!validPath(path)) fail(`${path} is a protected or invalid path for a proposal.`);
        files.push({ path, content: null });
      }
      continue;
    }
    const blob = readBlob(full, algorithm);
    const mode = (lstatSync(full).mode & 0o111) ? '100755' : '100644';
    checkedFile(root, path);
    if (blob.hash === prior?.hash && mode === prior?.mode) continue;
    if (!validPath(path)) fail(`${path} is a protected or invalid path for a proposal.`);
    if (blob.size > LIMITS.bytes) fail(LIMIT_MESSAGE);
    const content = decodeText(blob.bytes!);
    assertNoSecrets(content, secrets, `${path} looks like it contains a credential. Remove it before submitting.`);
    files.push({ path, content, ...(mode !== (prior?.mode ?? '100644') ? { mode } : {}) });
  }
  return files;
}

/**
 * The complete proposal from the task's base. Checkouts made by `braid task start` submit committed work only, so
 * HEAD must be clean and the proposal is HEAD's tree; older checkouts submit their working tree. Either way, a change
 * to HEAD, the index or (for committed work) the working tree while reading is refused.
 */
export function collectProposal(context: BraidContext, root: string, base: string, secrets: readonly string[], committed: boolean) {
  pinnedBase(context, root, base);
  const state = () => ({
    head: strict(context, ['rev-parse', '--verify', 'HEAD'], { cwd: root }).toString('utf8').trim(),
    index: strict(context, ['ls-files', '--stage', '-z'], { cwd: root }).toString('utf8'),
    dirty: committed && strictGit(context, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { cwd: root }).stdout.length > 0,
  });
  const before = state();
  if (before.dirty) fail('Commit the work you want reviewed before submitting. Keep unrelated files out of this checkout.');
  const files = committed ? committedFiles(context, root, base, before.head, secrets) : workingFiles(context, root, base, before.index.split('\0').filter(Boolean), secrets);
  pinnedBase(context, root, base);
  const after = state();
  if (after.head !== before.head || after.index !== before.index || after.dirty) fail('The checkout changed while braid read the proposal. Retry when edits are finished.');
  if (!files.length) fail('There are no changed files to submit.');
  return files;
}
