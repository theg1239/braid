/** Reading and naming Git objects, without the Git library that writes them. */
import { parseNote, type BraidNote, type CommitFacts } from '../../shared/provenance';
import { artifactsFailed } from '../errors';
import { hex } from '../http/auth';

const encoder = new TextEncoder();

/** Artifacts supplies metadata without transferring unrelated file contents or history. */
export interface GitObjectReader {
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
}

/** Trees and commits are immutable, so one landing reads each ancestor at most once. */
export function cachedReader(repository: GitObjectReader): GitObjectReader {
  const commits = new Map<string, Promise<{ treeHash: string } | null>>(), trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  const remember = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    let value = cache.get(key);
    if (!value) { value = load(); cache.set(key, value); value.catch(() => cache.delete(key)); }
    return value;
  };
  return {
    readCommit: hash => remember(commits, hash, () => repository.readCommit(hash)),
    readTree: hash => remember(trees, hash, () => repository.readTree(hash)),
  };
}

/** The entry at `path` in a tree, a directory included, or undefined where the path is absent. A tree the reader lacks throws `missing()`. */
export async function treeEntry(repository: Pick<GitObjectReader, 'readTree'>, tree: string, path: string, missing: () => Error): Promise<ArtifactsTreeEntry | undefined> {
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entries = await repository.readTree(tree);
    if (!entries) throw missing();
    const entry = entries.find(item => item.name === parts[index]);
    if (!entry || index === parts.length - 1) return entry;
    if (entry.type !== 'tree') return;
    tree = entry.hash;
  }
}
/** The file at `path` in a tree, or undefined where the path is absent or names a directory. */
export async function treeFile(repository: Pick<GitObjectReader, 'readTree'>, tree: string, path: string, missing: () => Error): Promise<ArtifactsTreeEntry | undefined> {
  const entry = await treeEntry(repository, tree, path, missing);
  return entry?.type === 'tree' ? undefined : entry;
}

/** The largest note read: per-file attribution makes a task's note far larger than one commit's. */
const NOTE_BYTES = 1024 * 1024;
/** Braid's note on `commit` in a notes tree, wherever Git's fan-out put it, or null. A tree the reader lacks throws `missing()`. */
export async function readNote(repository: Pick<ArtifactsRepo, 'readTree' | 'readBlob'>, tree: string, commit: string, missing: () => Error): Promise<BraidNote | null> {
  for (let offset = 0; offset < commit.length; offset += 2) {
    const entries = await repository.readTree(tree);
    if (!entries) throw missing();
    const leaf = entries.find(entry => entry.name === commit.slice(offset));
    if (leaf && leaf.type !== 'tree') {
      const blob = await repository.readBlob(leaf.hash);
      return blob && blob.size <= NOTE_BYTES ? parseNote(await blob.text()) : null;
    }
    const folder = entries.find(entry => entry.name === commit.slice(offset, offset + 2));
    if (folder?.type !== 'tree') return null;
    tree = folder.hash;
  }
  return null;
}

/** A blob's text, or null for what Git shows as binary: invalid UTF-8 or a NUL byte. */
export async function blobText(blob: Blob): Promise<string | null> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer());
    return text.includes('\0') ? null : text;
  } catch { return null; }
}

/** A file whose entry differs between two trees; the side without it is undefined. */
type ChangedFile = { path: string; before: ArtifactsTreeEntry | undefined; after: ArtifactsTreeEntry | undefined };
/**
 * The files that differ between two trees, as a diff view lists them. Equal subtree hashes are skipped; mode changes
 * and file/directory replacements still count. Past `files` files, `entries` tree entries or `depth` levels the list
 * is truncated. A tree the reader lacks throws `missing()`.
 */
