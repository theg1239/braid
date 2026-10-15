/** Only repository roots can be imported, never a provider's account or browsing pages. */
export function repositoryUrlError(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return 'Enter a public HTTPS repository URL.'; }
  if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value) || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
    || !['github.com', 'gitlab.com', 'codeberg.org'].includes(url.hostname))
    return 'Use a public HTTPS repository on GitHub, GitLab or Codeberg, without credentials or query parameters.';
  const parts = url.pathname.slice(1).replace(/\/$/, '').split('/');
  const reserved = url.hostname === 'github.com' ? ['orgs', 'users', 'settings', 'topics', 'collections', 'marketplace', 'apps', 'login', 'search', 'explore', 'organizations']
    : url.hostname === 'gitlab.com' ? ['groups', 'users', 'explore', 'dashboard', 'help', 'admin', 'search', 'projects', 'profile', 'oauth', '-']
    : ['explore', 'user', 'org', 'repo', 'admin'];
  if (parts.length < 2 || (url.hostname !== 'gitlab.com' && parts.length !== 2) || reserved.includes(parts[0].toLowerCase())
    || parts.some(part => !/^[a-z\d_.-]+$/i.test(part) || ['.', '..', '-'].includes(part)) || !parts.at(-1)!.replace(/\.git$/, ''))
    return `Use a repository URL, such as https://${url.hostname}/owner/repository. Organization, file and branch pages cannot be imported.`;
}
