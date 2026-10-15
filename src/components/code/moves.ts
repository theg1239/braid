import { diffLines } from 'diff';

export interface MoveFile { path: string; before: string | null; after: string | null }
export interface MoveEnd { path: string; line: number; side: 'additions' | 'deletions' }
export interface MovedBlock { from: MoveEnd; to: MoveEnd; count: number }
interface Run { path: string; line: number; side: MoveEnd['side']; lines: string[]; unchanged: number }
interface Seed { run: Run; start: number; end: number }
const MOVE_LIMITS = { files: 80, characters: 2_000_000, lines: 40_000, matches: 200, comparisons: 200_000 } as const;

// Ignore indentation and trailing space only: whitespace inside a string remains significant.
const normalize = (line: string) => line.trim();
const common = new Set(['return', 'true', 'false', 'null', 'undefined', 'None', 'nil', 'self', 'this', 'break', 'continue', 'pass', 'else', 'try', 'finally']);
export function nonTrivialLine(line: string): boolean {
  if (line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')) return false;
  const words = line.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [];
  const meaningful = words.filter(word => !common.has(word));
  return new Set(meaningful).size >= 2 && meaningful.join('').length >= 12;
}

/** Exact, unique runs of at least four substantive lines; bounded even for unrelated whole-file rewrites. */
export function detectMoves(files: readonly MoveFile[]): MovedBlock[] {
  const deleted = new Map<string, Seed | null>(), added = new Map<string, Seed | null>();
  let characters = 0, lineCount = 0;
  for (const file of files.slice(0, MOVE_LIMITS.files)) {
    characters += (file.before?.length ?? 0) + (file.after?.length ?? 0);
    if (characters > MOVE_LIMITS.characters) break;
    const parts = diffLines(file.before ?? '', file.after ?? '', { maxEditLength: 4_000, timeout: 30 });
    if (!parts) continue;
    let oldLine = 1, newLine = 1, unchanged = 0;
    for (const part of parts) {
      const lines = part.value.split('\n');
      if (lines.at(-1) === '') lines.pop();
      lineCount += lines.length;
      if (lineCount > MOVE_LIMITS.lines) break;
      if (part.added || part.removed) {
        const run: Run = { path: file.path, line: part.added ? newLine : oldLine, side: part.added ? 'additions' : 'deletions', lines: lines.map(normalize), unchanged };
        const substantive = run.lines.flatMap((line, index) => nonTrivialLine(line) ? [index] : []);
        const map = part.added ? added : deleted;
        for (let i = 0; i + 3 < substantive.length; i++) {
          const start = substantive[i], end = substantive[i + 3];
          if (end - start > 40) continue;
          const seedLines = substantive.slice(i, i + 4).map(index => run.lines[index]);
          if (new Set(seedLines).size < 4) continue;
          const key = run.lines.slice(start, end + 1).join('\n');
          map.set(key, map.has(key) ? null : { run, start, end });
        }
      }
      if (!part.added) oldLine += lines.length;
      if (!part.removed) newLine += lines.length;
      if (!part.added && !part.removed) unchanged += lines.length;
    }
    if (lineCount > MOVE_LIMITS.lines) break;
  }
  const moves: MovedBlock[] = [], used = new Map<Run, Set<number>>();
  let comparisons = 0;
  for (const [key, source] of deleted) {
    const target = added.get(key);
    if (!source || !target) continue;
    if (source.run.path === target.run.path && Math.abs(source.run.unchanged - target.run.unchanged) < 20) continue;
    if (used.get(source.run)?.has(source.start) || used.get(target.run)?.has(target.start)) continue;
    let left = 0, right = source.end - source.start + 1;
    while (source.start - left > 0 && target.start - left > 0 && ++comparisons < MOVE_LIMITS.comparisons && source.run.lines[source.start - left - 1] === target.run.lines[target.start - left - 1]) left++;
    while (source.start + right < source.run.lines.length && target.start + right < target.run.lines.length && ++comparisons < MOVE_LIMITS.comparisons && source.run.lines[source.start + right] === target.run.lines[target.start + right]) right++;
    const startA = source.start - left, startB = target.start - left, count = right + left;
    if (Array.from({ length: count }, (_, i) => used.get(source.run)?.has(startA + i) || used.get(target.run)?.has(startB + i)).some(Boolean)) continue;
    for (const [seed, start] of [[source, startA], [target, startB]] as const) {
      const taken = used.get(seed.run) ?? new Set<number>();
      for (let i = 0; i < count; i++) taken.add(start + i);
      used.set(seed.run, taken);
    }
    moves.push({ from: { path: source.run.path, line: source.run.line + startA, side: 'deletions' }, to: { path: target.run.path, line: target.run.line + startB, side: 'additions' }, count });
    if (moves.length >= MOVE_LIMITS.matches || comparisons >= MOVE_LIMITS.comparisons) break;
  }
  return moves;
}
