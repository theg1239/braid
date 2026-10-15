import { primeAccount } from '../account/read';
import { primeAddress } from '../account/addresses';
import { DEMO_SCOPE, readAccountsHint, readSession } from '../account/session';
import { prefetchCode, prefetchMarkdown } from '../components/code/viewer';
import { prefetchLanding, prefetchScreen } from '../screens';
import { api, changes, peekState, primeState, primeWorkspaceScope, setWorkspaceScope } from './api';
import { changeInterval, listInterval, queueInterval } from './lists';
import { primeLive } from './live';
import { primeBlame, primeFile, primeHead, primeTree } from './reads';
import { ATTENTION_KEY, LATEST_KEY, QUEUE_LIST_KEY, attentionList, latestList, queueList } from './needs';
import { addressPath, isAppPath, isExample, isRepositoryScreen, routeOf, setRouteBase, type Route } from './router';

/*
 * Nothing waits on something else when it does not have to. The first paint needs the
 * account, the snapshot and the current screen's own data, so all three start together with
 * the shell's JavaScript; a link starts its screen's chunk and data the moment a pointer
 * reaches it; and after the first paint the repository tabs arrive in idle time.
 */

/** Starts the requests the current screen will make, so they are in flight before it mounts. */
function primeRoute(route: Route) {
  prefetchScreen(route.screen);
  primeRouteData(route);
  // These reads belong to the link under the pointer, never the idle page-load work.
  const project = peekState()?.project;
  switch (route.screen) {
    case 'code': {
      if (!project) break;
      const ref = route.ref && route.ref !== project.branch ? route.ref : project.head;
      if (!ref) break;
      const parents = route.path ? route.path.split('/').map((_, index, parts) => parts.slice(0, index).join('/')) : [''];
      for (const path of parents) primeTree(path, ref);
      if (route.view === 'tree') primeTree(route.path, ref);
      else if (route.path) {
        primeFile(route.path, ref);
        if (route.view === 'blame') primeBlame(route.path, ref);
        prefetchCode();
      } else prefetchMarkdown();
      break;
    }
    case 'branches':
      primeLive('repository:branches', api.branches, 30_000);
      break;
    case 'commits': {
      const ref = route.ref ?? project?.branch;
      if (!ref) break;
      const cursor = route.query.getAll('cursor').at(-1) ?? null;
      primeLive(`commits:${JSON.stringify([ref, route.path, cursor])}`, () => api.commits(ref, route.path, cursor), 60_000);
      break;
    }
    case 'commit':
      if (route.id) primeLive(`commit:${route.id}`, () => api.commit(route.id!), 300_000);
      prefetchCode();
      break;
    case 'compare': {
      const [base, head] = route.id?.split('...') ?? [];
      if (base && head) primeLive(`repository:compare:${JSON.stringify([base, head])}`, () => api.compare(base, head), 60_000);
      prefetchCode();
      break;
    }
  }
}

function primeRouteData(route: Route) {
  switch (route.screen) {
    case 'code':
      primeLive(ATTENTION_KEY, attentionList, listInterval);
      primeLive(LATEST_KEY, latestList, listInterval);
      break;
    case 'pulls':
      primeLive(ATTENTION_KEY, attentionList, listInterval);
      primeLive('queue', changes.queue, queueInterval);
      break;
    case 'pull': {
      const reference = route.id!;
      primeLive(`changes:item:${reference}`, () => route.sub === 'files' && !route.query.has('since')
        ? import('./resources').then(({ readFilesPull }) => readFilesPull(reference, route.query.get('file')))
        : changes.get(reference), changeInterval);
      primeLive('policy', changes.policy, 60_000);
      if (route.sub === 'files') prefetchCode();
      break;
    }
    case 'queue':
      primeLive('queue', changes.queue, queueInterval);
      primeLive(QUEUE_LIST_KEY, queueList, listInterval);
      primeLive('policy', changes.policy, 60_000);
      break;
    case 'review':
      prefetchCode();
      break;
    case 'agents':
      primeLive('agents', api.agents, 30_000);
      break;
    case 'settings':
      primeLive('policy', changes.policy, 60_000);
      break;
  }
}

