import type { RepositoryEntry, RepositoryFile, RepositoryTree } from '../../shared/repository';
import type { ComposeReader } from './compose';
import { blobText, type GitObjectReader } from '../git/objects';
import { artifactsFailed, HttpError, logFailure } from '../errors';
import { NOTES_REF } from '../../shared/provenance';
import type { ExampleState, RecordedExample } from '../changes/demo';

// Browsing is independent of text context and edit restrictions. In particular,
// hidden files, binaries, lockfiles, symlinks and gitlinks must remain visible.
export function repositoryPath(path: string) {
  if (path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) || (path && path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')))
    throw new HttpError(400, 'Invalid repository path.');
  return path;
}
/** Whether a ref names the default branch: by its name, its full name, `HEAD`, or by leaving the ref out. */
const namesDefault = (ref: string | undefined, branch: string) => ref === undefined || ref === 'HEAD' || ref === branch || ref === `refs/heads/${branch}`;
/** Notes add provenance to a read and never fail it, so a failed lookup reads as no notes. */
async function notesAt(notes?: () => Promise<string | null | undefined>) {
  try { return await notes?.(); }
  catch (error) { logFailure('notes_lookup_failed', error); return undefined; }
}
/**
 * A live repository as its readers see it. Artifacts reads a branch, a tag or a commit ID, and cannot always read a
 * branch by name, as with a copy still shallow from its import. So the default branch, asked for by name and found by
 * none, is read at the head the project recorded, and Braid's notes ref at the commit the trunk knows it names. Every
 * other name, and every commit, is read as it is.
 */
export function readingNames(repo: ArtifactsRepo, names: { branch: string; head: string; notes?: () => Promise<string | null | undefined> }): ArtifactsRepo {
  return new Proxy(repo, { get(target, prop) {
    if (prop === 'log') return async (options: Parameters<ArtifactsRepo['log']>[0] = {}) => {
      // Artifacts rejects fully-qualified Git names. Resolve the exact namespace to an object ID instead of
      // stripping its prefix, which could confuse a branch with a tag bearing the same short name.
      if (options.ref?.startsWith('refs/')) {
        let commit: string | null | undefined;
        if (options.ref === `refs/heads/${names.branch}`) commit = names.head;
        else if (options.ref === NOTES_REF) commit = await notesAt(names.notes);
        // The trunk caches its notes lookup, including absence. A missing note is not a reason to open another
        // Git connection on every history read; notes are optional and never fail a repository read.
        if (!commit && /^refs\/(heads|tags)\//.test(options.ref)) {
          // The token expires within a minute, so a failed revocation is harmless.
          const token = (await target.createToken('read', 60)).plaintext;
          try { commit = (await (await import('../git/transport')).advertisement({ remote: (await target.info()).remote, token }, 'git-upload-pack', 1024 * 1024)).refs.get(options.ref); }
          finally { await target.revokeToken(token).catch(() => {}); }
        }
        return commit ? target.log({ ...options, ref: commit }) : [];
      }
      const found = await target.log(options);
      if (found.length) return found;
      const commit = namesDefault(options.ref, names.branch) ? names.head : options.ref === NOTES_REF ? await notesAt(names.notes) : undefined;
      return commit ? target.log({ ...options, ref: commit }) : found;
    };
    // A Workers RPC stub answers every property with a remote one, `bind` and `then` included, so its methods are called
    // on the stub itself and the wrapper is never mistaken for a promise.
    if (prop === 'then') return undefined;
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? (...args: unknown[]) => (target as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[prop](...args) : value;
  } });
}
function entry(raw: ArtifactsTreeEntry, path: string): RepositoryEntry {
  return { name: raw.name, path: path ? `${path}/${raw.name}` : raw.name, hash: raw.hash, mode: raw.mode,
    kind: raw.type === 'tree' ? 'dir' : raw.mode === '160000' ? 'submodule' : raw.mode === '120000' ? 'symlink' : 'file' };
}
/** The entries of a directory at a commit. Commits and trees never change, so a caching reader answers repeats without Artifacts. */
export async function directoryEntries(repo: GitObjectReader, ref: string, path: string): Promise<RepositoryEntry[]> {
  repositoryPath(path);
  const commit = await repo.readCommit(ref);
  if (!commit) throw new HttpError(404, 'Repository revision not found.');
  let hash = commit.treeHash;
  for (const part of path ? path.split('/') : []) {
    const next = (await repo.readTree(hash))?.find(item => item.name === part);
    if (!next || next.type !== 'tree') throw new HttpError(404, 'Directory not found.');
    hash = next.hash;
  }
  const entries = await repo.readTree(hash);
  if (!entries) throw new HttpError(404, 'Directory not found.');
  return entries.map(item => entry(item, path));
}
export async function repositoryEntry(repo: GitObjectReader, ref: string, path: string): Promise<RepositoryEntry> {
  repositoryPath(path);
  const index = path.lastIndexOf('/');
  const found = (await directoryEntries(repo, ref, index < 0 ? '' : path.slice(0, index))).find(item => item.path === path);
  if (!found) throw new HttpError(404, 'File not found.');
  return found;
}
export const TREE_COMMIT_LIMITS = { commits: 200, trees: 1024, entries: 200_000 };
type TreeCommit = Pick<ArtifactsCommitMetadata, 'hash' | 'treeHash' | 'parents' | 'message' | 'committedAt'>;
type TreeHistoryReader = Pick<GitObjectReader, 'readTree'> & {
  readCommit(hash: string): Promise<TreeCommit | null>;
  readHistory(hash: string, limit: number): Promise<TreeCommit[]>;
};
const treeCommit = ({ hash, treeHash, parents, message, committedAt }: TreeCommit): TreeCommit => ({ hash, treeHash, parents, message, committedAt });
const commitBytes = (commit: TreeCommit) => 160 + commit.parents.length * 80 + commit.message.length * 2;
interface DirectoryCommits { entries: RepositoryEntry[]; cacheable: boolean; historyComplete: boolean }

/** Compare only this directory along the first-parent chain. A merge attributes its changes to the merge, not a side branch. */
export async function directoryCommits(repo: TreeHistoryReader, ref: string, path: string): Promise<DirectoryCommits> {
  const entries = await directoryEntries(repo, ref, path), pending = new Map(entries.map(item => [item.name, item]));
  const history = new Map<string, TreeCommit>();
  let current = await repo.readCommit(ref), trees = 0, scanned = entries.length, unavailable = false;
  const directory = async (tree: string) => {
    const parts = path ? path.split('/') : [];
    for (let depth = 0; ; depth++) {
      if (trees >= TREE_COMMIT_LIMITS.trees || scanned >= TREE_COMMIT_LIMITS.entries) return null;
      trees++;
      const items = await repo.readTree(tree);
      if (!items) { unavailable = true; return null; }
      scanned += items.length;
      if (scanned > TREE_COMMIT_LIMITS.entries) return null;
      if (depth === parts.length) return items;
      const next = items.find(item => item.name === parts[depth]);
      if (next?.type !== 'tree') return [];
      tree = next.hash;
    }
  };
  for (let walked = 0; current && pending.size && walked < TREE_COMMIT_LIMITS.commits; walked++) {
    const parentHash = current.parents[0];
    // Artifacts walks first parents in one call. Small pages retain early stopping and the same 201-object ceiling.
    if (parentHash && !history.has(parentHash)) {
      const page = await repo.readHistory(parentHash, Math.min(32, TREE_COMMIT_LIMITS.commits - walked));
      for (const commit of page) history.set(commit.hash, commit);
    }
    const parent = history.get(parentHash) ?? null;
    // Shallow mirrors may gain this parent later. Do not label the shallow boundary as an introduction or cache that miss.
    if (current.parents.length && !parent) { unavailable = true; break; }
    if (parent?.treeHash !== current.treeHash) {
      const before = parent ? await directory(parent.treeHash) : [];
      if (!before) break;
      const previous = new Map(before.map(item => [item.name, item]));
      for (const [name, item] of pending) {
        const old = previous.get(name);
        if (old?.hash === item.hash && old.mode === item.mode && entry(old, path).kind === item.kind) continue;
        item.lastCommit = { hash: current.hash, title: current.message.split('\n', 1)[0], at: new Date(current.committedAt * 1000).toISOString() };
        pending.delete(name);
      }
    }
    current = parent;
  }
  return { entries, cacheable: !unavailable, historyComplete: pending.size === 0 };
}

/** Recorded changes supply witnessed paths and parents; no commit or date is invented for files outside that history. */
export async function recordedDirectoryCommits(example: RecordedExample, state: ExampleState, ref: string, entries: RepositoryEntry[]): Promise<DirectoryCommits> {
  const { recordedCommits } = await import('./history');
  const commits = recordedCommits(example, state), pending = new Set(entries);
  let hash = ref;
  for (let walked = 0; pending.size && walked < TREE_COMMIT_LIMITS.commits; walked++) {
    const revision = commits.get(hash);
    if (!revision) break;
    for (const item of pending) if (revision.change.files.some(file => file.path === item.path || item.kind === 'dir' && file.path.startsWith(`${item.path}/`))) {
      item.lastCommit = { hash, title: revision.change.title, at: revision.at };
      pending.delete(item);
    }
    hash = revision.parent;
  }
  return { entries, cacheable: true, historyComplete: pending.size === 0 };
}
/** Text above this size is described, not sent; the download still carries it whole. */
export const TEXT_LIMIT = 500_000;
/** Bytes a repository's object keeps in memory for browsing, and the largest blob it keeps at all. */
const MEMORY_BYTES = 16 * 1024 * 1024, BLOB_MEMORY = 1024 * 1024;
/**
 * Commits, trees and blobs read for browsing, kept in memory by hash: they never change, so while the repository's
 * object lives it answers a directory or file it has read before without Artifacts, and callers reading the same object
 * at the same moment share one read. Nothing is written to storage, so a visitor's read changes no state. Bounded by
 * bytes; the least recently used leave first, and a missing or failed object is asked for again rather than remembered.
 */
export class ObjectMemory {
  private objects = new Map<string, { value: Promise<unknown>; size: number }>();
  private bytes = 0;
  constructor(private readonly limit = MEMORY_BYTES) {}
  async pinnedRef(source: () => Promise<ArtifactsRepo>, ref: string): Promise<string> {
    if (/^[a-f0-9]{40}$/.test(ref)) return ref;
    const head = (await (await source()).log({ ref, limit: 1 }))[0];
    if (!head) throw new HttpError(404, 'Repository revision not found.');
    // Resolving a name already supplied its tree; the first Code read need not fetch that commit again.
    await this.read(`commit:${head.hash}`, async () => ({ treeHash: head.treeHash }), () => 64);
    return head.hash;
  }
  // Workers RPC handles also have typeof "function". A handle and a deferred opener must be explicit alternatives.
  reader(source: ComposeReader): ComposeReader { return this.lazyReader(async () => source); }
  lazyReader(open: () => Promise<ComposeReader>): ComposeReader {
    return {
      readCommit: hash => this.read(`commit:${hash}`, async () => { const commit = await (await open()).readCommit(hash); return commit && { treeHash: commit.treeHash }; }, () => 64),
      readTree: hash => this.read(`tree:${hash}`, async () => (await open()).readTree(hash), entries => entries.length * 128),
      readBlob: hash => this.read(`blob:${hash}`, async () => (await open()).readBlob(hash), blob => blob.size > BLOB_MEMORY ? Infinity : blob.size),
    };
  }
  historyReader(source: () => Promise<ArtifactsRepo>): TreeHistoryReader {
    return {
      readTree: this.lazyReader(source).readTree,
      readCommit: hash => this.read(`history:${hash}`, async () => {
        const found = await (await source()).readCommit(hash);
        return found && treeCommit(found);
      }, commitBytes),
      readHistory: async (hash, limit) => (await this.read(`history-page:${hash}:${limit}`, async () => {
        try { return (await (await source()).log({ ref: hash, limit })).map(treeCommit); }
        catch (error) { if (artifactsFailed(error, 'NOT_FOUND')) return []; throw error; }
      }, page => page.length === limit || page.length && !page.at(-1)!.parents.length
        ? page.reduce((bytes, commit) => bytes + commitBytes(commit), 0) : Infinity))!,
    };
  }
  async directoryCommits(ref: string, path: string, load: () => Promise<DirectoryCommits>): Promise<DirectoryCommits> {
    return (await this.read(`directory-commits:${ref}:${path}`, load,
      result => result.cacheable ? JSON.stringify(result).length * 2 : Infinity))!;
  }
  private read<T>(key: string, load: () => Promise<T | null>, sizeOf: (value: T) => number): Promise<T | null> {
    const kept = this.objects.get(key);
    if (kept) {
      this.objects.delete(key);
      this.objects.set(key, kept);
      return kept.value as Promise<T | null>;
    }
    const entry = { value: load(), size: 0 };
    this.objects.set(key, entry);
    entry.value.then(value => {
      if (this.objects.get(key) !== entry) return;
      const size = value === null ? Infinity : sizeOf(value);
      if (size > this.limit) { this.objects.delete(key); return; }
      entry.size = size;
      this.bytes += size;
      for (const [oldest, old] of this.objects) {
        if (this.bytes <= this.limit) break;
        this.objects.delete(oldest);
        this.bytes -= old.size;
      }
    }, () => { if (this.objects.get(key) === entry) this.objects.delete(key); });
    return entry.value;
  }
}
/**
 * One file at a commit as the browser shows it: its text, or a description of a directory, submodule, binary or
 * oversized file. The blob is read by its hash, so a caching reader keeps it for every path and commit that shares it.
 */
export async function fileAt(repo: ComposeReader, ref: string, path: string): Promise<RepositoryFile> {
  const found = await repositoryEntry(repo, ref, path);
  if (found.kind === 'dir' || found.kind === 'submodule') return { content: '', path, ref, kind: found.kind, hash: found.hash };
  let blob: Blob | null;
  try { blob = await repo.readBlob(found.hash); }
  catch (error) {
    if (!artifactsFailed(error, 'MEMORY_LIMIT')) throw error;
    return { content: '', path, ref, hash: found.hash, kind: 'large' };
  }
  if (!blob) throw new HttpError(404, 'File not found.');
  const meta = { path, ref, hash: found.hash, size: blob.size };
  if (blob.size > TEXT_LIMIT) return { ...meta, content: '', kind: 'large' };
  const text = await blobText(blob);
  if (text === null) return { ...meta, content: '', kind: 'binary' };
  return { ...meta, content: text.replace(/^\uFEFF/, ''), kind: found.kind === 'symlink' ? 'symlink' : 'text' };
}
export function treePage(ref: string, path: string, entries: RepositoryEntry[], cursor: string | null): RepositoryTree {
  const offset = cursor === null ? 0 : Number(cursor);
  if (cursor !== null && (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(offset) || offset > entries.length))
    throw new HttpError(400, 'Invalid directory cursor.');
  entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const end = offset + 200;
  return { ref, path, entries: entries.slice(offset, end), nextCursor: end < entries.length ? String(end) : null };
}
export function demoEntries(files: Record<string, string>, path: string): RepositoryEntry[] {
  repositoryPath(path);
  const prefix = path ? `${path}/` : '', result = new Map<string, RepositoryEntry>();
  for (const file of Object.keys(files)) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length), slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    result.set(name, { name, path: prefix + name, kind: slash < 0 ? 'file' : 'dir', mode: slash < 0 ? '100644' : '040000', hash: '' });
  }
  return [...result.values()];
}
