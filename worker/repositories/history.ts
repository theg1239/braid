import type { CommitPage, RepositoryCommit } from '../../shared/history';
import type { ChangeAuthor, Provenance } from '../../shared/types';
import { modelName, NOTES_REF, provenanceOf } from '../../shared/provenance';
import { provenanceAuthorKind } from '../../shared/models';
import { exampleMain, type ExampleState, type RecordedExample } from '../changes/demo';
import { HttpError } from '../errors';
import { cachedReader, commitFacts, readNote, treeEntry } from '../git/objects';
import { personName } from './provenance';
import { encodeCursor, historyQuery, parse } from '../schemas';

const PAGE_SIZE = 30;
export const HISTORY_SCAN_LIMIT = 100;
export const COMMIT_PREFIX_LIMIT = 2_000;
/** What history, commit and comparison pages read from a repository. */
export type HistoryRepo = Pick<ArtifactsRepo, 'log' | 'readCommit' | 'readTree' | 'readBlob'>;
/** Braid's landing records for commits, by hash. */
export type Attribution = (commits: string[]) => Promise<Provenance[]>;
const unavailable = () => new HttpError(503, 'Commit history is temporarily unavailable.');

export function commitFromPrefix(prefix: string, commits: string[]): string {
  const matches = [...new Set(commits.filter(hash => hash.startsWith(prefix)))];
  if (matches.length > 1) throw new HttpError(409, 'Commit hash is ambiguous. Use a longer hash.');
  if (!matches.length) throw new HttpError(404, 'Commit not found.');
  return matches[0];
}

export async function resolveRepositoryCommit(repo: Pick<ArtifactsRepo, 'log'>, sha: string, defaultRef: string, branches: readonly string[] = []): Promise<string> {
  if (sha.length === 40) return sha;
  const commits = new Set<string>(), visited = new Set<string>();
  const refs = [...new Set([defaultRef, ...branches])];
  let scanned = 0;
  while (refs.length && scanned < COMMIT_PREFIX_LIMIT) {
    const ref = refs.shift()!;
    if (visited.has(ref) || commits.has(ref)) continue;
    visited.add(ref);
    const page = await repo.log({ ref, limit: Math.min(1_000, COMMIT_PREFIX_LIMIT - scanned) });
    scanned += page.length;
    for (const commit of page) commits.add(commit.hash);
    // Artifacts log follows first parents; visit the other parents as well as other branch tips.
    const parents = page.flatMap(commit => commit.parents).filter(parent => !commits.has(parent));
    refs.push(...new Set(parents));
  }
  return commitFromPrefix(sha.toLowerCase(), [...commits]);
}

export function historyRequest(params: URLSearchParams, defaultRef: string) {
  const query = parse(historyQuery, { ref: params.get('ref') || undefined, path: params.get('path') || '', cursor: params.get('cursor') || undefined });
  const ref = query.ref ?? defaultRef;
  if (query.cursor && (query.cursor.ref !== ref || query.cursor.path !== query.path)) throw new HttpError(400, 'This history cursor belongs to another branch or path.');
  return { ...query, ref };
}
type HistoryRequest = ReturnType<typeof historyRequest>;
const cursorFor = (query: HistoryRequest, head: string, next: string) => encodeCursor({ v: 1, ref: query.ref, path: query.path, head, next });

/** A commit's author as history, commit and branch pages show it: the agent and its owner, or the person, never by email address. */
export function commitAuthor(provenance: Provenance, gitName: string): ChangeAuthor {
  const { agent, owner } = provenance;
  return {
    kind: provenanceAuthorKind(provenance),
    id: agent?.id ?? owner?.id ?? provenance.commit,
    name: agent ? (agent.model ? modelName(agent.model) : agent.name) : personName(owner?.name ?? gitName),
    ...(agent?.model ? { model: agent.model } : {}),
    ...(agent?.tool ? { tool: agent.tool } : {}),
    ...(owner ? { owner: { name: personName(owner.name), ...(owner.github ? { github: owner.github } : {}) } } : {}),
  };
}

/**
 * History, commit and branch pages read who made each commit the same way: Braid's landing record where it keeps one,
 * else the commit and Braid's note on it. A notes tree the reader lacks throws `missing()`.
 */
export async function commitProvenance(repo: HistoryRepo, commits: ArtifactsCommitMetadata[], known: Attribution | undefined, missing: () => Error): Promise<Provenance[]> {
  // Git facts are already in hand: re-derive inferred rows under the current rules, keeping witnessed/note records.
  const rows = new Map(known && commits.length ? (await known(commits.map(commit => commit.hash))).filter(row => row.confidence !== 'inferred').map(row => [row.commit, row]) : []);
  const notes = commits.some(commit => !rows.has(commit.hash)) ? (await repo.log({ ref: NOTES_REF, limit: 1 }))[0] : undefined;
  const trees = Object.assign(cachedReader(repo), { readBlob: (hash: string) => repo.readBlob(hash) });
  return Promise.all(commits.map(async commit => rows.get(commit.hash)
    ?? provenanceOf(commitFacts(commit), notes ? await readNote(trees, notes.treeHash, commit.hash, missing) : null)));
}

