import type { BranchCommit, RepositoryBranches, RepositoryComparison, RepositoryDiff } from '../../shared/compare';
import type { Change, Project } from '../../shared/types';
import { textDiffStats } from '../../shared/diff';
import { HttpError } from '../errors';
import { fileTexts, treeChanges, treeFile } from '../git/objects';
import { COMMIT_LIMITS, describeRecorded } from './commit';
import { BRANCH_LIMIT } from './branches';
import { exampleMain, type ExampleState, type RecordedExample } from '../changes/demo';
import { commitAuthor, commitFromPrefix, commitProvenance, resolveRepositoryCommit, type Attribution, type HistoryRepo } from './history';
import { mergeFile } from '../../shared/merge';

export const COMPARE_LIMITS = { ...COMMIT_LIMITS, walk: 512, commits: 100 };
const treeMissing = () => new HttpError(404, 'Repository tree not found.'), notesMissing = () => new HttpError(404, 'Repository notes not found.');

async function attributed(repo: HistoryRepo, commits: ArtifactsCommitMetadata[], authors?: Attribution): Promise<BranchCommit[]> {
  const provenance = await commitProvenance(repo, commits, authors, notesMissing);
  return commits.map((commit, index) => ({ hash: commit.hash, title: commit.message.split('\n', 1)[0], time: new Date(commit.authoredAt * 1000).toISOString(),
    author: commitAuthor(provenance[index], commit.author.name) }));
}

async function tip(repo: HistoryRepo, ref: string, branches: readonly string[] = ['main']) {
  if (/^[a-f0-9]{40}$/i.test(ref)) return repo.readCommit(ref.toLowerCase());
  const branch = (await repo.log({ ref, limit: 1 }))[0];
  if (branch) return branch;
  if (!/^[a-f0-9]{7,39}$/i.test(ref)) return null;
  return repo.readCommit(await resolveRepositoryCommit(repo, ref, branches[0], branches.slice(1)));
}

export async function repositoryBranches(repo: HistoryRepo, project: Pick<Project, 'branch' | 'branches'>, authors?: Attribution): Promise<RepositoryBranches> {
  const names = [...new Set([project.branch, ...(project.branches ?? [])])].filter(Boolean);
  names.sort((a, b) => a === project.branch ? -1 : b === project.branch ? 1 : a.localeCompare(b));
  const branches: RepositoryBranches['branches'] = [];
  for (let offset = 0; offset < Math.min(names.length, BRANCH_LIMIT); offset += 8) {
    const chunk = names.slice(offset, offset + 8);
    const tips = await Promise.all(chunk.map(name => tip(repo, name)));
    const commits = new Map((await attributed(repo, tips.filter(commit => commit !== null), authors)).map(commit => [commit.hash, commit]));
    branches.push(...chunk.map((name, index) => ({ name, tip: tips[index] ? commits.get(tips[index].hash)! : null })));
  }
  return { defaultBranch: project.branch, branches };
}

