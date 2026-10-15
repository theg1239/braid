/** Allow unchanged context around edits; whole-file additions and deletions need none. */
export function diffEstimate(file: { additions: number; deletions: number; added?: boolean; deleted?: boolean }, lineHeight: number, wrapped?: { textColumns: number; columns: number }) {
  const changed = file.additions + file.deletions;
  // Pierre/jsdiff keeps four context lines on each side of a hunk. Each
  // changed line could be its own hunk, with a separator before and after.
  const context = file.added || file.deleted || !changed ? 0 : changed * 10 + 2;
  // Word wrapping can leave almost half a row unused. Both full texts bound the
  // wrapped context too, including an unchanged long paragraph beside an edit.
  const wraps = wrapped ? Math.ceil(wrapped.textColumns / Math.max(1, Math.floor(wrapped.columns / 2))) : 0;
  return 16 + Math.max(1, changed + context + wraps) * lineHeight;
}

/** Remove surplus space only if the entire removed area is below the viewport. */
export function retainedDiffHeight(reserved: number, rendered: number, top: number, viewportHeight: number) {
  return top + rendered >= viewportHeight ? rendered : Math.max(reserved, rendered);
}
