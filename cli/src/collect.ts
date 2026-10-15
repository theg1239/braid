import { resolve } from 'node:path';
import * as v from 'valibot';
import { readRegularFile } from './config';
import { fail, type BraidContext } from './context';
import { git, gitText, isAncestor, REGULAR } from './git';
import { testReports, type Payload } from './schemas';
import { assertNoSecrets } from './secrets';

/** Git objects pin committed content while the CLI validates a submission. */
export const LIMITS = { bytes: 32_000_000 - 1024 };
const LIMIT_MESSAGE = 'Cloudflare Artifacts limits each Git blob to 32 MB. Split this file before submitting.';

/** A repository path Braid accepts in a change: relative, inside the repository, and outside .git, .braid and credential files. */
export function validPath(path: string) {
  return path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(path) && !/[\uD800-\uDFFF]/u.test(path)
    && path.split('/').every(part => part && part !== '..' && part !== '.' && !['.git', '.braid'].includes(part.toLowerCase()))
    && !/(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?)(?:$|\/)/i.test(path);
}

/** File bytes as text, refusing anything that is not UTF-8 or that holds the control characters of a binary file. */
export function decodeText(bytes: Uint8Array) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('JSON submissions accept UTF-8 text. Use braid submit --push for binary files.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('Binary files use Git. Run braid submit --push.');
  return text;
}

interface Entry { mode: string; hash: string; size: number }

/** Every file in a commit's tree with its mode, object id and size. */
export function treeEntries(context: BraidContext, root: string, commit: string) {
  const entries = new Map<string, Entry>();
  const output = new TextDecoder('utf-8', { fatal: true }).decode(git(context, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], { cwd: root }));
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) fail('Git listed a tree entry braid cannot read.');
    entries.set(match[5], { mode: match[1], hash: match[3], size: match[4] === '-' ? 0 : Number(match[4]) });
  }
  return entries;
}

/** The files that differ between two commits, with their new content, or null for a deletion. */
export function committedFiles(context: BraidContext, root: string, base: string, head: string, secrets: readonly string[]) {
  const before = treeEntries(context, root, base), after = treeEntries(context, root, head);
  const files: Payload['files'] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prior = before.get(path), next = after.get(path);
    if (prior && next && prior.mode === next.mode && prior.hash === next.hash) continue;
    if ([prior, next].some(entry => entry && !REGULAR.has(entry.mode))) fail(`${path} is a symlink or submodule; changes to those cannot be submitted.`);
    if (!validPath(path)) fail(`${path} is a protected or invalid path for a change.`);
    if ((next?.size ?? 0) > LIMITS.bytes) fail(LIMIT_MESSAGE);
    if (!next) { files.push({ path, content: null }); continue; }
    const content = decodeText(git(context, ['cat-file', 'blob', next.hash], { cwd: root }));
    assertNoSecrets(content, secrets, `${path} looks like it contains a credential. Remove it from the commits before submitting.`);
    files.push({ path, content, ...(next.mode !== (prior?.mode ?? '100644') ? { mode: next.mode as '100644' | '100755' } : {}) });
  }
  return files;
}

/** Uncommitted changes to tracked files, and untracked files outside .braid/, which keeps Braid's own local files. */
function uncommitted(context: BraidContext, root: string) {
  const status = git(context, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { cwd: root }).toString('utf8');
  return status.split('\0').filter(entry => entry && !(entry.startsWith('?? ') && entry.slice(3).startsWith('.braid/')));
}

/**
 * The change from `base` to HEAD. HEAD must descend from the base and the working tree must be clean; HEAD and the
 * index are compared before and after reading, so a commit made meanwhile is caught.
 */
export function collectChanges(context: BraidContext, root: string, base: string, secrets: readonly string[]) {
  const state = () => `${gitText(context, ['rev-parse', '--verify', 'HEAD'], { cwd: root })}\0${git(context, ['ls-files', '--stage', '-z'], { cwd: root }).toString('base64')}`;
  const dirty = uncommitted(context, root);
  if (dirty.length) fail(`Commit your work before submitting; the change is read from commits. Not committed: ${dirty.slice(0, 3).map(entry => entry.slice(3)).join(', ')}${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ''}.`);
  if (!isAncestor(context, root, base)) fail(`HEAD does not descend from the base ${base}. Rebase onto it, or run braid sync first.`);
  const before = state(), head = before.split('\0')[0];
  const files = committedFiles(context, root, base, head, secrets);
  if (state() !== before || uncommitted(context, root).length) fail('The repository changed while braid read the change. Run braid submit again when edits are finished.');
  if (!files.length) fail(`There are no committed changes since ${base.slice(0, 12)} to submit.`);
  return { head, files };
}

/** Validate a native Git submission one blob at a time, including binary files. */
export function validatePush(context: BraidContext, root: string, base: string, secrets: readonly string[]) {
  if (uncommitted(context, root).length) fail('Commit your work before submitting.');
  const head = gitText(context, ['rev-parse', '--verify', 'HEAD'], { cwd: root });
  if (!isAncestor(context, root, base, head)) fail('Rebase onto the base commit before submitting.');
  const before = treeEntries(context, root, base), after = treeEntries(context, root, head);
  let changed = false;
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(path), next = after.get(path);
    if (prior && next && prior.mode === next.mode && prior.hash === next.hash) continue;
    changed = true;
    if (!validPath(path)) fail(`${path} is a protected or invalid path for a change.`);
    if ([prior, next].some(entry => entry && !REGULAR.has(entry.mode))) fail(`${path} is a symlink or submodule; changes to those cannot be submitted.`);
    if (!next) continue;
    if (next.size > LIMITS.bytes) fail(LIMIT_MESSAGE);
    assertNoSecrets(git(context, ['cat-file', 'blob', next.hash], { cwd: root }).toString('utf8'), secrets,
      `${path} looks like it contains a credential. Remove it from the commits before submitting.`);
  }
  if (!changed) fail('There are no committed changes to submit.');
  if (gitText(context, ['rev-parse', '--verify', 'HEAD'], { cwd: root }) !== head || uncommitted(context, root).length)
    fail('The repository changed while braid read the change. Run braid submit again when edits are finished.');
}

/** Agent-reported test results from a JSON file of at most 128 KB, as `--tests` names it. */
export function readTests(context: BraidContext, path: string) {
  let bytes: Buffer | undefined;
  try { bytes = readRegularFile(resolve(context.cwd, path), 128_000); } catch { return fail(`Cannot read the tests file ${path}.`); }
  if (!bytes) fail('The tests file must be a regular file of at most 128 KB.');
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(undefined, 'The tests file is not valid JSON.'), testReports), bytes.toString('utf8'));
  return parsed.success ? parsed.output : fail(parsed.issues[0].message);
}
