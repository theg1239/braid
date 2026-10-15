import { HttpError, logFailure } from '../errors';
import { scanBlob } from './scan';

type PushedFile = { path: string; blob: string; mode: '100644' | '100755' } | { path: string; content: null };
/** One pushed commit and whether its snapshot, against the base it was pushed on, adds a credential. */
export type PushedCommit = { commit: string; secrets: boolean };

/** Changed paths and immutable blob identities; no file contents enter the submission body. */
export async function changedFiles(artifacts: Pick<ArtifactsRepo, 'readTree' | 'readBlob'>, before: string | null, after: string | null, prefix = ''): Promise<PushedFile[]> {
  const [old, next] = await Promise.all([before ? artifacts.readTree(before) : [], after ? artifacts.readTree(after) : []]);
  if (!old || !next) throw new HttpError(503, 'The pushed history is not readable yet. Retry the push.');
  const was = new Map(old.map(entry => [entry.name, entry])), now = new Map(next.map(entry => [entry.name, entry]));
  const found: PushedFile[] = [];
  for (const name of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(name), b = now.get(name), path = `${prefix}${name}`;
    if (a && b && a.hash === b.hash && a.mode === b.mode) continue;
    if (b?.type === 'symlink' || b?.type === 'gitlink') throw new HttpError(409, `${path} is a symlink or submodule; changes carry regular files only.`);
    if (a?.type === 'tree' || b?.type === 'tree') found.push(...await changedFiles(artifacts, a?.type === 'tree' ? a.hash : null, b?.type === 'tree' ? b.hash : null, `${path}/`));
    if (b && b.type !== 'tree') {
      found.push({ path, blob: b.hash, mode: b.type === 'exec' ? '100755' : '100644' });
    } else if (a && a.type !== 'tree') {
      found.push({ path, content: null });
    }
  }
  return found;
}

/**
 * Each pushed snapshot needs its own scan: a clean tip says nothing about the commits beneath it, which a fetch or a
 * read by hash would show. Files are compared with the base tree, and a blob several snapshots share is read once.
 * Every changed blob is scanned as a stream. Missing blobs and scan failures stay unpublished.
 */
export async function scanPushedHistory(repo: Pick<ArtifactsRepo, 'readTree' | 'readBlob'>, baseTree: string, commits: Pick<ArtifactsCommitMetadata, 'hash' | 'treeHash'>[], _tipFiles?: PushedFile[]): Promise<PushedCommit[]> {
  const blobs = new Map<string, Promise<boolean>>(), trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  const tree = (hash: string) => { let entries = trees.get(hash); if (!entries) trees.set(hash, entries = repo.readTree(hash)); return entries; };
  const unscanned = (error: unknown) => { logFailure('push_scan_failed', error); return true; };
  const secret = (hash: string) => {
    let found = blobs.get(hash);
    if (!found) blobs.set(hash, found = (async () => {
      const blob = await repo.readBlob(hash);
      return !blob || (await scanBlob(hash, blob)).findings.length > 0;
    })().catch(unscanned));
    return found;
  };
  // Whether anything a snapshot adds or changes against the base holds a credential.
  const differs = async (before: string | null, after: string): Promise<boolean> => {
    const [old, next] = await Promise.all([before ? tree(before) : [], tree(after)]);
    if (!next) return true;
    const was = new Map((old ?? []).map(entry => [entry.name, entry]));
    for (const entry of next) {
      const prior = was.get(entry.name);
      if (prior?.hash === entry.hash) continue;
      if (entry.type === 'tree' ? await differs(prior?.type === 'tree' ? prior.hash : null, entry.hash) : entry.type !== 'gitlink' && await secret(entry.hash)) return true;
    }
    return false;
  };
  const history: PushedCommit[] = [];
  for (let index = 0; index < commits.length; index++) {
    const secrets = await differs(baseTree, commits[index].treeHash).catch(unscanned);
    history.push({ commit: commits[index].hash, secrets });
  }
  return history;
}
