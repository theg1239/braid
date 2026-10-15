/*
 * Repository addresses, as GitHub's: `/<owner>/<repo>` with the repository's screens under it, and
 * the site's own pages beside them. Pure functions of a URL, with no window, so the route store and
 * the tests share them.
 */
import { RESERVED_OWNERS, SLUG } from '../../shared/routes';

/** The repository's screens, and the site's: home (the landing page or the dashboard), Explore and sign-in. */
export type Screen = 'account' | 'username' | 'organizations' | 'home' | 'explore' | 'signin' | 'authorize' | 'new' | 'new-organization' | 'organization' | 'owner' | 'code' | 'search' | 'global-search' | 'commits' | 'commit' | 'branches' | 'compare' | 'pulls' | 'pull' | 'queue' | 'agents' | 'task' | 'review' | 'settings' | 'not-found';

/** A repository's address: its organization's slug and its own. */
export interface Address {
  owner: string;
  repo: string;
}

/** The recorded example's address. `example` is a reserved owner, so no organization can take it. */
export const EXAMPLE_ADDRESS: Address = { owner: 'example', repo: 'relay' };

/** A path under Code: a directory, a file, or a file's blame. */
type CodeView = 'tree' | 'blob' | 'blame';

interface ParsedPath {
  screen: Screen;
  /** The repository in the address, or null on the site's pages and on the single-owner deployment's flat routes. */
  repo: Address | null;
  /** Second segment under the repository: a pull request number, a task id or a settings section. */
  id: string | null;
  /** Third segment: a pull request tab. */
  sub: string | null;
  /** Under Code: which view, the ref and the path; the repository root has none. */
  view: CodeView | null;
  ref: string | null;
  path: string;
}

export interface Route extends ParsedPath {
  query: URLSearchParams;
  hash: string;
  href: string;
}

/** The repository's screens by their first segment: a URL starting with one is never an address. */
const REPOSITORY_PATHS = new Set(['code', 'pulls', 'pull', 'queue', 'agents', 'tasks', 'review', 'settings', 'tree', 'blob', 'blame', 'commits', 'commit', 'branches', 'compare', 'search']);
/** Earlier first segments, kept flat so `legacyRedirect` can move them. */
const LEGACY_PATHS = new Set(['missions', 'landing', 'policy', 'rules', 'context', 'repository', 'changes']);
const SITE_PATHS = new Set(['explore', 'signin', 'new', 'search']);

export function isExample(address: Address): boolean {
  return address.owner === EXAMPLE_ADDRESS.owner && address.repo === EXAMPLE_ADDRESS.repo;
}

export function sameAddress(a: Address | null, b: Address | null): boolean {
  return a === b || (!!a && !!b && a.owner === b.owner && a.repo === b.repo);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape, as typed into the address bar, stays as typed.
    return segment;
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeSegment);
}

/** A repository path, segment by segment, so a slash stays a separator and anything else travels encoded. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** `/<owner>/<repo>`, the base of every link into a repository. */
export function addressPath(address: Address): string {
  return `/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.repo)}`;
}

/** Whether a segment can be an owner's address: a slug no app path has taken. */
const isOwnerSlug = (segment: string) => SLUG.test(segment) && !RESERVED_OWNERS.has(segment);

/** Whether two segments can be a repository address. The example's is reserved for it alone. */
function isAddress(first: string, second: string | undefined): boolean {
  if (first === EXAMPLE_ADDRESS.owner) return second === EXAMPLE_ADDRESS.repo;
  return isOwnerSlug(first.toLowerCase()) && !!second && /^[a-z\d_.-]{1,100}$/i.test(second) && !/^\.{1,2}$/.test(second);
}

const NONE = { id: null, sub: null, view: null, ref: null, path: '' };

/** The screen under a repository, from the segments after its address, or the whole path of a flat route. */
function screenUnder(rest: string[]): Omit<ParsedPath, 'repo'> {
  const [first, second, third] = rest;
  const base = { ...NONE, id: second ?? null, sub: third ?? null };
  if (!first || first === 'code') return { ...base, screen: 'code' };
  if (first === 'tree' || first === 'blob' || first === 'blame') {
    if (!second) return { ...NONE, screen: 'not-found' };
    return { ...NONE, screen: 'code', view: first, ref: second, path: rest.slice(2).join('/') };
  }
  // A branch's history, or one path's, as GitHub's `commits/<ref>/<path>`.
  if (first === 'commits') return { ...NONE, screen: 'commits', ref: second ?? null, path: rest.slice(2).join('/') };
  if (first === 'commit') return { ...base, screen: second ? 'commit' : 'not-found' };
  // Code search, with the query in `?q=`.
  if (first === 'search') return { ...base, screen: 'search' };
  if (first === 'branches') return { ...base, screen: 'branches' };
  // `compare/<base>...<head>`, with both refs in the one segment.
  if (first === 'compare') return { ...base, screen: 'compare' };
  if (first === 'pulls') return { ...base, screen: 'pulls' };
  if (first === 'pull') return { ...base, screen: second ? 'pull' : 'not-found' };
  if (first === 'queue') return { ...base, screen: 'queue' };
  if (first === 'agents') return { ...base, screen: 'agents' };
  if (first === 'tasks') return { ...base, screen: second ? 'task' : 'not-found' };
  if (first === 'review') return { ...base, screen: second ? 'review' : 'not-found' };
  if (first === 'settings') return { ...base, screen: 'settings' };
  return { ...NONE, screen: 'not-found' };
}