/** Paint both histories, including merge parents, and stop reading below their shared ancestry. */
async function walk(repo: HistoryRepo, base: ArtifactsCommitMetadata, head: ArtifactsCommitMetadata) {
  const commits = new Map([[base.hash, base], [head.hash, head]]);
  const marks = new Map<string, number>(), queue: string[] = [], pending = new Set<string>(), common = new Set<string>();
  const paint = (hash: string, color: number) => {
    const before = marks.get(hash) ?? 0, after = before | color;
    if (before === after) return;
    if (after === 3 && color !== 3) common.add(hash);
    marks.set(hash, after);
    if (after === 3) {
      for (const parent of commits.get(hash)?.parents ?? []) paint(parent, 3);
      return;
    }
    if (!pending.has(hash)) { pending.add(hash); queue.push(hash); }
  };
  paint(base.hash, 1); paint(head.hash, 2);
  const missing = new Set<string>();
  let reads = 0, limited = false;
  for (let index = 0; index < queue.length; index++) {
    const hash = queue[index]; pending.delete(hash);
    const color = marks.get(hash)!;
    let commit = commits.get(hash);
    if (color !== 3 && !commit) {
      if (reads++ >= COMPARE_LIMITS.walk) { limited = true; break; }
      const found = await repo.readCommit(hash);
      if (!found) { missing.add(hash); continue; }
      commits.set(hash, commit = found);
    }
    if (commit) for (const parent of commit.parents) paint(parent, color);
  }
  const mergeBases = () => {
    const older = new Set<string>(), ancestors = [...common].flatMap(hash => commits.get(hash)?.parents ?? []);
    for (let index = 0; index < ancestors.length; index++) {
      const hash = ancestors[index];
      if (older.has(hash)) continue;
      older.add(hash); ancestors.push(...(commits.get(hash)?.parents ?? []));
    }
    return [...common].filter(hash => !older.has(hash));
  };
  // A merge can reach old history by another parent. Exclude that shared history too;
  // stop early only when every exclusive commit is provably above the common base.
  const aboveBase = () => {
    const bases = mergeBases();
    if (bases.length !== 1) return false;
    const above = new Set(bases);
    let added = true;
    while (added) {
      added = false;
      for (const commit of commits.values()) if (!above.has(commit.hash) && commit.parents.some(parent => above.has(parent))) { above.add(commit.hash); added = true; }
    }
    return [...marks].every(([hash, color]) => color === 3 || above.has(hash));
  };
  while (!limited && !aboveBase()) {
    const next = [...marks].find(([hash, color]) => color === 3 && !commits.has(hash) && !missing.has(hash));
    if (!next) break;
    if (reads++ >= COMPARE_LIMITS.walk) { limited = true; break; }
    const commit = await repo.readCommit(next[0]);
    if (!commit) { missing.add(next[0]); limited = true; break; }
    commits.set(commit.hash, commit);
    for (const parent of commit.parents) paint(parent, 3);
  }
  const bases = mergeBases();
  return { limited: limited || [...missing].some(hash => marks.get(hash) !== 3), bases, commits: [...commits.values()].filter(commit => marks.get(commit.hash) === 2).sort((a, b) => b.committedAt - a.committedAt) };
}

const texts = (repo: HistoryRepo) => fileTexts(repo, COMPARE_LIMITS, () => new HttpError(404, 'Repository file not found.'));

export async function compareRepository(repo: HistoryRepo, baseRef: string, headRef: string, authors?: Attribution, branches: readonly string[] = ['main']): Promise<RepositoryComparison> {
  const [base, head] = await Promise.all([tip(repo, baseRef, branches), tip(repo, headRef, branches)]);
  if (!base || !head) throw new HttpError(404, 'Branch or commit not found.');
  const result: RepositoryComparison = { base: base.hash, head: head.hash, mergeBase: null, status: 'ready', commits: [], commitsTruncated: false, files: [], filesTruncated: false };
  if (base.hash === head.hash) return { ...result, mergeBase: base.hash, status: 'identical' };
  const history = await walk(repo, base, head);
  if (history.limited) return { ...result, status: 'limited' };
  if (!history.bases.length) return { ...result, status: 'unrelated' };
  if (history.bases.length > 1) return { ...result, status: 'multiple-bases' };
  const mergeBase = history.bases[0] === base.hash ? base : history.bases[0] === head.hash ? head : await repo.readCommit(history.bases[0]);
  if (!mergeBase) return { ...result, status: 'limited' };
  result.mergeBase = mergeBase.hash;
  result.commitsTruncated = history.commits.length > COMPARE_LIMITS.commits;
  const [commits, changed] = await Promise.all([attributed(repo, history.commits.slice(0, COMPARE_LIMITS.commits), authors), treeChanges(repo, mergeBase.treeHash, head.treeHash, COMPARE_LIMITS, treeMissing)]);
  result.commits = commits;
  const read = texts(repo);
  result.filesTruncated = changed.truncated;
  for (const pair of changed.files) {
    const before = await read(pair.before), after = await read(pair.after);
    const binary = before.binary || after.binary, tooLarge = before.tooLarge || after.tooLarge || before.limited || after.limited;
    const stats = binary || tooLarge ? { additions: 0, deletions: 0 } : textDiffStats(before.text ?? '', after.text ?? '');
    result.files.push({ path: pair.path, ...stats, added: !pair.before, deleted: !pair.after, binary, tooLarge, beforeMode: pair.before?.mode, afterMode: pair.after?.mode });
  }
  return result;
}