export async function historyCommits(repo: HistoryRepo, commits: ArtifactsCommitMetadata[], known?: Attribution): Promise<RepositoryCommit[]> {
  const provenance = await commitProvenance(repo, commits, known, unavailable);
  return commits.map((commit, index) => {
    const { change } = provenance[index];
    return { hash: commit.hash, title: commit.message.split('\n', 1)[0], at: new Date(commit.committedAt * 1000).toISOString(),
      author: commitAuthor(provenance[index], commit.author.name), ...(change ? { pullRequest: change.number } : {}) };
  });
}

/** Artifacts walks first parents. Continuing from a commit, not an offset, bounds every request even on old pages. */
export async function repositoryHistory(repo: HistoryRepo, query: HistoryRequest, known?: Attribution): Promise<CommitPage> {
  const limit = query.path ? HISTORY_SCAN_LIMIT : PAGE_SIZE;
  const log = await repo.log({ ref: query.cursor?.next ?? query.ref, limit: limit + 1 });
  if (!log.length) throw new HttpError(404, 'Repository revision not found.');
  const head = query.cursor?.head ?? log[0].hash;
  const trees = cachedReader(repo), selected: ArtifactsCommitMetadata[] = [];
  let scanned = 0;
  while (scanned < Math.min(limit, log.length) && selected.length < PAGE_SIZE) {
    const commit = log[scanned++];
    if (!query.path) { selected.push(commit); continue; }
    const parent = commit.parents[0] ? log[scanned] ?? await repo.readCommit(commit.parents[0]) : null;
    const [childEntry, parentEntry] = await Promise.all([
      treeEntry(trees, commit.treeHash, query.path, unavailable),
      parent ? treeEntry(trees, parent.treeHash, query.path, unavailable) : undefined,
    ]);
    if (childEntry?.hash !== parentEntry?.hash || childEntry?.mode !== parentEntry?.mode) selected.push(commit);
  }
  const items = await historyCommits(repo, selected, known);
  return { ref: head, path: query.path, items, nextCursor: log[scanned] ? cursorFor(query, head, log[scanned].hash) : null };
}

/** Recorded commits and their actual first parents; a proposal branch never becomes a main landing. */
export function recordedCommits(example: RecordedExample, state: ExampleState) {
  const revisions = new Map(example.changes({ statuses: ['landed'], limit: 1000 }, state).items.map(item => {
    const change = example.change(item.id, state);
    const revision = { change, hash: item.landedCommit!, parent: change.landedParent ?? change.baseCommit, at: change.landedAt ?? change.updatedAt };
    return [revision.hash, revision] as const;
  }));
  const landings = example.landings(state);
  for (let index = 0; index < landings.length; index++) revisions.get(landings[index].commit)!.parent = index ? landings[index - 1].commit : exampleMain().head;
  for (const branch of example.branches(state)) revisions.set(branch.tip.hash,
    { change: example.change(branch.changeId, state), hash: branch.tip.hash, parent: branch.base, at: branch.tip.time });
  return revisions;
}

/** Follow the requested branch's ancestry, including when a visitor has since moved main. */
export function recordedHistory(example: RecordedExample, state: ExampleState, query: HistoryRequest): CommitPage {
  const commits = recordedCommits(example, state);
  const resolve = (ref: string) => ['main', 'refs/heads/main'].includes(ref) ? example.queue(state).head
    : example.branch(ref, state)?.tip.hash ?? commitFromPrefix(ref.toLowerCase(), [...commits.keys()]);
  const head = query.cursor?.head ?? resolve(query.ref), items: RepositoryCommit[] = [];
  let hash = head, started = !query.cursor;
  const seen = new Set<string>();
  while (commits.has(hash) && !seen.has(hash)) {
    seen.add(hash);
    const revision = commits.get(hash)!, { change, at } = revision;
    if (query.cursor?.next === hash) started = true;
    if (started && (!query.path || change.files.some(file => file.path === query.path || file.path.startsWith(`${query.path}/`)))) {
      items.push({ hash, title: change.title, at, author: change.author, pullRequest: change.number });
      if (items.length > PAGE_SIZE) break;
    }
    hash = revision.parent;
  }
  if (!started || !commits.has(head)) throw new HttpError(400, 'Invalid history cursor.');
  const next = items[PAGE_SIZE];
  return { ref: head, path: query.path, items: items.slice(0, PAGE_SIZE), nextCursor: next ? cursorFor(query, head, next.hash) : null };
}
