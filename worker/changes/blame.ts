import { diffArrays } from 'diff';

/**
 * Line attribution kept as run-length ranges and moved by each landing's diff. A range is `[start, count, commit]`,
 * where `commit` is a row in the queue's commit table. Commit 0 marks lines that predate the map: they are lines
 * `origin`, `origin + 1`, … of the map's base commit, attributed from history the first time someone reads them.
 */
export type Range = [start: number, count: number, commit: number, origin?: number];
/** Files longer than this keep no line map; their blame says so. */
export const LINE_CAP = 20_000;
/** Past this many edited lines, a change counts as rewriting the file rather than being searched further. */
export const MAX_EDITS = 5_000;

function expand(ranges: Range[], lines: number) {
  const commits = new Int32Array(lines), origins = new Int32Array(lines);
  for (const [start, count, commit, origin = 0] of ranges) for (let i = 0; i < count && start - 1 + i < lines; i++) {
    commits[start - 1 + i] = commit;
    origins[start - 1 + i] = commit ? 0 : origin + i;
  }
  return { commits, origins };
}
function compress(commits: ArrayLike<number>, origins: ArrayLike<number>): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < commits.length; i++) {
    const last = ranges.at(-1);
    if (last && last[2] === commits[i] && (commits[i] || last[3]! + last[1] === origins[i])) last[1]++;
    else ranges.push(commits[i] ? [i + 1, 1, commits[i]] : [i + 1, 1, 0, origins[i]]);
  }
  return ranges;
}

/** A map of lines none of which Braid has attributed yet: line i is line i of the base commit. */
export const baseRanges = (lines: number): Range[] => lines ? [[1, lines, 0, 1]] : [];
/** A new file's map: every line is its commit's. */
export const newRanges = (lines: number, commit: number): Range[] => lines ? [[1, lines, commit]] : [];

/**
 * Moves a file's ranges across one landing: unchanged lines keep their commit and the lines it added or changed take
 * `commit`. A rewrite too large to diff gives every line to `commit`.
 */
export function shift(ranges: Range[], before: string[], after: string[], commit: number): { ranges: Range[]; added: number } {
  const old = expand(ranges, before.length);
  const commits = new Int32Array(after.length), origins = new Int32Array(after.length);
  // Files that share almost no lines were rewritten; that is cheaper to see than to diff.
  const shared = new Set(before), kept = after.reduce((sum, line) => sum + (shared.has(line) ? 1 : 0), 0);
  const parts = after.length > 1000 && kept * 10 < after.length ? undefined : diffArrays(before, after, { maxEditLength: MAX_EDITS, timeout: 1_000 });
  if (!parts) return { ranges: newRanges(after.length, commit), added: after.length };
  let a = 0, b = 0, added = 0;
  for (const part of parts) {
    const count = part.count;
    if (part.added) { commits.fill(commit, b, b + count); b += count; added += count; }
    else if (part.removed) a += count;
    else { commits.set(old.commits.subarray(a, a + count), b); origins.set(old.origins.subarray(a, a + count), b); a += count; b += count; }
  }
  return { ranges: compress(commits, origins), added };
}

/** Gives each line that predates the map the commit `attribute(origin)` names, from history or GitHub's blame. */
export function resolve(ranges: Range[], lines: number, attribute: (origin: number) => number): Range[] {
  const { commits, origins } = expand(ranges, lines);
  for (let i = 0; i < lines; i++) if (!commits[i]) { commits[i] = attribute(origins[i]); origins[i] = 0; }
  return compress(commits, origins);
}

/** Revisit an old seed at the current head without losing any attribution witnessed by Braid. */
export function reseed(ranges: Range[], lines: number, witnessed: Set<number>): Range[] {
  const { commits, origins } = expand(ranges, lines);
  for (let i = 0; i < lines; i++) if (!witnessed.has(commits[i])) { commits[i] = 0; origins[i] = i + 1; }
  return compress(commits, origins);
}

/** Lines per commit in a map, leaving out lines not attributed yet. */
export function lineCounts(ranges: Range[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [, count, commit] of ranges) if (commit) counts.set(commit, (counts.get(commit) ?? 0) + count);
  return counts;
}
