import git, { type CommitObject, type TreeEntry } from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { HttpError } from '../errors';
import { cachedReader, type GitObjectReader } from './objects';
import { advertisement, GitError, receive, ZERO } from './transport';
import { isBlobEdit, type GitFileEdit } from './edits';

const author = { name: 'Braid', email: 'agents@braid.local' };
const dir = '/workspace';
const encoder = new TextEncoder();
const moved = 'The Git branch moved since this mission started. No changes were pushed. Update the task from current main before retrying.';
/** The refs a push compares against, from a server that confirms each update it takes. */
async function receivingRefs(remote: string, token: string): Promise<Map<string, string>> {
  const { refs, capabilities } = await advertisement({ remote, token }, 'git-receive-pack', 8 * 1024 * 1024);
  if (!capabilities.has('report-status')) throw new GitError('invalid', 'The Git server cannot confirm updates.');
  return refs;
}

interface GitEditLimits { contentBytes: number; treeBytes: number }
const PROPOSAL_LIMITS: GitEditLimits = { contentBytes: 29_000_000, treeBytes: 29_000_000 };
/** Bound pack construction separately from content already stored as Git blobs. */
const BATCH_LIMITS: GitEditLimits = PROPOSAL_LIMITS;
type StagedFile = { oid: string; mode?: '100644' | '100755' } | null;
interface EditTree { files: Map<string, StagedFile>; children: Map<string, EditTree> }