/** Speculative reads yield to data saving and cellular connections below 4G. Entry reads still run. */
export function canPrefetch(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');
}

/** For a link under the pointer or focus: its screen's chunk and the data it opens with. */
export function prefetchHref(href: string | undefined) {
  if (!isAppPath(href) || !canPrefetch()) return;
  const route = routeOf(href);
  // Another repository's data is read once its page sets the scope; its code can load now.
  const current = routeOf(window.location.pathname);
  if (route.repo && (!current.repo || addressPath(route.repo) !== addressPath(current.repo))) {
    prefetchScreen(route.screen);
    return;
  }
  primeRoute(route);
}

/**
 * Everything the first paint needs, started before React renders. The repository comes from the
 * URL: the example's scope is known at once, another address is asked of the server, and a link
 * without an address uses the repository this tab remembers. What the last visit said about
 * accounts decides whether `/` is a repository (the single-owner deployment) or the site's home.
 */
export function warmStart() {
  primeAccount();
  const route = routeOf(window.location.pathname + window.location.search);
  const hint = readAccountsHint();
  let scope: string | null = null;
  let state = false;
  if (route.repo) {
    setRouteBase(addressPath(route.repo));
    if (isExample(route.repo)) {
      scope = DEMO_SCOPE;
      state = true;
    } else {
      // Another address: the server names its scope, and the screen's reads start the moment it does rather than once the page renders.
      void primeAddress(route.repo).then((found) => {
        if (!found) return;
        primeWorkspaceScope(found.workspaceId);
        primeRepository(route);
      });
    }
  } else if (isRepositoryScreen(route.screen)) {
    // Both deployments accept the example's scope on a flat route; the single-owner one ignores it.
    scope = hint === false ? null : readSession('workspace') ?? DEMO_SCOPE;
    state = true;
  } else if (route.screen === 'home') {
    if (hint === false) state = true;
    else prefetchLanding();
  }
  setWorkspaceScope(scope);
  prefetchScreen(route.screen);
  if (state) primeRepository(route);
}

/** What the repository's current screen opens with, started as soon as its scope is known. */
function primeRepository(route: Route) {
  primeRouteData(route);
  if (route.screen === 'code' || route.screen === 'home') {
    // Code's reads at the default head need no snapshot to be asked for, so they start with it; a file at a named commit waits for the snapshot below.
    if (!route.path) {
      primeHead();
      prefetchMarkdown();
    } else if (!/^[0-9a-f]{40}$/.test(route.ref ?? '')) primeHead(route.view === 'tree' ? { trees: ['', route.path] } : { trees: [''], file: route.path, ...(route.view === 'blame' ? { blame: route.path } : {}) });
  }
  primeState()
    .then((snapshot) => {
      // Default-branch links use the snapshot's head; an explicit branch or commit stays pinned.
      if (route.screen !== 'code' && route.screen !== 'home') return;
      const path = route.path;
      if (!path) return;
      const ref = route.ref && route.ref !== snapshot.project.branch ? route.ref : snapshot.project.head;
      if (route.view === 'tree') primeTree(path, ref);
      else {
        primeFile(path, ref);
        if (route.view === 'blame') primeBlame(path, ref);
      }
    })
    // A failed warm-up is not an error: the screen asks again and shows what went wrong.
    .catch(() => undefined);
}

/** Warm the next Code or Pull requests tab. Other destinations load on hover, focus or touch. */
export function prefetchLikelyScreens(current: Route['screen']): () => void {
  if (!canPrefetch()) return () => {};
  // Safari has no requestIdleCallback.
  const idle = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
  const next = () => {
    if (canPrefetch()) prefetchScreen(current === 'code' || current === 'home' ? 'pulls' : 'code');
  };
  const handle = idle ? idle(next, { timeout: 4_000 }) : window.setTimeout(next, 1_200);
  return () => {
    if (idle) window.cancelIdleCallback(handle);
    else window.clearTimeout(handle);
  };
}
