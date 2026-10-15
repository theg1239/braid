import { advertisement, GitError, relay, relayHistory, ZERO, type GitEndpoint } from '../git/transport';

/** The most branches one import copies. */
export const BRANCH_LIMIT = 300;
const HEADS = 'refs/heads/';
/** Keeps the default branch's copied history referenced; Git clients and public readers never see it. */
export const HISTORY_REF = 'refs/braid/history';
/** Artifacts refuses a push near 30 MB (26 MB was accepted, 31 MB refused), so each part of history stays under it. */
export const HISTORY_PART_BYTES = 24 * 1024 * 1024;
/** How many commits deep the first part of history reaches; later parts grow while they stay small. */
export const HISTORY_FIRST_DEPTH = 256;
const HISTORY_MAX_DEPTH = 8192;

/**
 * The default branch's history still to copy beneath an import: the copy's commits whose parents are missing, and
 * how many commits deep the next part reaches. `copied` counts how deep beneath the import's tip the copy reaches, and
 * `limit` how deep it may go. `stopped` marks where copying ends: at the limit, or at a commit too large for one push.
 */
export interface HistoryCopy { boundary: string[]; depth?: number; copied?: number; limit?: number; stopped?: true }

export interface BranchCopy {
  /** The branches the copy has, its default first. */
  branches: string[];
  /** Branches the source refused or the copy rejected in this run. */
  failed: string[];
  /** Branches left for a later run once this one ran out of time. */
  remaining: number;
  /** History still to copy; absent once it reached its roots. */
  history?: HistoryCopy;
}

const heads = (refs: Map<string, string>) =>
  [...refs].filter(([ref]) => ref.startsWith(HEADS)).map(([ref, tip]) => ({ name: ref.slice(HEADS.length), tip }));

/**
 * Copies a source repository's history and other branches into an import's copy, which Artifacts made from the
 * default branch alone, one commit deep. History comes first, in parts one push can carry: the commit list reads it,
 * and branches copied after it carry only their own commits. `missing` reads which boundary commits still lack
 * parents, and `saved` hears each part as it lands. Each branch offers the copy's tips as haves, and every pack is
 * thin, so only what the copy lacks travels. `defaultOnly` leaves the other branches out. Work stops at `until`;
 * whatever is left is reported for the next run. A repository at its storage limit stops the copy with `full`.
 */
export async function copyBranches(options: {
  source: GitEndpoint; target: GitEndpoint; defaultBranch: string; until: number; skip?: ReadonlySet<string>; defaultOnly?: true; transfer?: Parameters<typeof relay>[0]['transfer'];
  /** The most one part of history may carry: what Artifacts accepts in a push, unless a smaller target says less. */
  partBytes?: number;
  history?: { copy: HistoryCopy; missing(boundary: string[]): Promise<{ boundary: string[]; parents: string[] }>; saved(copy: HistoryCopy | undefined): Promise<void> };
}): Promise<BranchCopy> {
  const { source, target, defaultBranch, until, skip = new Set<string>(), partBytes = HISTORY_PART_BYTES } = options;
  const [from, to] = await Promise.all([advertisement(source, 'git-upload-pack', 4 * 1024 * 1024), advertisement(target, 'git-receive-pack', 4 * 1024 * 1024)]);
  const present = new Map(heads(to.refs).map(({ name, tip }) => [name, tip]));
  let history = options.history?.copy;
  while (history && !history.stopped && Date.now() < until) {
    const { copied = 0, limit } = history;
    const depth = Math.min(history.depth ?? HISTORY_FIRST_DEPTH, limit === undefined ? Infinity : limit - copied);
    const { boundary, parents } = await options.history!.missing(history.boundary);
    if (!parents.length) history = undefined;
    else if (depth < 1) history = { ...history, boundary, stopped: true };
    else {
      try {
        const part = await relayHistory({ source, target, boundary, parents, depth, ref: HISTORY_REF, have: [...present.values()], limit: partBytes, transfer: options.transfer });
        history = part.boundary.length ? { boundary: part.boundary, depth: part.bytes < partBytes / 4 ? Math.min(depth * 2, HISTORY_MAX_DEPTH) : depth, copied: copied + depth, ...(limit === undefined ? {} : { limit }) } : undefined;
      } catch (error) {
        if (!(error instanceof GitError && error.code === 'too_large')) throw error;
        // One commit larger than a push can carry ends the copy there; the commit list stops at it.
        history = { ...history, boundary, depth: Math.max(1, Math.floor(depth / 4)), ...(depth > 1 ? {} : { stopped: true as const }) };
      }
    }
    await options.history!.saved(history);
  }
  // Until its history is complete, the copy's boundary still tells the source which parents it lacks.
  const shallow = history?.boundary ?? [];
  const haves = [...new Set([...shallow, ...present.values()])];
  const wanted = options.defaultOnly ? [] : heads(from.refs).filter(({ name }) => name !== defaultBranch && !present.has(name) && !skip.has(name))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, Math.max(0, BRANCH_LIMIT - present.size));
  const failed: string[] = [];
  let remaining = 0;
  for (const { name, tip } of wanted) {
    if (Date.now() >= until || history && !history.stopped) { remaining++; continue; }
    try {
      await relay({ source, target, want: tip, ref: `${HEADS}${name}`, expected: ZERO, have: haves.slice(0, 64), ...(shallow.length ? { shallow } : {}), thin: true, transfer: options.transfer });
      present.set(name, tip);
      haves.unshift(tip);
    } catch (error) {
      if (error instanceof GitError && error.code === 'full') throw error;
      failed.push(name);
    }
  }
  const others = [...present.keys()].filter(name => name !== defaultBranch).sort((a, b) => a.localeCompare(b));
  return { branches: [...(present.has(defaultBranch) ? [defaultBranch] : []), ...others], failed, remaining, ...(history ? { history } : {}) };
}