async function fileEntry(repo: HistoryRepo, commit: string, path: string) {
  const root = await repo.readCommit(commit);
  if (!root) throw new HttpError(404, 'Repository revision not found.');
  return treeFile(repo, root.treeHash, path, treeMissing);
}

export async function repositoryDiff(repo: HistoryRepo, base: string, head: string, path: string): Promise<RepositoryDiff> {
  const [a, b] = await Promise.all([fileEntry(repo, base, path), fileEntry(repo, head, path)]);
  if (!a && !b) throw new HttpError(404, 'File not found in this comparison.');
  const read = texts(repo), before = await read(a), after = await read(b);
  return { path, before: before.text, after: after.text, binary: before.binary || after.binary, tooLarge: before.tooLarge || after.tooLarge || before.limited || after.limited };
}

export function exampleBranches(project: Pick<Project, 'branch' | 'head'>, example: RecordedExample, state: ExampleState): RepositoryBranches {
  const latest = example.changes({ statuses: ['landed'], limit: 1000 }, state).items.find(change => change.landedCommit === project.head);
  const change = latest ? example.change(latest.id, state) : null;
  return { defaultBranch: project.branch, branches: [{ name: project.branch, tip: change ? {
    hash: change.landedCommit!, title: change.title, time: change.landedAt!, author: change.author,
  } : null }, ...example.branches(state).map(({ name, tip }) => ({ name, tip }))] };
}

/** The example's existing landing chain, including a visitor's later merges, without changing the recording. */
function recordedRevisions(example: RecordedExample, state: ExampleState, project: Pick<Project, 'branch' | 'head'>, baseRef: string, headRef: string) {
  const changes = new Map(example.changes({ statuses: ['landed'], limit: 1000 }, state).items.map(item => {
    const change = example.change(item.id, state);
    return [change.landedCommit!, change] as const;
  }));
  const parents = new Map<string, string>();
  let parent = exampleMain().head;
  for (const landing of example.landings(state)) { parents.set(landing.commit, parent); parent = landing.commit; }
  const chain: Change[] = [], hashes: string[] = [];
  let hash = project.head;
  while (!hashes.includes(hash)) {
    hashes.push(hash);
    const change = changes.get(hash);
    if (!change) break;
    chain.push(change);
    hash = parents.get(hash) ?? change.landedParent ?? change.baseCommit;
  }
  const branches = example.branches(state);
  const resolve = (ref: string) => ref === project.branch || ref === `refs/heads/${project.branch}` ? project.head
    : branches.find(branch => branch.name === ref || `refs/heads/${branch.name}` === ref)?.tip.hash
      ?? (/^[a-f0-9]{7,40}$/i.test(ref) ? commitFromPrefix(ref.toLowerCase(), [...hashes, ...branches.map(branch => branch.tip.hash)]) : null);
  const base = resolve(baseRef), head = resolve(headRef);
  if (!base || !head) throw new HttpError(404, 'Branch or commit not found.');
  const history = (hash: string) => {
    const branch = branches.find(branch => branch.tip.hash === hash);
    return branch ? [hash, ...hashes.slice(hashes.indexOf(branch.base))] : hashes.slice(hashes.indexOf(hash));
  };
  const baseHistory = new Set(history(base)), headHistory = history(head);
  const mergeBase = headHistory.find(hash => baseHistory.has(hash))!;
  const commits: BranchCommit[] = headHistory.slice(0, headHistory.indexOf(mergeBase)).map(hash => {
    const branch = branches.find(branch => branch.tip.hash === hash);
    if (branch) return branch.tip;
    const change = changes.get(hash)!;
    return { hash, title: change.title, time: change.landedAt!, author: change.author };
  });
  return { base, head, mergeBase, commits, chain, hashes, branches };
}

/** Undo each landed patch while preserving edits from earlier landings that shared its original base. */
function recordedFiles(example: RecordedExample, state: ExampleState, files: Record<string, string>, chain: Change[], indexes: number[]): Map<number, Record<string, string>> | null {
  const current = { ...files }, snapshots = new Map<number, Record<string, string>>();
  if (indexes.includes(0)) snapshots.set(0, { ...current });
  for (let index = 0; index < Math.max(...indexes); index++) {
    const change = chain[index];
    for (const file of change.files) {
      const diff = example.diff(change.id, file.path, {}, state);
      const after = current[file.path] ?? null;
      if (after === diff.after) {
        if (diff.before === null) delete current[file.path];
        else current[file.path] = diff.before;
      } else {
        const reversed = mergeFile(file.path, diff.after ?? '', after ?? '', diff.before ?? '', { union: [] });
        if (!reversed.clean) return null;
        if (diff.before === null && reversed.text === '') delete current[file.path];
        else current[file.path] = reversed.text;
      }
    }
    if (indexes.includes(index + 1)) snapshots.set(index + 1, { ...current });
  }
  return snapshots;
}

