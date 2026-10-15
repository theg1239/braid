import { diffLines as changedLines } from 'diff';

export type DiffOp = { type: 'equal' | 'add' | 'remove'; text: string; before: number | null; after: number | null };

/** Past this many edited lines, a diff is shown as one replaced block rather than searched for further. */
const MAX_EDITS = 5_000;

/** Line operations between two texts, numbered from 1 on each side, using jsdiff's Myers diff. */
export function diffLines(before: string, after: string): DiffOp[] {
  const parts = changedLines(before, after, { maxEditLength: MAX_EDITS }) ?? [{ value: before, removed: true, added: false }, { value: after, added: true, removed: false }];
  const ops: DiffOp[] = [];
  let a = 1, b = 1;
  for (const part of parts) for (const text of splitLines(part.value)) {
    if (part.added) ops.push({ type: 'add', text, before: null, after: b++ });
    else if (part.removed) ops.push({ type: 'remove', text, before: a++, after: null });
    else ops.push({ type: 'equal', text, before: a++, after: b++ });
  }
  return ops;
}

/** A text's lines as Git counts them: a final newline ends the last line rather than starting another. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Large reviews use a replacement block between shared edges without allocating per-line objects. */
export function textDiffStats(before: string, after: string): { additions: number; deletions: number } {
  const count = (text: string, start = 0, end = text.length) => {
    let lines = 0;
    for (let i = start; i < end; i++) if (text.charCodeAt(i) === 10) lines++;
    return lines + (end > start && text.charCodeAt(end - 1) !== 10 ? 1 : 0);
  };
  if (before === after) return { additions: 0, deletions: 0 };
  if (before.length + after.length < 400_000 && count(before) + count(after) < 10_000) {
    const parts = changedLines(before, after, { maxEditLength: MAX_EDITS });
    if (!parts) return { additions: count(after), deletions: count(before) };
    let additions = 0, deletions = 0;
    for (const part of parts) {
      if (part.added) additions += part.count;
      if (part.removed) deletions += part.count;
    }
    return { additions, deletions };
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  const start = prefix ? before.lastIndexOf('\n', prefix - 1) + 1 : 0;
  let endA = before.length, endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) { endA--; endB--; }
  // Keep a shared partial line inside the replacement block.
  if ((endA > 0 && before[endA - 1] !== '\n') || (endB > 0 && after[endB - 1] !== '\n')) {
    const boundary = before.indexOf('\n', endA);
    const skip = (boundary < 0 ? before.length : boundary + 1) - endA;
    endA += skip; endB += skip;
  }
  return { additions: count(after, start, endB), deletions: count(before, start, endA) };
}
