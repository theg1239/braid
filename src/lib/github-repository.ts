import { RESERVED_OWNERS, SLUG } from '../../shared/routes';
import type { Address } from './address';

/** Accept GitHub repository links, including a file link, and open their repository root. */
export function githubRepository(value: string): Address | null {
  const input = value.trim();
  if (!input || /[\s\\]/.test(input)) return null;
  let parts: string[];
  if (/^(?:https?:\/\/|(?:www\.)?github\.com\/)/i.test(input)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
    if (!['github.com', 'www.github.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    parts = url.pathname.slice(1).split('/');
  } else {
    parts = input.replace(/\/$/, '').split('/');
    if (parts.length !== 2) return null;
  }
  const owner = parts[0]?.toLowerCase();
  const repo = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !SLUG.test(owner) || RESERVED_OWNERS.has(owner) || !repo || !/^[a-z\d_.-]{1,100}$/i.test(repo) || /^\.{1,2}$/.test(repo)) return null;
  return { owner, repo };
}
