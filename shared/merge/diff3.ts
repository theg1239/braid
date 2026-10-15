import { matchLines, splitLines } from './lines';

export interface ConflictRegion {
  /** Zero-based line offsets of each side's region in its own file. */
  baseStart: number; oursStart: number; theirsStart: number;
  base: string[]; ours: string[]; theirs: string[];
}
type MergeRegion =
  | { kind: 'clean'; lines: string[]; source: 'base' | 'ours' | 'theirs' | 'both' | 'union' }
  | { kind: 'conflict'; conflict: ConflictRegion };
interface TextMergeResult {
  clean: boolean;
  /** How the remaining overlaps were settled; 'conflict' means at least one region needs a decision. */
  strategy: 'clean' | 'union' | 'conflict';
  regions: MergeRegion[];
  conflicts: ConflictRegion[];
}
interface TextMergeOptions {
  /** Combine overlapping pure insertions, ours first. Overlapping edits to existing lines still conflict. */
  union?: boolean;
  /**
   * Union is also applied when both insertions are whole list entries at one
   * indentation, such as registry, route table, enum, array or Markdown list
   * items. This is the most common way concurrent agents collide.
   */
  unionEntries?: boolean;
}

type Chunk = { stable: true; o: number; a: number; b: number; length: number }
  | { stable: false; o: [number, number]; a: [number, number]; b: [number, number] };

/**
 * diff3 chunking (Khanna, Kunal & Pierce, "A Formal Investigation of Diff3"):
 * stable chunks are lines every side keeps in alignment; between them, each
 * unstable chunk is resolved when at most one side differs from the base.
 */
