import type { Change } from '../../../shared/types';
import { lazyComponent } from '../../lib/lazy';
import { prefetchDiff } from '../../lib/resources';
import { routeOf } from '../../lib/router';
import { FilesSkeleton, GuideSkeleton } from '../ui/ScreenSkeleton';
import { prefetchCode } from '../code/viewer';

export const filesTab = lazyComponent(() => {
  prefetchCode();
  // Both chunks arrive together. The viewer handles settle before Files first renders a diff.
  return Promise.all([import('./Files'), import('../code/pierre')]).then(([module]) => module);
}, (module) => module.FilesChanged, FilesSkeleton);

/** The Guide tab, with the viewer it draws chapters through. */
export const guideTab = lazyComponent(() => {
  prefetchCode();
  return Promise.all([import('./GuideTab'), import('../code/pierre')]).then(([module]) => module);
}, (module) => module.Guide, GuideSkeleton);

// Modulepreload fetched the entry tab's bytes; evaluate them before React tries to show it.
const entry = typeof window === 'undefined' ? null : routeOf(window.location.pathname);
if (entry?.screen === 'pull' && entry.sub === 'files') void filesTab.prefetch();
if (entry?.screen === 'pull' && entry.sub === 'guide') void guideTab.prefetch();

/** Warm the file the tab opens on, using the same path order as its list. */
export function prefetchFirstDiff(change: Change, focus: string | null = null) {
  const first = change.files.find((file) => file.path === focus)
    ?? change.files.reduce<Change['files'][number] | undefined>((first, file) => !first || file.path < first.path ? file : first, undefined);
  if (first) prefetchDiff(change.id, change.revision, first.path);
}