/** What a pathname shows: a site page, a repository's screen under its address, or a flat repository screen. */
export function parsePath(pathname: string): ParsedPath {
  const segments = segmentsOf(pathname);
  const [first, second] = segments;
  if (segments.length === 2 && first === 'account' && second === 'username') return { ...NONE, screen: 'username', repo: null };
  // The page an MCP client opens to ask for access over OAuth; the Worker answers the rest of /oauth.
  if (segments.length === 2 && first === 'oauth' && second === 'authorize') return { ...NONE, screen: 'authorize', repo: null };
  if (segments.length === 2 && first === 'settings' && (second === 'account' || second === 'organizations')) return { ...NONE, screen: second, id: second, repo: null };
  if (!first) return { ...NONE, screen: 'home', repo: null };
  if (first === 'organizations') return { ...NONE, screen: second === 'new' && segments.length === 2 ? 'new-organization' : 'not-found', repo: null };
  if (first === 'orgs') {
    const [, org, section, team] = segments;
    const valid = org && isOwnerSlug(org) && ['repositories', 'teams', 'people', 'settings'].includes(section) && (segments.length === 3 || (section === 'teams' && segments.length === 4 && SLUG.test(team)));
    return valid ? { ...NONE, screen: 'organization', repo: null, id: org, sub: section, path: team ?? '' } : { ...NONE, screen: 'not-found', repo: null };
  }
  if (SITE_PATHS.has(first)) return { ...NONE, screen: second ? 'not-found' : first === 'search' ? 'global-search' : (first as Screen), repo: null };
  // An organization's own page, as GitHub's `/<owner>`: its repositories.
  if (!second && isOwnerSlug(first)) return { ...NONE, screen: 'owner', repo: null, id: first };
  if (REPOSITORY_PATHS.has(first) || LEGACY_PATHS.has(first)) return { repo: null, ...screenUnder(segments) };
  if (!isAddress(first, second)) return { ...NONE, screen: 'not-found', repo: null };
  return { repo: { owner: first.toLowerCase(), repo: second! }, ...screenUnder(segments.slice(2)) };
}

/** The repository's screens, which need a workspace; the rest are the site's. */
export function isRepositoryScreen(screen: Screen): boolean {
  return screen !== 'global-search' && screen !== 'account' && screen !== 'username' && screen !== 'organizations' && screen !== 'home' && screen !== 'explore' && screen !== 'signin' && screen !== 'authorize' && screen !== 'new' && screen !== 'owner' && screen !== 'organization' && screen !== 'new-organization' && screen !== 'not-found';
}

/** An href as a route, resolved against the origin; `legacyRedirect` is applied first. */
export function routeOf(href: string, origin: string): Route {
  const url = new URL(href, origin);
  const redirect = legacyRedirect(url.pathname, url.search, url.hash);
  if (redirect) return routeOf(redirect, origin);
  return { ...parsePath(url.pathname), query: url.searchParams, hash: url.hash.replace(/^#/, ''), href: url.pathname + url.search + url.hash };
}

/** Earlier list filters, by the stage or group they named. */
const OLD_FILTER: Record<string, 'review' | 'open' | 'closed' | null> = {
  'needs-you': 'review', attention: 'review', 'in-progress': 'open', revise: 'open', open: 'open', queue: 'open', landed: 'closed', closed: 'closed', all: null,
};
const OLD_SETTINGS_HASH: Record<string, string> = { repository: '', github: '/github', agents: '/agents', team: '/collaborators', account: '/account', access: '/account', example: '', demo: '', simulation: '!queue' };

/**
 * Where an earlier URL now lives, or null when the URL is current. Old links keep working and the
 * address bar shows the current one. Flat routes keep their shape here; on a deployment with
 * accounts the account layer puts the current repository's address in front of them.
 */
export function legacyRedirect(pathname: string, search: string, hash: string): string | null {
  const segments = segmentsOf(pathname);
  const [first, second] = segments;
  const query = new URLSearchParams(search);
  const rest = segments.slice(1).map(encodeURIComponent).join('/');
  if (first === 'missions') return second ? `/tasks/${rest}${search}${hash}` : '/agents';
  if (first === 'tasks' && !second) return '/agents';
  if (first === 'landing') return '/queue';
  if (first === 'policy' || first === 'rules') return hash === '#notes' ? '/settings/agents' : '/settings/rules';
  if (first === 'context') return '/settings/agents';
  if ((first === 'repository' || first === 'code') && !second) {
    // Files used to live in the query; they are GitHub's blob, tree and blame paths now, under main.
    const path = query.get('path')?.replace(/\/+$/, '');
    return path ? `/${query.get('view') === 'blame' ? 'blame' : 'blob'}/main/${encodePath(path)}` : '/';
  }
  if (first === 'pulls' && second) return `/pull/${rest}${search}`;
  if (first === 'changes') {
    if (second) return `/pull/${encodeURIComponent(second)}${query.get('file') ? `/files${search}` : ''}`;
    const filter = OLD_FILTER[query.get('stage') ?? query.get('group') ?? ''] ?? null;
    return filter === 'review' ? '/pulls?review=requested' : filter ? `/pulls?state=${filter}` : '/pulls';
  }
  if (first === 'settings' && hash) {
    const target = OLD_SETTINGS_HASH[hash.slice(1)];
    if (target === '!queue') return '/queue';
    if (target !== undefined) return `/settings${target}`;
  }
  return null;
}