function chunks(base: string[], ours: string[], theirs: string[], algorithm: 'patience' | 'myers'): Chunk[] {
  const ma = matchLines(base, ours, { algorithm }), mb = matchLines(base, theirs, { algorithm });
  const result: Chunk[] = [];
  let o = 0, a = 0, b = 0;
  for (;;) {
    let length = 0;
    while (o + length < base.length && ma[o + length] === a + length && mb[o + length] === b + length) length++;
    if (length) { result.push({ stable: true, o, a, b, length }); o += length; a += length; b += length; continue; }
    let j = o;
    while (j < base.length && (ma[j] < 0 || mb[j] < 0)) j++;
    if (j === base.length) {
      if (o < base.length || a < ours.length || b < theirs.length) result.push({ stable: false, o: [o, base.length], a: [a, ours.length], b: [b, theirs.length] });
      return result;
    }
    result.push({ stable: false, o: [o, j], a: [a, ma[j]], b: [b, mb[j]] });
    o = j; a = ma[j]; b = mb[j];
  }
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, i) => line === y[i]);
/** Only complete, simple declarations whose local bindings can be checked. */
function importBindings(line: string): string[] | null {
  const named = line.match(/^import\s+(?:type\s+)?\{([^{}]+)\}\s+from\s+(['"])[^'"\r\n]+\2;?$/);
  if (named) {
    const parts = named[1].split(',').map(part => part.trim()).filter(Boolean);
    const bindings = parts.map(part => part.match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/));
    return parts.length && bindings.every(Boolean) ? bindings.map(part => part![2] ?? part![1]) : null;
  }
  const single = line.match(/^import\s+(?:type\s+)?(?:\*\s+as\s+)?([\w$]+)\s+from\s+(['"])[^'"\r\n]+\2;?$/)
    ?? line.match(/^(?:const|let|var)\s+([\w$]+)\s*=\s*require\((['"])[^'"\r\n]+\2\);?$/);
  if (single) return [single[1]];
  const python = line.match(/^(?:from\s+[\w.]+\s+)?import\s+([\w.]+)(?:\s+as\s+(\w+))?$/);
  if (python) return [python[2] ?? python[1].split('.')[0]];
  const rust = line.match(/^use\s+([\w:]+)(?:\s+as\s+(\w+))?;$/);
  return rust ? [rust[2] ?? rust[1].split('::').at(-1)!] : null;
}
function importsOnly(ours: string[], theirs: string[]) {
  const bindings = new Map<string, string>();
  for (const line of [...ours, ...theirs]) {
    const declaration = line.trim();
    if (!declaration) continue;
    const names = importBindings(declaration);
    if (!names) return false;
    for (const name of names) {
      if (bindings.has(name) && bindings.get(name) !== declaration) return false;
      bindings.set(name, declaration);
    }
  }
  return bindings.size > 0;
}
const QUOTED = String.raw`(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')`;
const ATOM = String.raw`(?:${QUOTED}|[\w$]+|-?\d+(?:\.\d+)?)`;
const ENTRY = new RegExp(String.raw`^(\s*)(?:(?:[-*+]|\d+[.)])\s+\S.*|(?:(?:${QUOTED}|[\w$]+)\s*:\s*)?${ATOM},)\s*$`);
const MEMBER = new RegExp(String.raw`^(${QUOTED}|[\w$]+)\s*:`);
/** Single-line entries sharing one indentation; a lone brace or a statement block never qualifies. */
function entriesOnly(ours: string[], theirs: string[]) {
  let indent: string | undefined;
  const members = new Map<string, string>();
  for (const line of [...ours, ...theirs]) {
    const match = ENTRY.exec(line.replace(/\r?\n$/, ''));
    if (!match) return false;
    if (indent === undefined) indent = match[1];
    else if (indent !== match[1]) return false;
    // Two new object members with one name are competing assignments, even
    // when each occupies a whole comma-terminated line.
    const member = MEMBER.exec(line.trim());
    if (member) {
      const key = /^['"]/.test(member[1]) ? member[1].slice(1, -1) : member[1];
      if (key.includes('\\')) return false;
      if (members.has(key) && members.get(key) !== line) return false;
      members.set(key, line);
    }
  }
  return indent !== undefined;
}

/**
 * Ours first, then theirs. When every inserted line is a standalone unit (an
 * import or a list entry), a line both sides added appears once: two agents
 * importing the same module must not produce a duplicate declaration.
 */
function union(ours: string[], theirs: string[], standalone: boolean, newline: string): string[] {
  const left = [...ours];
  // An insertion at end-of-file may lack its final newline; keep the lines separate.
  if (left.length && !left[left.length - 1].endsWith('\n')) left[left.length - 1] += newline;
  if (!standalone) return [...left, ...theirs];
  const key = (line: string) => line.replace(/\r?\n$/, '').trimEnd();
  const seen = new Map<string, number>();
  for (const line of left) if (key(line)) seen.set(key(line), (seen.get(key(line)) ?? 0) + 1);
  return [...left, ...theirs.filter(line => {
    const count = seen.get(key(line)) ?? 0;
    if (count) seen.set(key(line), count - 1);
    return !count;
  })];
}

/** Three-way line merge of `ours` and `theirs` relative to `base`. */
export function mergeText(base: string, ours: string, theirs: string, options: TextMergeOptions = {}): TextMergeResult {
  if (ours === theirs) return { clean: true, strategy: 'clean', regions: [{ kind: 'clean', lines: splitLines(ours), source: 'both' }], conflicts: [] };
  if (base === ours) return { clean: true, strategy: 'clean', regions: [{ kind: 'clean', lines: splitLines(theirs), source: 'theirs' }], conflicts: [] };
  if (base === theirs) return { clean: true, strategy: 'clean', regions: [{ kind: 'clean', lines: splitLines(ours), source: 'ours' }], conflicts: [] };
  const o = splitLines(base), a = splitLines(ours), b = splitLines(theirs);
  const result = aligned(o, a, b, options, 'patience');
  if (!result.clean) return result;
  // Repeated blank lines/braces can align inside an inserted block on one
  // side and outside it on the other, silently duplicating that block. A
  // clean merge must agree under both alignments; ambiguity needs a decision.
  const alternate = aligned(o, a, b, options, 'myers');
  if (!alternate.clean) return alternate;
  if (mergedText(result) === mergedText(alternate)) return result;
  const conflict = { baseStart: 0, oursStart: 0, theirsStart: 0, base: o, ours: a, theirs: b };
  return { clean: false, strategy: 'conflict', regions: [{ kind: 'conflict', conflict }], conflicts: [conflict] };
}

function aligned(o: string[], a: string[], b: string[], options: TextMergeOptions, algorithm: 'patience' | 'myers'): TextMergeResult {
  const regions: MergeRegion[] = [], conflicts: ConflictRegion[] = [];
  const terminated = a.find(line => line.endsWith('\n')) ?? o.find(line => line.endsWith('\n')) ?? b.find(line => line.endsWith('\n'));
  const newline = terminated?.endsWith('\r\n') ? '\r\n' : '\n';
  let unioned = false;
  for (const chunk of chunks(o, a, b, algorithm)) {
    if (chunk.stable) { regions.push({ kind: 'clean', lines: o.slice(chunk.o, chunk.o + chunk.length), source: 'base' }); continue; }
    const baseLines = o.slice(...chunk.o), oursLines = a.slice(...chunk.a), theirsLines = b.slice(...chunk.b);
    if (same(oursLines, baseLines)) regions.push({ kind: 'clean', lines: theirsLines, source: 'theirs' });
    else if (same(theirsLines, baseLines)) regions.push({ kind: 'clean', lines: oursLines, source: 'ours' });
    else if (same(oursLines, theirsLines)) regions.push({ kind: 'clean', lines: oursLines, source: 'both' });
    else if (!baseLines.length && (options.union || (options.unionEntries !== false && entriesOnly(oursLines, theirsLines)))) {
      const standalone = importsOnly(oursLines, theirsLines) || entriesOnly(oursLines, theirsLines);
      regions.push({ kind: 'clean', lines: union(oursLines, theirsLines, standalone, newline), source: 'union' });
      unioned = true;
    } else {
      const conflict = { baseStart: chunk.o[0], oursStart: chunk.a[0], theirsStart: chunk.b[0], base: baseLines, ours: oursLines, theirs: theirsLines };
      regions.push({ kind: 'conflict', conflict });
      conflicts.push(conflict);
    }
  }
  return { clean: !conflicts.length, strategy: conflicts.length ? 'conflict' : unioned ? 'union' : 'clean', regions, conflicts };
}

/** The merged file. Throws for an unresolved merge so conflict markers can never be published by accident. */
export function mergedText(result: TextMergeResult): string {
  if (!result.clean) throw new Error('The merge has unresolved conflicts.');
  return result.regions.map(region => region.kind === 'clean' ? region.lines.join('') : '').join('');
}
