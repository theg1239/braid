/*
 * Repository addresses, as GitHub's: `/<owner>/<repo>` with Code, Pull requests, Agents and Settings under it.
 * Slugs are lowercase letters, digits and single hyphens, and never one of the app's own top-level paths.
 */

export const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

/** Top-level paths the app and the Worker use, which no organization may take as its slug. */
export const RESERVED_OWNERS = new Set([
  'api', 'git', 'mcp', 'assets', 'fonts', 'cli', 'source', 'docs', 'images', 'favicon.svg', 'llms.txt', 'setup.md', 'auth.md',
  'changes.md', 'local-agents.md', 'login', 'logout', 'signin', 'signup', 'join', 'invite', 'connect', 'explore', 'new',
  'settings', 'account', 'teams', 'orgs', 'organizations', 'example', 'demo', 'about', 'pricing', 'blog', 'help', 'terms', 'privacy', 'security',
  'tree', 'blob', 'blame', 'missions', 'landing', 'policy', 'rules', 'context', 'repository', 'changes', 'cdn-cgi',
  'code', 'pulls', 'pull', 'agents', 'tasks', 'review', 'queue', 'braid', 'admin', 'www', 'static', 'public', 'oauth',
  'commits', 'commit', 'branches', 'compare', 'search', 'skills', 'og.png', 'apple-touch-icon.png', 'boot.js', 'scale-evidence.txt',
]);

/** A slug from a display name: lowercase, hyphens for runs of anything else, trimmed to 39 characters. */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39).replace(/-+$/, '');
}

/** A starting suggestion only; the Directory resolves shared-namespace collisions. */
export function usernameSuggestion(email: string): string {
  const base = slugOf(email.split('@')[0]) || 'person';
  return RESERVED_OWNERS.has(base) ? `${base.slice(0, 37)}-2` : base;
}
