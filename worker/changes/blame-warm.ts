import { BLAME_WARM_FILES } from './blame-queue';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|swift|c|cc|cpp|h|hpp|cs|ex|exs|sh|vue|svelte)$/i;
const SOURCE_DIR = /^(?:src|lib|app|server|client|worker|workers|pkg|cmd|include)$/;
const REGULAR = /^(100644|100755)$/;

/** README first, then recently changed source at the root or directly inside its source directories.
 * Discovery reads only trees and at most 32 first-parent commits, never blobs or a recursive file list.
 */
export async function blameWarmPaths(repo: Pick<ArtifactsRepo, 'readCommit' | 'readTree'>, head: string): Promise<string[]> {
  const trees = new Map<string, Promise<ArtifactsTreeEntry[]>>();
  const tree = (hash: string) => {
    let value = trees.get(hash);
    if (!value) { value = repo.readTree(hash).then(entries => entries ?? []); trees.set(hash, value); }
    return value;
  };
  const first = await repo.readCommit(head);
  if (!first) return [];
  const root = await tree(first.treeHash);
  const readme = root.find(entry => REGULAR.test(entry.mode) && /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(entry.name));
  const directories = root.filter(entry => entry.type === 'tree' && SOURCE_DIR.test(entry.name)).slice(0, 8).map(entry => entry.name);
  const sources = async (hash: string) => {
    const entries = await tree(hash);
    const nested = await Promise.all(entries.filter(entry => entry.type === 'tree' && directories.includes(entry.name))
      .map(async entry => (await tree(entry.hash)).map(file => ({ ...file, name: `${entry.name}/${file.name}` }))));
    return new Map([...entries, ...nested.flat()].filter(entry => REGULAR.test(entry.mode) && SOURCE.test(entry.name)).map(entry => [entry.name, entry.hash]));
  };
  const current = await sources(first.treeHash);
  const paths = readme ? [readme.name] : [];
  let commit = first, after = current;
  for (let depth = 0; depth < 32 && paths.length < BLAME_WARM_FILES && after.size; depth++) {
    const parent = commit.parents[0] ? await repo.readCommit(commit.parents[0]) : null;
    const before = parent ? await sources(parent.treeHash) : new Map<string, string>();
    for (const path of [...after.keys()].sort()) {
      if (current.has(path) && !paths.includes(path) && after.get(path) !== before.get(path)) paths.push(path);
      if (paths.length === BLAME_WARM_FILES) break;
    }
    if (!parent) break;
    commit = parent; after = before;
  }
  // Stable fallbacks for files whose last change lies beyond the bounded discovery walk.
  for (const path of current.keys()) if (paths.length < BLAME_WARM_FILES && !paths.includes(path)) paths.push(path);
  return paths;
}