/** Recorded branch tips have their own tree; main's older trees are reconstructed from witnessed landings. */
function comparisonFiles(example: RecordedExample, state: ExampleState, files: Record<string, string>, revisions: ReturnType<typeof recordedRevisions>, refs: string[]) {
  const { hashes, branches, chain } = revisions;
  const snapshots = recordedFiles(example, state, files, chain, refs.filter(ref => hashes.includes(ref)).map(ref => hashes.indexOf(ref)));
  if (!snapshots) return null;
  return new Map(refs.map(ref => [ref, branches.find(branch => branch.tip.hash === ref)?.files ?? snapshots.get(hashes.indexOf(ref))!]));
}

/** Resolve a recorded tree before a file or folder is returned under an immutable commit key. */
export function recordedTree(example: RecordedExample, state: ExampleState, project: Pick<Project, 'branch' | 'head'>, files: Record<string, string>, ref: string) {
  const branch = example.branch(ref, state);
  if (branch) return { ref: branch.tip.hash, files: branch.files };
  if ([project.branch, `refs/heads/${project.branch}`, project.head].includes(ref)) return { ref: project.head, files };
  const revisions = recordedRevisions(example, state, project, ref, ref);
  const snapshots = comparisonFiles(example, state, files, revisions, [revisions.head]);
  if (!snapshots) throw new HttpError(409, 'This tree is not available in the recording.');
  return { ref: revisions.head, files: snapshots.get(revisions.head)! };
}

export function recordedComparison(example: RecordedExample, state: ExampleState, project: Pick<Project, 'branch' | 'head'>, files: Record<string, string>, baseRef: string, headRef: string): RepositoryComparison {
  const revisions = recordedRevisions(example, state, project, baseRef, headRef);
  const { base, head, mergeBase, commits } = revisions;
  const result: RepositoryComparison = { base, head, mergeBase, status: base === head ? 'identical' : 'ready', commits: [], files: [], commitsTruncated: false, filesTruncated: false };
  if (!commits.length) return result;
  const snapshots = comparisonFiles(example, state, files, revisions, [mergeBase, head]);
  if (!snapshots) return { ...result, mergeBase: null, status: 'limited' };
  const before = snapshots.get(mergeBase)!, after = snapshots.get(head)!;
  result.commitsTruncated = commits.length > COMPARE_LIMITS.commits;
  result.commits = commits.slice(0, COMPARE_LIMITS.commits);
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[path] === after[path]) continue;
    if (result.files.length === COMPARE_LIMITS.files) { result.filesTruncated = true; break; }
    const a = before[path], b = after[path], { binary, tooLarge } = describeRecorded(a, b);
    result.files.push({ path, ...(binary || tooLarge ? { additions: 0, deletions: 0 } : textDiffStats(a ?? '', b ?? '')), added: a === undefined, deleted: b === undefined, binary, tooLarge });
  }
  return result;
}

export function recordedComparisonDiff(example: RecordedExample, state: ExampleState, project: Pick<Project, 'branch' | 'head'>, files: Record<string, string>, base: string, head: string, path: string): RepositoryDiff {
  const revisions = recordedRevisions(example, state, project, base, head);
  const snapshots = comparisonFiles(example, state, files, revisions, [revisions.base, revisions.head]);
  if (!snapshots) throw new HttpError(409, 'This comparison is not available in the recording.');
  const before = snapshots.get(revisions.base)![path] ?? null, after = snapshots.get(revisions.head)![path] ?? null;
  if (before === null && after === null) throw new HttpError(404, 'File not found in this comparison.');
  const { binary, tooLarge } = describeRecorded(before, after);
  return { path, before: binary || tooLarge ? null : before, after: binary || tooLarge ? null : after, binary, tooLarge };
}
