import { mergeText, mergedText, type ConflictRegion } from './diff3';
import { mergeJson } from './json';
import { matchesAny } from '../glob';

export type { ConflictRegion } from './diff3';

/** Settled without a person: how each automatically merged file was combined. */
export type MergeStrategy = 'fast-forward' | 'line' | 'union' | 'json';
export interface MergeRules {
  /** Explicitly append-only paths whose overlapping pure insertions may be combined. */
  union?: string[];
  /** Disable structural JSON merging. */
  json?: boolean;
}

type FileMerge =
  | { clean: true; text: string; strategy: MergeStrategy }
  | { clean: false; conflicts: ConflictRegion[]; jsonPaths?: string[] };

/**
 * Applies `theirs` (a change made against `base`) on top of `ours` (current
 * trunk). Line merging runs first; overlaps fall back to structural JSON and
 * then to union for append-only paths. Anything else is a conflict to resolve.
 */
export function mergeFile(path: string, base: string, ours: string, theirs: string, rules: MergeRules = {}): FileMerge {
  if (ours === base) return { clean: true, text: theirs, strategy: 'fast-forward' };
  if (theirs === base || ours === theirs) return { clean: true, text: ours, strategy: 'fast-forward' };
  const isJson = /\.json$/i.test(path);
  // A comma-terminated JSON member is not an independent list entry: two
  // additions can set the same key differently. Let the structural merge decide.
  const line = mergeText(base, ours, theirs, isJson ? { unionEntries: false } : {});
  if (line.clean) return { clean: true, text: mergedText(line), strategy: line.strategy === 'union' ? 'union' : 'line' };
  if (isJson) {
    const json = rules.json === false ? null : mergeJson(base, ours, theirs);
    if (json && json.text !== null) return { clean: true, text: json.text, strategy: 'json' };
    return { clean: false, conflicts: line.conflicts, ...(json ? { jsonPaths: json.conflicts } : {}) };
  }
  // A Markdown/test filename does not prove that arbitrary inserted code or
  // prose is append-only. Whole entries still merge; broader union is opt-in.
  if (matchesAny(path, rules.union)) {
    const unioned = mergeText(base, ours, theirs, { union: true });
    if (unioned.clean) return { clean: true, text: mergedText(unioned), strategy: 'union' };
    return { clean: false, conflicts: unioned.conflicts };
  }
  return { clean: false, conflicts: line.conflicts };
}
