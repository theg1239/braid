import type { FileDiffMetadata } from '@pierre/diffs';

/** Selects original zero-based hunks for Guide; full source line numbers and comment anchors survive. */
export function selectHunks(diff: FileDiffMetadata, indices?: readonly number[]): FileDiffMetadata {
  if (!indices) return diff;
  const chosen = new Set(indices);
  const cacheKey = `${diff.cacheKey}:hunks:${[...chosen].join(',')}`;
  if (diff.hunks.every((_, index) => chosen.has(index))) return { ...diff, isPartial: false, cacheKey };
  let unified = 0, split = 0;
  const deletionLines: string[] = [], additionLines: string[] = [];
  const hunks = diff.hunks.flatMap((hunk, index) => {
    if (!chosen.has(index)) return [];
    // A subset is a projection: compact source indices, original display numbers, no omitted
    // changes masquerading as expandable context. The original complete texts still anchor it.
    const deletionOffset = deletionLines.length - hunk.deletionLineIndex;
    const additionOffset = additionLines.length - hunk.additionLineIndex;
    const selected = { ...hunk, deletionLineIndex: deletionLines.length, additionLineIndex: additionLines.length,
      hunkContent: hunk.hunkContent.map(part => ({ ...part, deletionLineIndex: part.deletionLineIndex + deletionOffset, additionLineIndex: part.additionLineIndex + additionOffset })),
      unifiedLineStart: unified, splitLineStart: split, collapsedBefore: 0 };
    deletionLines.push(...diff.deletionLines.slice(hunk.deletionLineIndex, hunk.deletionLineIndex + hunk.deletionCount));
    additionLines.push(...diff.additionLines.slice(hunk.additionLineIndex, hunk.additionLineIndex + hunk.additionCount));
    unified += hunk.unifiedLineCount;
    split += hunk.splitLineCount;
    return [selected];
  });
  return { ...diff, hunks, deletionLines, additionLines, isPartial: false, unifiedLineCount: unified, splitLineCount: split, cacheKey };
}
