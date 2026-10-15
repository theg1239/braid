import { useMemo } from 'react';
import { parseDiffFromFile } from '@pierre/diffs';
import type { Change, GuideHunk } from '../../../shared/types';
import { useChangeDiff } from '../../lib/resources';
import { AnchoredHunks, CodeError, DiffView, useDiffStyle } from '../code';
import { contextRowHeight, type DiffReview } from '../code/review-types';
import { hunkRows, viewerHunkIndices } from './guide';
import { CodeSkeletonRows } from '../code/CodeSkeleton';

/**
 * One file of a chapter: only the chapter's hunks, with their real line numbers, through the
 * same viewer as Files changed. The room they will take is kept from the moment the file
 * mounts, so a chapter never grows under the reader as its code arrives.
 */
export function GuideCode({ change, path, hunks, moves, onReady }: { change: Change; path: string; hunks: readonly GuideHunk[] } & Pick<DiffReview, 'moves' | 'onReady'>) {
  const { key, diff, error, retry } = useChangeDiff(change.id, change.revision, path);
  const style = useDiffStyle();
  // The viewer's hunks for the chapter's ranges, and the rows they draw, once the texts are here.
  const selected = useMemo(() => {
    if (!diff || diff.withheld || diff.binary || !hunks.length || diff.before === diff.after) return null;
    const parsed = parseDiffFromFile(diff.before === null ? null : { name: path, contents: diff.before }, diff.after === null ? null : { name: path, contents: diff.after });
    const indices = viewerHunkIndices(parsed.hunks, hunks);
    return { indices, rows: indices.reduce((rows, index) => rows + parsed.hunks[index].unifiedLineCount, 0) };
  }, [diff, hunks, path]);
  const estimate = Math.max(4, Math.min(60, hunkRows(hunks) || 12));
  // Room only ever grows: a chapter may end with some blank, never move what the reader is on.
  const rows = Math.max(estimate, selected?.rows ?? 0);
  const room = 16 + rows * 20 + contextRowHeight(path);
  if (error) return <CodeError result={{ status: 'error', message: error, changed: false }} onRetry={retry} />;
  if (diff?.withheld) return <div className="code code--empty">Content withheld because these changes contain a secret.</div>;
  if (diff?.binary) return <div className="code code--empty">Binary file</div>;
  return (
    <div className="guide__diff">
      <div className="guide__diff-room" aria-hidden="true" style={{ height: room }}>
        <CodeSkeletonRows count={Math.min(30, estimate)} />
      </div>
      <div className="guide__diff-render" aria-busy={!diff || undefined}>
        {!diff ? null : selected ? <AnchoredHunks path={path} before={diff.before} after={diff.after} id={key} style={style} hunks={selected.indices} moves={moves} onReady={onReady} /> : <DiffView path={path} before={diff.before} after={diff.after} id={key} style={style} moves={moves} onReady={onReady} />}
      </div>
    </div>
  );
}