/** Validates paths and writes blobs once; content limits are shared across every commit in a push. */
async function stageFiles(files: Record<string, GitFileEdit>, writeBlob: (bytes: Uint8Array) => Promise<string>, budget: { bytes: number; limit: number }) {
  const staged = new Map<string, StagedFile>();
  for (const [path, edit] of Object.entries(files)) {
    const parts = path.split('/');
    // Internal .braid ledgers are allowed here; Git internals and ambiguous paths are not.
    if (path.length > 240 || /[\x00-\x1f\x7f\\]/.test(path) || /[\uD800-\uDFFF]/u.test(path)
      || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new HttpError(400, 'Invalid Git file path.');
    if (edit === null) { staged.set(path, null); continue; }
    if (isBlobEdit(edit)) { staged.set(path, { oid: edit.blob, mode: edit.mode }); continue; }
    const content = typeof edit === 'string' ? edit : edit.content;
    const mode = typeof edit === 'string' ? undefined : edit.mode;
    if (mode !== undefined && mode !== '100644' && mode !== '100755') throw new HttpError(400, 'Invalid Git file mode.');
    const bytes = encoder.encode(content);
    budget.bytes += bytes.length;
    if (budget.bytes > budget.limit) throw new HttpError(413, 'Cloudflare Artifacts accepts about 30 MB per push. Upload Git objects in separate pushes, then submit their blob hashes.');
    staged.set(path, { oid: await writeBlob(bytes), mode });
  }
  return staged;
}

/** Rewrites only the changed paths' ancestor trees; untouched subtrees keep their original object IDs. */
async function buildTree(staged: Map<string, StagedFile>, repository: GitObjectReader | undefined, baseTree: string | undefined,
  writeTree: (tree: TreeEntry[]) => Promise<string>, limits: GitEditLimits) {
  const modes: Record<string, string | undefined> = Object.create(null);
  const editTree = (): EditTree => ({ files: new Map(), children: new Map() });
  const edits = editTree();
  for (const [path, file] of staged) {
    const parts = path.split('/');
    let node = edits;
    for (const part of parts.slice(0, -1)) {
      if (node.files.has(part)) throw new HttpError(400, 'Git file and directory paths overlap.');
      if (!node.children.has(part)) node.children.set(part, editTree());
      node = node.children.get(part)!;
    }
    const name = parts.at(-1)!;
    if (node.children.has(name)) throw new HttpError(400, 'Git file and directory paths overlap.');
    node.files.set(name, file);
  }
  let treeBytes = 0;
  const updateTree = async (original: string | undefined, node: EditTree, prefix = ''): Promise<string | undefined> => {
    const entries = original ? await repository!.readTree(original) : [];
    if (!entries) throw new Error('The repository tree is not available yet. Try again shortly.');
    treeBytes += encoder.encode(JSON.stringify(entries)).length;
    if (treeBytes > limits.treeBytes) throw new HttpError(413, 'Cloudflare Workers provides 128 MB of memory. This push exceeds the 29 MB working allowance for Git tree metadata. Split the changed paths across pull requests.');
    const tree = new Map<string, TreeEntry>(entries.map(entry => [entry.name, { path: entry.name, mode: entry.mode, type: entry.type === 'tree' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', oid: entry.hash }]));
    for (const [name, edit] of node.files) {
      const previous = tree.get(name);
      modes[prefix + name] = previous?.mode;
      if (previous?.mode === '120000') throw new HttpError(400, 'Agent writes cannot follow repository symlinks.');
      if (previous && !['100644', '100755'].includes(previous.mode)) throw new HttpError(400, 'Git files cannot replace directories or submodules.');
      if (edit === null) tree.delete(name);
      else tree.set(name, { path: name, mode: edit.mode ?? previous?.mode ?? '100644', type: 'blob', oid: edit.oid });
    }
    for (const [name, child] of node.children) {
      const previous = tree.get(name);
      if (previous?.mode === '120000') throw new HttpError(400, 'Agent writes cannot follow repository symlinks.');
      if (previous && previous.type !== 'tree') throw new HttpError(400, 'Git directories cannot replace files or submodules.');
      const oid = await updateTree(previous?.oid, child, `${prefix}${name}/`);
      if (oid) tree.set(name, { path: name, mode: '040000', type: 'tree', oid });
      else tree.delete(name);
    }
    if (!tree.size) return undefined;
    return writeTree([...tree.values()]);
  };
  const tree = await updateTree(baseTree, edits) ?? await writeTree([]);
  return { tree, modes };
}

/** Validates the complete update against its pinned tree without creating tokens or publishing objects. */
export async function validateGitChanges(repository: GitObjectReader, parent: string, files: Record<string, GitFileEdit>) {
  const commit = await repository.readCommit(parent);
  if (!commit) throw new Error('The repository head is not available yet. Try again shortly.');
  const staged = await stageFiles(files, async () => ZERO, { bytes: 0, limit: PROPOSAL_LIMITS.contentBytes });
  return (await buildTree(staged, repository, commit.treeHash, async () => ZERO, PROPOSAL_LIMITS)).modes;
}

function checkBranch(branch: string) {
  if (!branch || branch.length > 512 || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch)
    || branch.includes('..') || branch.includes('@{') || branch.endsWith('.')
    || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))
    throw new Error('Invalid Git branch.');
  return `refs/heads/${branch}`;
}

/** Receive-pack compares the advertised old OID before moving the ref; its report is read where every push's is. */
const sendPack = (remote: string, token: string, update: { old: string; new: string; ref: string }, packfile: Uint8Array) =>
  receive({ remote, token }, [update], new Blob([packfile as BlobPart]).stream());

export async function commitFiles(options: {
  remote: string; token: string; branch: string; files: Record<string, GitFileEdit>;
  message: string; expectedHead?: string; initialize?: boolean; authorName?: string;
  /** Isolated proposals may have a pinned parent older than the fork's current ref. */
  parentCommit?: string;
  repository?: GitObjectReader;
  preparedCommit?: string; onPrepared?: (commit: string) => Promise<void>;
}): Promise<string> {
  const ref = checkBranch(options.branch);
  const head = (await receivingRefs(options.remote, options.token)).get(ref) ?? ZERO;
  // Only the exact durably recorded commit proves that a lost push response succeeded.
  if (options.preparedCommit && head === options.preparedCommit) return head;
  if (options.initialize ? head !== ZERO : !options.expectedHead || head !== options.expectedHead) throw new GitError('moved', moved);
  let baseTree: string | undefined;
  const parent = options.parentCommit ?? head;
  if (!/^[a-f0-9]{40}$/.test(parent)) throw new Error('Invalid Git parent commit.');
  if (!options.initialize || options.parentCommit) {
    if (!options.repository) throw new Error('Git object metadata is required to publish an existing repository.');
    baseTree = (await options.repository.readCommit(parent))?.treeHash;
    if (!baseTree) throw new Error('The repository head is not available yet. Try again shortly.');
  }
  const identity = { ...author, name: options.authorName ?? author.name, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const pack = await packWriter();
  const staged = await stageFiles(options.files, pack.writeBlob, { bytes: 0, limit: PROPOSAL_LIMITS.contentBytes });
  const { tree } = await buildTree(staged, options.repository, baseTree, pack.writeTree, PROPOSAL_LIMITS);
  const commit = await pack.writeCommit({ tree, parent: parent === ZERO ? [] : [parent], author: identity, committer: identity, message: options.message });
  const packfile = await pack.packfile();
  if (options.onPrepared) await options.onPrepared(commit);
  await sendPack(options.remote, options.token, { old: head, new: commit, ref }, packfile);
  return commit;
}

type Created = { commits: Map<string, { treeHash: string }>; trees: Map<string, ArtifactsTreeEntry[]>; blobs: Map<string, Uint8Array> };
/**
 * An in-memory repository holding one pack's objects: only new blobs, changed ancestor trees and new commits enter it.
 * Each object is told to `created` as Artifacts lists it.
 */
async function packWriter(created?: Created) {
  const fs = createFsFromVolume(new Volume()), objects = new Set<string>();
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir });
  return {
    writeBlob: async (bytes: Uint8Array) => { const oid = await git.writeBlob({ fs, dir, blob: bytes }); objects.add(oid); created?.blobs.set(oid, bytes); return oid; },
    writeTree: async (tree: TreeEntry[]) => {
      const oid = await git.writeTree({ fs, dir, tree }); objects.add(oid);
      created?.trees.set(oid, tree.map(entry => ({ name: entry.path, hash: entry.oid, mode: entry.mode === '040000' ? '40000' : entry.mode,
        type: entry.type === 'tree' ? 'tree' : entry.mode === '160000' ? 'gitlink' : entry.mode === '120000' ? 'symlink' : entry.mode === '100755' ? 'exec' : 'blob' })));
      return oid;
    },
    writeCommit: async (commit: CommitObject) => { const oid = await git.writeCommit({ fs, dir, commit }); objects.add(oid); created?.commits.set(oid, { treeHash: commit.tree }); return oid; },
    packfile: async () => {
      const { packfile } = await git.packObjects({ fs, dir, oids: [...objects] });
      if (!packfile) throw new Error('Git did not produce a packfile.');
      if (packfile.byteLength > 29_000_000) throw new HttpError(413, 'Artifacts accepts about 30 MB per Git push. This pack exceeds the 29 MB transfer allowance. Upload the Git objects in smaller pushes first.');
      return packfile;
    },
  };
}

export interface CommitSpec {
  /** This commit's own edits, applied on top of the previous commit in the chain. */
  files: Record<string, GitFileEdit>;
  message: string; authorName?: string; authorEmail?: string;
  /** Additional parents, such as an imported pull request head that this commit integrates. */
  extraParents?: string[];
}

/**
 * Lands a chain of commits on a branch with one compare-and-swap push: each
 * reviewed change keeps its own commit and provenance, and a moved branch
 * rejects the whole chain. `prepared` recovers a push whose response was lost.
 */
export async function pushCommits(options: {
  remote: string; token: string; branch: string; expectedHead: string; repository: GitObjectReader;
  /** Parent of the first commit when it differs from the ref's current value, such as a new staging branch. */
  parent?: string;
  commits: CommitSpec[]; prepared?: string[]; onPrepared?: (commits: string[]) => Promise<void>;
  /** Receives every object this push creates, so callers can cache the new trunk without reading it back. */
  created?: Created;
}): Promise<string[]> {
  const ref = checkBranch(options.branch);
  if (!options.commits.length) throw new Error('A landing needs at least one commit.');
  const head = (await receivingRefs(options.remote, options.token)).get(ref) ?? ZERO;
  if (options.prepared?.length && head === options.prepared.at(-1)) return options.prepared;
  if (head !== options.expectedHead) throw new GitError('moved', moved);
  const reader = cachedReader(options.repository);
  const first = options.parent ?? head;
  if (!/^[a-f0-9]{40}$/.test(first) || first === ZERO) throw new Error('Invalid Git parent commit.');
  const baseTree = (await reader.readCommit(first))?.treeHash;
  if (!baseTree) throw new Error('The repository head is not available yet. Try again shortly.');
  const pack = await packWriter(options.created);
  const cumulative = new Map<string, StagedFile>(), budget = { bytes: 0, limit: BATCH_LIMITS.contentBytes };
  const commits: string[] = [];
  const timestamp = Math.floor(Date.now() / 1000);
  let parent = first;
  for (const spec of options.commits) {
    for (const extra of spec.extraParents ?? []) if (!/^[a-f0-9]{40}$/.test(extra)) throw new Error('Invalid Git parent commit.');
    for (const [path, file] of await stageFiles(spec.files, pack.writeBlob, budget)) cumulative.set(path, file);
    const { tree } = await buildTree(cumulative, reader, baseTree, pack.writeTree, BATCH_LIMITS);
    const identity = { name: spec.authorName ?? author.name, email: spec.authorEmail ?? author.email, timestamp, timezoneOffset: 0 };
    parent = await pack.writeCommit({ tree, parent: [parent, ...(spec.extraParents ?? [])], author: identity, committer: { ...author, timestamp, timezoneOffset: 0 }, message: spec.message });
    commits.push(parent);
  }
  const packfile = await pack.packfile();
  if (options.onPrepared) await options.onPrepared(commits);
  await sendPack(options.remote, options.token, { old: head, new: parent, ref }, packfile);
  return commits;
}

/** Retain a revision's existing objects under one hidden, content-addressed ref so Git GC cannot remove them. */
export async function retainBlobs(options: { remote: string; token: string; blobs: string[]; parents: string[]; beforePush: () => Promise<unknown> }): Promise<void> {
  const hashes = [...new Set(options.blobs)].sort(), parents = [...new Set(options.parents)];
  if ([...hashes, ...parents].some(hash => !/^[a-f0-9]{40}$/.test(hash) || hash === ZERO)) throw new Error('Invalid retained Git object.');
  const pack = await packWriter();
  const tree = await pack.writeTree(hashes.map(oid => ({ path: oid, oid, mode: '100644', type: 'blob' })));
  // Deterministic metadata makes a retried submission reuse the same retention ref.
  const identity = { ...author, timestamp: 0, timezoneOffset: 0 };
  const commit = await pack.writeCommit({ tree, parent: parents, author: identity, committer: identity, message: 'Retain pull request objects\n' });
  const ref = `refs/braid/revisions/${commit}`;
  if ((await receivingRefs(options.remote, options.token)).get(ref) === commit) return;
  const packfile = await pack.packfile();
  await options.beforePush();
  try { await sendPack(options.remote, options.token, { old: ZERO, new: commit, ref }, packfile); }
  catch (error) {
    // Another submission can retain exactly the same objects while this request is preparing its pack.
    if (error instanceof GitError && error.code === 'rejected' && (await receivingRefs(options.remote, options.token)).get(ref) === commit) return;
    throw error;
  }
}

/**
 * Adds Git notes to a notes ref such as refs/notes/braid, as one commit on top of the notes the server has. Each note
 * is a blob named by the commit it describes, under a two-character fan-out as Git lays out larger notes trees, so a
 * landing rewrites one small subtree. The push is a compare-and-swap on the notes ref.
 */
export async function pushNotes(options: {
  remote: string; token: string; ref: string; repository: GitObjectReader;
  notes: Record<string, string>; message: string; created?: Created;
}): Promise<string> {
  if (!/^refs\/notes\/[A-Za-z0-9._-]+$/.test(options.ref)) throw new Error('Invalid Git notes ref.');
  const current = (await receivingRefs(options.remote, options.token)).get(options.ref) ?? ZERO;
  const reader = cachedReader(options.repository);
  const baseTree = current === ZERO ? undefined : (await reader.readCommit(current))?.treeHash;
  if (current !== ZERO && !baseTree) throw new Error('The notes are not available yet. Try again shortly.');
  const pack = await packWriter(options.created);
  const files = Object.fromEntries(Object.entries(options.notes).map(([commit, text]) => {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Notes describe commits by their full ID.');
    return [`${commit.slice(0, 2)}/${commit.slice(2)}`, text];
  }));
  const staged = await stageFiles(files, pack.writeBlob, { bytes: 0, limit: BATCH_LIMITS.contentBytes });
  const { tree } = await buildTree(staged, reader, baseTree, pack.writeTree, BATCH_LIMITS);
  const identity = { ...author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
  const commit = await pack.writeCommit({ tree, parent: current === ZERO ? [] : [current], author: identity, committer: identity, message: options.message });
  await sendPack(options.remote, options.token, { old: current, new: commit, ref: options.ref }, await pack.packfile());
  return commit;
}
