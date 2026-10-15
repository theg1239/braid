/**
 * Line matching for merges. Lines keep their terminators, so a missing final
 * newline or a CRLF change is an ordinary line difference rather than a
 * formatting detail that a merge could silently drop.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) { lines.push(text.slice(start, i + 1)); start = i + 1; }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Unbounded inputs must not stall a Worker: past this budget a range is treated as entirely changed. */
const DEFAULT_BUDGET = 25_000_000;

interface Context { a: Int32Array; b: Int32Array; match: Int32Array; work: number; budget: number; vf?: Int32Array; vb?: Int32Array }

function intern(sequences: readonly (readonly string[])[]): Int32Array[] {
  const ids = new Map<string, number>();
  return sequences.map(lines => Int32Array.from(lines, line => {
    let id = ids.get(line);
    if (id === undefined) { id = ids.size; ids.set(line, id); }
    return id;
  }));
}

/**
 * Maps each line of `a` to its matched line in `b`, or -1. Matches are strictly
 * increasing. Patience anchoring on lines unique to both sides keeps code
 * aligned on declarations instead of braces and blank lines; ranges without
 * unique anchors use Myers' linear-space O(ND) algorithm.
 */
export function matchLines(a: readonly string[], b: readonly string[], options: { budget?: number; algorithm?: 'patience' | 'myers' } = {}): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0, endA = a.length, endB = b.length;
  // Most blame comparisons and rebases touch a small range. Shared edges need no string table or edit search.
  while (start < endA && start < endB && a[start] === b[start]) { match[start] = start; start++; }
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) match[--endA] = --endB;
  if (start === endA || start === endB) return match;
  const [ia, ib] = intern([a.slice(start, endA), b.slice(start, endB)]);
  const context: Context = { a: ia, b: ib, match: new Int32Array(ia.length).fill(-1), work: 0, budget: options.budget ?? DEFAULT_BUDGET };
  if (options.algorithm === 'myers') myers(context, 0, ia.length, 0, ib.length);
  else patience(context, 0, ia.length, 0, ib.length, 0);
  for (let i = 0; i < context.match.length; i++) if (context.match[i] >= 0) match[start + i] = start + context.match[i];
  return match;
}

function patience(context: Context, aLo: number, aHi: number, bLo: number, bHi: number, depth: number) {
  const { a, b, match } = context;
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) match[aLo++] = bLo++;
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) match[--aHi] = --bHi;
  if (aLo === aHi || bLo === bHi) return;
  if (depth > 48) { myers(context, aLo, aHi, bLo, bHi); return; }
  const counts = new Map<number, { a: number; ac: number; b: number; bc: number }>();
  for (let i = aLo; i < aHi; i++) {
    const entry = counts.get(a[i]);
    if (entry) entry.ac++; else counts.set(a[i], { a: i, ac: 1, b: -1, bc: 0 });
  }
  let shared = false;
  for (let j = bLo; j < bHi; j++) {
    const entry = counts.get(b[j]);
    if (entry) { entry.bc++; entry.b = j; shared = true; }
  }
  // No edit-path search can match anything in disjoint alphabets.
  if (!shared) return;
  const pairs: [number, number][] = [];
  for (let i = aLo; i < aHi; i++) {
    const entry = counts.get(a[i])!;
    if (entry.ac === 1 && entry.bc === 1) pairs.push([i, entry.b]);
  }
  context.work += aHi - aLo + bHi - bLo;
  const anchors = increasing(pairs);
  if (!anchors.length) { myers(context, aLo, aHi, bLo, bHi); return; }
  let pa = aLo, pb = bLo;
  for (const [i, j] of anchors) {
    patience(context, pa, i, pb, j, depth + 1);
    match[i] = j; pa = i + 1; pb = j + 1;
  }
  patience(context, pa, aHi, pb, bHi, depth + 1);
}

/** Longest subsequence with increasing second coordinate (pairs arrive sorted by the first). */
function increasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [], previous = new Int32Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    const value = pairs[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < value) lo = mid + 1; else hi = mid; }
    previous[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const result: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) result.push(pairs[k]);
  return result.reverse();
}

function myers(context: Context, aLo: number, aHi: number, bLo: number, bHi: number) {
  const { a, b, match } = context;
  const stack: number[][] = [[aLo, aHi, bLo, bHi]];
  while (stack.length) {
    let [x0, x1, y0, y1] = stack.pop()!;
    while (x0 < x1 && y0 < y1 && a[x0] === b[y0]) match[x0++] = y0++;
    while (x0 < x1 && y0 < y1 && a[x1 - 1] === b[y1 - 1]) match[--x1] = --y1;
    if (x0 === x1 || y0 === y1) continue;
    const snake = middleSnake(context, x0, x1, y0, y1);
    // Past the budget the range stays unmatched, which a merge reports as a conflict rather than guessing.
    if (!snake) continue;
    const [sx, sy, ex, ey] = snake;
    for (let x = sx, y = sy; x < ex; x++, y++) match[x] = y;
    stack.push([ex, x1, ey, y1], [x0, sx, y0, sy]);
  }
}

/** Myers (1986) bidirectional search; returns the middle snake of an optimal edit path. */
function middleSnake(context: Context, x0: number, x1: number, y0: number, y1: number): [number, number, number, number] | null {
  const { a, b } = context;
  const n = x1 - x0, m = y1 - y0, delta = n - m, odd = (delta & 1) !== 0;
  const max = Math.ceil((n + m) / 2), offset = max + 1, size = 2 * max + 3;
  if (!context.vf || context.vf.length < size) { context.vf = new Int32Array(size); context.vb = new Int32Array(size); }
  const vf = context.vf, vb = context.vb!;
  vf[offset + 1] = 0; vb[offset + 1] = 0;
  for (let d = 0; d <= max; d++) {
    context.work += 2 * d + 2;
    if (context.work > context.budget) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1]) ? vf[offset + k + 1] : vf[offset + k - 1] + 1;
      let y = x - k;
      const sx = x, sy = y;
      while (x < n && y < m && a[x0 + x] === b[y0 + y]) { x++; y++; }
      vf[offset + k] = x;
      if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && x + vb[offset + delta - k] >= n)
        return [x0 + sx, y0 + sy, x0 + x, y0 + y];
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vb[offset + k - 1] < vb[offset + k + 1]) ? vb[offset + k + 1] : vb[offset + k - 1] + 1;
      let y = x - k;
      const sx = x, sy = y;
      while (x < n && y < m && a[x1 - 1 - x] === b[y1 - 1 - y]) { x++; y++; }
      vb[offset + k] = x;
      if (!odd && k >= delta - d && k <= delta + d && x + vf[offset + delta - k] >= n)
        return [x0 + n - x, y0 + m - y, x0 + n - sx, y0 + m - sy];
    }
  }
  return null;
}
