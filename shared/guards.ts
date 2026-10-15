import { matchesAny } from './glob';
import { addedLines, secretFindings } from './secrets';
import { AGENTS_PATH, INSTRUCTIONS_PATH } from './policy';
import { plural } from './labels';
import type { Instruction } from './types';

/**
 * Deterministic checks for the ways agents game verification or leak access:
 * deleting or skipping failing tests, downgrading dependencies, and adding
 * credentials, and for strings the repository's instructions block. They
 * flag a change for a person or send it back; they never edit it.
 */
export type GuardKind = 'tests' | 'dependencies' | 'secrets' | 'instructions';
export interface GuardFinding { kind: GuardKind; path: string; detail: string }
export interface GuardFile { path: string; before: string | null; after: string | null }

const TEST_FILES = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/*Test.java', '**/*Tests.cs'];
// Skipped tests still count as test cases here, so skipping one is reported once, as a skip.
const TEST_CASE = /\bx?(?:it|test)(?:\.(?:only|each|concurrent|skip|todo))?\s*\(|^\s*def\s+test_\w*\s*\(|^\s*func\s+Test\w*\s*\(|@Test\b|\[(?:Fact|Test|TestMethod)\]/gm;
const SKIPPED = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip|@Ignore\b|@Disabled\b|\bt\.Skip(?:Now|f)?\s*\(|\[(?:Ignore|Skip)\b/g;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const count = (pattern: RegExp, text: string | null) => text ? (text.match(pattern) ?? []).length : 0;
function version(range: unknown): number[] | null {
  const match = typeof range === 'string' ? range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) : null;
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}
const lower = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

export function guardFindings(files: GuardFile[]): GuardFinding[] {
  const findings: GuardFinding[] = [];
  for (const file of files) {
    const test = matchesAny(file.path, TEST_FILES);
    if (test && file.before !== null && file.after === null) findings.push({ kind: 'tests', path: file.path, detail: `Deletes the test file ${file.path}.` });
    else if (test) {
      const removed = count(TEST_CASE, file.before) - count(TEST_CASE, file.after);
      if (removed > 0) findings.push({ kind: 'tests', path: file.path, detail: `Removes ${plural(removed, 'test case')} from ${file.path}.` });
    }
    const skipped = count(SKIPPED, file.after) - count(SKIPPED, file.before);
    if (skipped > 0) findings.push({ kind: 'tests', path: file.path, detail: `Skips ${plural(skipped, 'more test')} in ${file.path}.` });
    if (/(?:^|\/)package\.json$/.test(file.path) && file.before && file.after) {
      let before: Record<string, Record<string, unknown>>, after: Record<string, Record<string, unknown>>;
      try { before = JSON.parse(file.before); after = JSON.parse(file.after); } catch { continue; }
      for (const section of SECTIONS) for (const [name, range] of Object.entries(before?.[section] ?? {})) {
        const was = version(range), now = version(after?.[section]?.[name]);
        if (was && now && lower(now, was)) findings.push({ kind: 'dependencies', path: file.path, detail: `Downgrades ${name} from ${String(range)} to ${String(after[section][name])}.` });
      }
    }
  }
  for (const secret of secretFindings(files)) findings.push({ kind: 'secrets', path: secret.path, detail: `Adds what looks like a ${secret.label} to ${secret.path} at line ${secret.line}.` });
  return findings.slice(0, 20);
}

/** Findings the instruction check reports at most: one per instruction and file. */
const INSTRUCTION_FINDINGS = 10;
/**
 * Aho–Corasick over UTF-16 code units: the returned scan reports each listed
 * string ending at each position of a text, until `found` returns true. No
 * string is longer than 60 units, so at most 60 end at any one position and a
 * scan takes time linear in the text however many strings there are.
 */
function automaton(strings: string[]) {
  const next: Map<number, number>[] = [new Map()], fail = [0], ends = [-1], link = [0];
  strings.forEach((value, index) => {
    let state = 0;
    for (let i = 0; i < value.length; i++) {
      let target = next[state].get(value.charCodeAt(i));
      if (target === undefined) {
        target = next.push(new Map()) - 1;
        next[state].set(value.charCodeAt(i), target);
        fail.push(0); ends.push(-1); link.push(0);
      }
      state = target;
    }
    ends[state] = index;
  });
  // Breadth first, each state fails over to its longest proper suffix that is also a prefix, and links to the nearest such suffix that ends a string.
  const queue = [...next[0].values()];
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    for (const [unit, child] of next[state]) {
      let suffix = fail[state];
      while (suffix && !next[suffix].has(unit)) suffix = fail[suffix];
      fail[child] = next[suffix].get(unit) ?? 0;
      link[child] = ends[fail[child]] >= 0 ? fail[child] : link[fail[child]];
      queue.push(child);
    }
  }
  return (text: string, found: (index: number) => boolean) => {
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      while (state && !next[state].has(unit)) state = fail[state];
      state = next[state].get(unit) ?? 0;
      for (let match = ends[state] >= 0 ? state : link[state]; match; match = link[match]) if (found(ends[match])) return;
    }
  };
}
const quoted = (text: string) => { const plain = text.replace(/[.!?]+$/, ''); return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain; };

/**
 * Lines a change adds that contain a string an instruction blocks, in the
 * files the instruction covers: one finding per instruction and file, ten at
 * most. Every blocked string is matched in one pass over each added line, and
 * the files that state the instructions are left alone.
 */
export function instructionFindings(files: GuardFile[], instructions: Instruction[]): GuardFinding[] {
  const blocking = instructions.filter((instruction): instruction is Instruction & { block: string[] } => !!instruction.block);
  const strings = [...new Set(blocking.flatMap(instruction => instruction.block))];
  const owners = strings.map(value => blocking.filter(instruction => instruction.block.includes(value)));
  const findings: GuardFinding[] = [];
  if (!strings.length) return findings;
  const scan = automaton(strings);
  for (const file of files) {
    if (file.after === null || file.path === INSTRUCTIONS_PATH || file.path === AGENTS_PATH) continue;
    const pending = new Set(blocking.filter(instruction => !instruction.paths || matchesAny(file.path, instruction.paths)));
    for (const { line, text } of pending.size ? addedLines(file.before, file.after) : []) {
      scan(text, index => {
        for (const instruction of owners[index]) if (pending.delete(instruction))
          findings.push({ kind: 'instructions', path: file.path, detail: `Adds "${strings[index]}" to ${file.path} at line ${line}, against "${quoted(instruction.text)}".` });
        return !pending.size || findings.length >= INSTRUCTION_FINDINGS;
      });
      if (!pending.size || findings.length >= INSTRUCTION_FINDINGS) break;
    }
    if (findings.length >= INSTRUCTION_FINDINGS) break;
  }
  return findings.slice(0, INSTRUCTION_FINDINGS);
}
