import { LoadingRegion, SkeletonLine } from '../ui/Skeleton';

export const codePlaceholderHeight = (lines: number) => Math.min(30, Math.max(6, lines)) * 20 + 16;

/** Placeholder lines of code: a line number and a line of deterministic width each. */
export function CodeSkeletonRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => <div key={index} className="code-skeleton__row" aria-hidden="true"><span /><SkeletonLine width={`${24 + index * 17 % 55}%`} /></div>);
}

/** Reserve the visible code's height through both the network read and worker highlighting. */
export function CodeSkeleton({ lines = 12, label = 'Loading code' }: { lines?: number; label?: string }) {
  return <LoadingRegion className="code-skeleton" label={label}>
    <CodeSkeletonRows count={Math.min(30, Math.max(6, lines))} />
  </LoadingRegion>;
}

/** Blame keeps attribution beside the source while the provenance read is pending. */
export function BlameSkeleton({ lines = 12 }: { lines?: number }) {
  return <LoadingRegion className="blame-skeleton" label="Loading blame"><div className="blame__sum"><SkeletonLine width="40%" /><SkeletonLine width="80%" /><SkeletonLine width="55%" /></div><div className="loading-blame"><CodeSkeleton label="Loading attribution" lines={lines} /><CodeSkeleton label="Loading source" lines={lines} /></div></LoadingRegion>;
}
