import { describe, expect, it } from 'vitest';
import { diffLines, splitLines, textDiffStats } from './diff';
import { unifiedDiff } from '../worker/changes/review';

const lines = (count: number, change = -1) => Array.from({ length: count }, (_, i) => i === change ? 'changed' : `line ${i}`).join('\n') + '\n';

describe('line diffs', () => {
  it('counts lines as Git does', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('finds one changed line in the middle of a large file', () => {
    const before = lines(3_000), after = lines(3_000, 1_500);
    const ops = diffLines(before, after).filter(op => op.type !== 'equal');
    expect(ops).toEqual([{ type: 'remove', text: 'line 1500', before: 1501, after: null }, { type: 'add', text: 'changed', before: null, after: 1501 }]);
    expect(textDiffStats(before, after)).toEqual({ additions: 1, deletions: 1 });
  });

  it('gives a reviewer unified hunks with three lines of context', () => {
    const diff = unifiedDiff({ path: 'src/a.ts', before: lines(20), after: lines(20, 10) });
    expect(diff).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,7 +8,7 @@\n line 7\n line 8\n line 9\n-line 10\n+changed\n line 11\n line 12\n line 13\n');
    expect(unifiedDiff({ path: 'new.ts', before: '', after: 'a\n', added: true })).toBe('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+a\n');
  });
});
