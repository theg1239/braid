import { prefetchCode, prefetchMarkdown } from './components/code/viewer';
import { changes } from './lib/api';
import { FILTER_STATUSES, listInterval } from './lib/lists';
import { primeLive } from './lib/live';
import { isExample, routeOf } from './lib/router';

/** Run after warmStart establishes the workspace, before the account gate can delay the first screen. */
export function warmEntry() {
  const route = routeOf(window.location.pathname + window.location.search);
  if ((route.screen === 'code' && route.path && route.view !== 'tree' && route.view !== 'blame') || (route.screen === 'pull' && route.sub === 'files')) {
    // Modulepreload fetches the bytes; warming these handles also avoids a first-render Suspense delay.
    prefetchCode();
    if (route.path && /\.(?:md|markdown|mdown)$/i.test(route.path)) prefetchMarkdown();
  }
  // The example's scope is known synchronously. Other repository addresses still need their access lookup.
  // Anonymous viewers read Open (or explicit Closed), rather than the member-only attention list.
  if (route.screen === 'pulls' && route.repo && isExample(route.repo) && !route.query.has('agent')) {
    const filter = route.query.get('state') === 'closed' ? 'closed' : 'open';
    primeLive(`changes:list:${filter}`, () => changes.list({ status: FILTER_STATUSES[filter].join(','), limit: 25 }), listInterval);
  }
}