export async function treeChanges(repository: Pick<GitObjectReader, 'readTree'>, before: string | undefined, after: string | undefined,
  limits: { files: number; entries: number; depth: number }, missing: () => Error): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const files: ChangedFile[] = [], trees = new Map<string, Promise<ArtifactsTreeEntry[]>>();
  let entries = 0, truncated = false;
  const tree = (hash?: string) => {
    if (!hash) return Promise.resolve([]);
    let read = trees.get(hash);
    if (!read) trees.set(hash, read = repository.readTree(hash).then(found => { if (!found) throw missing(); return found; }));
    return read;
  };
  const visit = async (left: string | undefined, right: string | undefined, prefix: string, depth: number) => {
    if (left === right || truncated) return;
    if (depth > limits.depth) { truncated = true; return; }
    const [a, b] = await Promise.all([tree(left), tree(right)]);
    entries += a.length + b.length;
    if (entries > limits.entries) { truncated = true; return; }
    const old = new Map(a.map(entry => [entry.name, entry])), next = new Map(b.map(entry => [entry.name, entry]));
    for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const x = old.get(name), y = next.get(name), path = prefix + name;
      if (x?.hash === y?.hash && x?.mode === y?.mode) continue;
      const before = x?.type === 'tree' ? undefined : x, after = y?.type === 'tree' ? undefined : y;
      if (before || after) {
        if (files.length === limits.files) { truncated = true; return; }
        files.push({ path, before, after });
      }
      if (x?.type === 'tree' || y?.type === 'tree') await visit(x?.type === 'tree' ? x.hash : undefined, y?.type === 'tree' ? y.hash : undefined, `${path}/`, depth + 1);
      if (truncated) return;
    }
  };
  await visit(before, after, '', 0);
  return { files, truncated };
}

type FileText = { text: string | null; binary: boolean; tooLarge: boolean; limited: boolean };
/**
 * A diff view's reader of file text, each blob read once. A file over `text` bytes is too large to show, and once the
 * view has read `bytes` in all, the files after it are `limited`. A submodule reads as Git prints it.
 */
export function fileTexts(repository: Pick<ArtifactsRepo, 'readBlob'>, limits: { text: number; bytes: number }, missing: () => Error) {
  let bytes = 0;
  const cache = new Map<string, Promise<FileText>>();
  const empty: FileText = { text: null, binary: false, tooLarge: false, limited: false };
  const read = async (entry: ArtifactsTreeEntry): Promise<FileText> => {
    if (entry.mode === '160000') return { ...empty, text: `Subproject commit ${entry.hash}\n` };
    if (bytes >= limits.bytes) return { ...empty, limited: true };
    let blob: Blob | null;
    try { blob = await repository.readBlob(entry.hash); }
    catch (error) {
      if (artifactsFailed(error, 'MEMORY_LIMIT')) return { ...empty, tooLarge: true };
      throw error;
    }
    if (!blob) throw missing();
    bytes += blob.size;
    if (blob.size > limits.text) return { ...empty, tooLarge: true };
    if (bytes > limits.bytes) return { ...empty, limited: true };
    const text = await blobText(blob);
    return text === null ? { ...empty, binary: true } : { ...empty, text };
  };
  return (entry: ArtifactsTreeEntry | undefined) => {
    if (!entry) return Promise.resolve(empty);
    let result = cache.get(entry.hash);
    if (!result) cache.set(entry.hash, result = read(entry));
    return result;
  };
}

/** What provenance reads from a commit: its id, author time, author and message. */
export const commitFacts = (commit: Pick<ArtifactsCommitMetadata, 'hash' | 'authoredAt' | 'author' | 'message'>): CommitFacts =>
  ({ id: commit.hash, at: new Date(commit.authoredAt * 1000).toISOString(), author: commit.author, message: commit.message });
/** The object ID Git assigns to file content, without writing it anywhere. */
export async function gitBlobHash(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  const header = encoder.encode(`blob ${bytes.length}\0`), data = new Uint8Array(header.length + bytes.length);
  data.set(header); data.set(bytes, header.length);
  return hex(await crypto.subtle.digest('SHA-1', data));
}
