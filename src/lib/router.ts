import { useSyncExternalStore } from 'react';
import { addressPath, encodePath, legacyRedirect, routeOf as parseRoute, type Address, type Route } from './address';

export type { Address, Route, Screen } from './address';
export { EXAMPLE_ADDRESS, addressPath, isExample, isRepositoryScreen, sameAddress } from './address';

export type PullFilter = 'review' | 'open' | 'closed';
export type PullTab = 'conversation' | 'guide' | 'checks' | 'files';
export type SettingsSection = 'general' | 'rules' | 'security' | 'queue' | 'webhooks' | 'agents' | 'github' | 'collaborators' | 'account';
export const SETTINGS_SECTIONS: SettingsSection[] = ['general', 'rules', 'security', 'queue', 'webhooks', 'agents', 'github', 'collaborators', 'account'];

const listeners = new Set<() => void>();

/*
 * Every link inside a repository is relative to it. The account layer sets the repository's address
 * before its screens render, so `paths` needs no argument at its hundred call sites; the single-owner
 * deployment has no address and keeps its flat routes.
 */
let base = '';
let ref = 'main';

export function setRouteBase(next: string) {
  base = next;
}

/** The branch files are addressed under, from the repository once it is known. */
export function setRouteRef(branch: string | undefined) {
  ref = branch || 'main';
}

/** An in-app href as a route, without touching the address bar; `legacyRedirect` is applied first. */
export function routeOf(href: string): Route {
  return parseRoute(href, window.location.origin);
}

function parse(): Route {
  const { pathname, search, hash } = window.location;
  const redirect = legacyRedirect(pathname, search, hash);
  if (redirect && redirect !== pathname + search + hash) window.history.replaceState(window.history.state, '', redirect);
  return routeOf(window.location.pathname + window.location.search + window.location.hash);
}

let current = parse();

function emit() {
  current = parse();
  for (const listener of listeners) listener();
}

window.addEventListener('popstate', emit);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  emit();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

type ReviewView = 'changes' | 'merge';

export const paths = {
  /** The site: the landing page, or the dashboard when signed in. */
  site: () => '/',
  explore: () => '/explore',
  /** A new repository: imported from GitHub or a URL, empty, or the sample; `org` picks its owner. */
  newRepository: (org?: string, importing = false) => `/new${org || importing ? `?${new URLSearchParams({ ...(org ? { org } : {}), ...(importing ? { import: '1' } : {}) })}` : ''}`,
  newOrganization: () => '/organizations/new',
  accountSettings: () => '/settings/account',
  pickUsername: () => '/account/username',
  organizations: () => '/settings/organizations',
  organization: (org: string, section: 'repositories' | 'teams' | 'people' | 'settings') => `/orgs/${encodeURIComponent(org)}/${section}`,
  organizationTeam: (org: string, team: string, tab?: 'repositories') => `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}${tab ? `?tab=${tab}` : ''}`,
  /** Sign-in, returning to `next` afterwards. */
  signin: (next?: string) => (next && next !== '/' ? `/signin?next=${encodeURIComponent(next)}` : '/signin'),
  /** An organization's page, with its repositories. */
  owner: (slug: string) => `/${slug}`,
  repo: (address: Address) => addressPath(address),
  /** A branch's commits, newest first, or one path's; the default branch when none is named. */
  commits: (ref?: string, path?: string) => `${base}/commits${ref ? `/${encodeURIComponent(ref)}` : ''}${ref && path ? `/${encodePath(path)}` : ''}`,
  /** One commit: what it changed, who wrote it and the pull request that landed it. */
  commit: (sha: string) => `${base}/commit/${sha}`,
  /** Searching the repository's code at its default branch. */
  search: (query?: string) => `${base}/search${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  /** Code across the repositories the viewer can read. */
  globalSearch: (query?: string) => `/search${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  branches: () => `${base}/branches`,
  /** What `head` has that `baseRef` does not, as GitHub's `compare/<base>...<head>`. */
  compare: (baseRef: string, head: string) => `${base}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(head)}`,
  /** The current repository's home: Code. */
  home: () => base || '/',
  /**
   * The repository's files, as GitHub addresses them: the root, a directory under `tree`, a file
   * under `blob`, or who last changed each of its lines under `blame`. A path whose kind is not
   * known goes under `blob`; the screen shows a directory all the same. `ref` names another branch
   * than the default, whose root is `tree/<branch>`.
   */
  code: (path?: string | null, options?: { view?: 'blame'; kind?: 'dir' | 'file'; ref?: string }) => {
    const at = options?.ref ?? ref;
    if (!path) return at === ref ? base || '/' : `${base}/tree/${encodeURIComponent(at)}`;
    const view = options?.view === 'blame' ? 'blame' : options?.kind === 'dir' ? 'tree' : 'blob';
    return `${base}/${view}/${encodeURIComponent(at)}/${encodePath(path)}`;
  },
  pulls: (filter?: PullFilter) => (filter === 'review' ? `${base}/pulls?review=requested` : filter ? `${base}/pulls?state=${filter}` : `${base}/pulls`),
  /** One agent's pull requests, by its roster id (model, owner and tool). */
  agentPulls: (agent: string) => `${base}/pulls?agent=${encodeURIComponent(agent)}`,
  /** One pull request, on one of its tabs; `file` scrolls Files changed to one file and `since` compares against an earlier revision. */
  pull: (number: string | number, params?: { tab?: PullTab; file?: string; since?: number }) => {
    const start = `${base}/pull/${encodeURIComponent(String(number))}`;
    const tab = params?.file || params?.since ? 'files' : params?.tab;
    const path = tab && tab !== 'conversation' ? `${start}/${tab}` : start;
    const query = new URLSearchParams();
    if (params?.since) query.set('since', String(params.since));
    if (params?.file) query.set('file', params.file);
    const qs = query.toString();
    return qs ? `${path}?${qs}` : path;
  },
  queue: () => `${base}/queue`,
  agents: () => `${base}/agents`,
  task: (id: string) => `${base}/tasks/${encodeURIComponent(id)}`,
  /** The code of a task's agents side by side, or the combined result when `view` is merge. */
  review: (id: string, params?: { file?: string; view?: ReviewView }) => {
    const start = `${base}/review/${encodeURIComponent(id)}`;
    const query = new URLSearchParams();
    if (params?.view === 'merge') query.set('view', 'merge');
    if (params?.file) query.set('file', params.file);
    const qs = query.toString();
    return qs ? `${start}?${qs}` : start;
  },
  merge: (id: string) => paths.review(id, { view: 'merge' }),
  settings: (section?: SettingsSection) => (section && section !== 'general' ? `${base}/settings/${section}` : `${base}/settings`),
};

/** True when a click should be handled by the router instead of the browser. */
export function isPlainLeftClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

/** What the Worker and the static files answer themselves: the API, Git, downloads and the documents agents read. */
const BROWSER_PATHS = new Set(['api', 'git', 'mcp', 'assets', 'fonts', 'cli', 'source', 'favicon.svg', 'llms.txt', 'setup.md', 'auth.md', 'changes.md', 'local-agents.md']);

/** Same-origin screens are routed in-app, file paths included; the API, downloads and documents such as /setup.md go to the browser. */
export function isAppPath(href: string | undefined): href is string {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return false;
  return !BROWSER_PATHS.has(href.slice(1).split(/[/?#]/, 1)[0]);
}
