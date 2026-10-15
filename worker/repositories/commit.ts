import type { CommitDetail, CommitDiff, CommitFile } from '../../shared/history';
import { textDiffStats } from '../../shared/diff';
import type { ExampleState, RecordedExample } from '../changes/demo';
import { HttpError } from '../errors';
import { fileTexts, treeChanges, treeFile } from '../git/objects';
import { commitFromPrefix, historyCommits, recordedCommits, type Attribution, type HistoryRepo } from './history';
import { TEXT_LIMIT } from './repository';
import { parse, repositoryCommitDiffQuery, repositoryCommitQuery } from '../schemas';

/** The viewer uses two-column tabs; count wide characters conservatively without returning any source. */
function textColumns(text: string | null) {
  let columns = 0;
  for (const char of text ?? '') {
    if (char !== '\n' && char !== '\r') columns += char === '\t' || char.charCodeAt(0) > 127 ? 2 : 1;
  }
  return columns;
}
export const COMMIT_LIMITS = { files: 300, entries: 20_000, depth: 128, text: TEXT_LIMIT, bytes: 8_000_000 };
export function commitRequest(params: URLSearchParams) { return parse(repositoryCommitQuery, Object.fromEntries(params)); }
export function commitDiffRequest(params: URLSearchParams) { return parse(repositoryCommitDiffQuery, Object.fromEntries(params)); }

async function revisions(repo: HistoryRepo, sha: string) {
  const head = await repo.readCommit(sha);
  if (!head) throw new HttpError(404, 'Commit not found.');
  const parent = head.parents[0] ? await repo.readCommit(head.parents[0]) : null;
  return { head, parent, parentUnavailable: head.parents.length > 0 && !parent };
}

const unavailable = () => new HttpError(503, 'Commit files are temporarily unavailable.');
const encoder = new TextEncoder();
const texts = (repo: HistoryRepo) => fileTexts(repo, COMMIT_LIMITS, () => new HttpError(503, 'Commit file is temporarily unavailable.'));

export async function repositoryCommit(repo: HistoryRepo, sha: string, known?: Attribution): Promise<CommitDetail> {
  const { head, parent, parentUnavailable } = await revisions(repo, sha);
  const [[metadata], changed] = await Promise.all([historyCommits(repo, [head], known), parentUnavailable ? null : treeChanges(repo, parent?.treeHash, head.treeHash, COMMIT_LIMITS, unavailable)]);
  const result: CommitDetail = { ...metadata, message: head.message, parents: head.parents, files: [], filesTruncated: false, parentUnavailable };
  if (!changed) return result;
  const read = texts(repo);
  result.filesTruncated = changed.truncated;
  for (const pair of changed.files) {
    const before = await read(pair.before), after = await read(pair.after);
    const binary = before.binary || after.binary, tooLarge = before.tooLarge || after.tooLarge;
    const stats = binary || tooLarge || before.limited || after.limited ? { additions: null, deletions: null } : textDiffStats(before.text ?? '', after.text ?? '');
    result.files.push({ path: pair.path, status: !pair.before ? 'added' : !pair.after ? 'deleted' : 'modified', ...stats,
      ...(stats.additions === null ? {} : { textColumns: textColumns(before.text) + textColumns(after.text) }),
      binary, tooLarge, beforeMode: pair.before?.mode, afterMode: pair.after?.mode });
  }
  return result;
}

export async function repositoryCommitDiff(repo: HistoryRepo, sha: string, path: string): Promise<CommitDiff> {
  const { head, parent, parentUnavailable } = await revisions(repo, sha);
  if (parentUnavailable) throw new HttpError(409, 'The parent commit is unavailable in this repository.');
  const [a, b] = await Promise.all([parent ? treeFile(repo, parent.treeHash, path, unavailable) : undefined, treeFile(repo, head.treeHash, path, unavailable)]);
  if (a?.hash === b?.hash && a?.mode === b?.mode) throw new HttpError(404, 'This commit does not change that file.');
  const read = texts(repo), before = await read(a), after = await read(b);
  const binary = before.binary || after.binary, tooLarge = before.tooLarge || after.tooLarge;
  return { path, before: binary || tooLarge ? null : before.text, after: binary || tooLarge ? null : after.text, binary, tooLarge };
}

function recordedChange(example: RecordedExample, state: ExampleState, sha: string) {
  const commits = recordedCommits(example, state);
  return commits.get(commitFromPrefix(sha, [...commits.keys()]))!;
}

export function recordedCommit(example: RecordedExample, state: ExampleState, sha: string): CommitDetail {
  const { change, hash, at, parent } = recordedChange(example, state, sha);
  const files = change.files.slice(0, COMMIT_LIMITS.files).map((file): CommitFile => {
    const diff = example.diff(change.id, file.path, {}, state);
    return { path: file.path, status: diff.before === null ? 'added' : diff.after === null ? 'deleted' : 'modified', ...textDiffStats(diff.before ?? '', diff.after ?? ''),
      ...(diff.binary ? {} : { textColumns: textColumns(diff.before) + textColumns(diff.after) }), binary: diff.binary, tooLarge: false };
  });
  return { hash, title: change.title, message: change.summary ? `${change.title}\n\n${change.summary}` : change.title,
    at, author: change.author, pullRequest: change.number,
    parents: [parent], files, filesTruncated: change.files.length > COMMIT_LIMITS.files, parentUnavailable: false };
}

/** Recorded text described as live files are: binary with a NUL byte, too large past the text limit. */
export const describeRecorded = (...sides: (string | null | undefined)[]) =>
  ({ binary: sides.some(text => text?.includes('\0')), tooLarge: sides.some(text => !!text && encoder.encode(text).length > COMMIT_LIMITS.text) });

export function recordedCommitDiff(example: RecordedExample, state: ExampleState, sha: string, path: string): CommitDiff {
  const { change } = recordedChange(example, state, sha), diff = example.diff(change.id, path, {}, state);
  const { tooLarge } = describeRecorded(diff.before, diff.after);
  return { path, before: tooLarge ? null : diff.before, after: tooLarge ? null : diff.after, binary: diff.binary, tooLarge };
}
