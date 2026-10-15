import git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { advertisement, deleteRefs, fetchTrees, GitError, receive, relayObjects, ZERO, type GitEndpoint } from '../git/transport';

/** One part stays below the request size that Artifacts' receive-pack takes, about 30 MB. */
export const PART_BYTES = 24 * 1024 * 1024;
/** A single file may use the whole request: 26 MB arrived in production, 31 MB was cut off. */
export const FILE_BYTES = 29 * 1024 * 1024;
/** The commit's directories, read once; Workers have 128 MB of memory. */
const TREE_BYTES = 64 * 1024 * 1024;
const FILES_PER_PART = 256;
const PARTS = 'refs/braid/parts/';

type Transfer = () => Promise<{ wrap(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>; finish(): Promise<void> }>;

/**
 * Copies one commit, one level deep, from `source` into an empty `target` branch in pushes Artifacts accepts, for a
 * snapshot too large for one import. GitHub serves any reachable tree with everything beneath it, and Artifacts lets a
 * hidden ref point at a tree. So each directory that fits one push travels whole under `refs/braid/parts/`, and one
 * that does not is split into its directories and batches of its files, then its own tree follows. The commit goes
 * last, onto the branch: the branch appearing is what publication waits for. Each part is kept by its ref, so a copy
 * that stops resumes where it was. The part refs are deleted at the end.
 */
export async function copyInParts(options: { source: GitEndpoint; target: GitEndpoint; commit: string; branch: string; transfer?: Transfer; progress?: () => Promise<void>; partBytes?: number; fileBytes?: number }) {
  const { source, target, commit } = options, branch = `refs/heads/${options.branch}`;
  const partBytes = options.partBytes ?? PART_BYTES, fileBytes = options.fileBytes ?? FILE_BYTES;
  const refs = (await advertisement(target, 'git-receive-pack')).refs;
  if (refs.get(branch) !== commit) {
    const store = await treesOf(source, commit);
    const stored = new Set([...refs].filter(([ref]) => ref.startsWith(PARTS)).map(([, oid]) => oid));
    /** True once the objects are stored; false when they were too large for `limit`. */
    const relayed = async (oids: string[], limit = partBytes) => {
      try { await relayObjects({ source, target, objects: oids.map(oid => ({ oid, ref: PARTS + oid })), limit, transfer: options.transfer }); }
      catch (error) { if (error instanceof GitError && error.code === 'too_large') return false; throw error; }
      for (const oid of oids) stored.add(oid);
      await options.progress?.();
      return true;
    };
    const files = async (oids: string[]): Promise<void> => {
      if (await relayed(oids)) return;
      if (oids.length > 1) { const half = Math.ceil(oids.length / 2); await files(oids.slice(0, half)); await files(oids.slice(half)); return; }
      if (!await relayed(oids, fileBytes)) throw new GitError('too_large', 'A file in this repository is larger than one push may carry.');
    };
    const directory = async (oid: string): Promise<void> => {
      if (stored.has(oid) || await relayed([oid])) return;
      const entries = await store.entries(oid);
      for (const entry of entries) if (entry.type === 'tree') await directory(entry.oid);
      // Gitlinks name commits of other repositories; a submodule's contents are not part of this one.
      const blobs = [...new Set(entries.filter(entry => entry.type === 'blob').map(entry => entry.oid))].filter(blob => !stored.has(blob));
      for (let index = 0; index < blobs.length; index += FILES_PER_PART) await files(blobs.slice(index, index + FILES_PER_PART));
      await receive(target, [{ old: ZERO, new: oid, ref: PARTS + oid }], await store.pack(oid));
      stored.add(oid);
      await options.progress?.();
    };
    await directory(store.root);
    // The commit's parents stay at GitHub: the branch starts shallow, as a depth-one import does.
    await receive(target, [{ old: refs.get(branch) ?? ZERO, new: commit, ref: branch }], await store.pack(commit), [commit]);
  }
  // Everything is reachable from the branch now.
  const parts = [...(await advertisement(target, 'git-receive-pack')).refs].filter(([ref]) => ref.startsWith(PARTS)).map(([ref, old]) => ({ ref, old }));
  for (let index = 0; index < parts.length; index += 500) await deleteRefs(target, parts.slice(index, index + 500));
}

/** The commit and its trees in an in-memory repository: entries of any directory, and a pack of any one object. */
async function treesOf(source: GitEndpoint, commit: string) {
  const fs = createFsFromVolume(new Volume()), dir = '/trees', file = '.git/objects/pack/pack-trees.pack';
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir });
  await fs.promises.writeFile(`${dir}/${file}`, await fetchTrees(source, commit, TREE_BYTES));
  await git.indexPack({ fs, dir, filepath: file });
  return {
    root: (await git.readCommit({ fs, dir, oid: commit })).commit.tree,
    entries: async (oid: string) => (await git.readTree({ fs, dir, oid })).tree,
    pack: async (oid: string) => {
      const { packfile } = await git.packObjects({ fs, dir, oids: [oid] });
      if (!packfile) throw new Error('Git did not produce a packfile.');
      return new Blob([packfile as BlobPart]).stream();
    },
  };
}
