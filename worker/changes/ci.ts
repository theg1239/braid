/**
 * The repository's own CI, connected the way GitHub's merge queue connects
 * it: a signed `merge_group` webhook when a batch is ready, and commit
 * statuses reported back for that batch's commit, signed with the same secret.
 */
import type * as v from 'valibot';
import { base64url } from 'jose';
import type { ciStatus } from '../schemas';

export interface CiStatus { state: v.InferOutput<typeof ciStatus>['state']; description?: string; url?: string; at: string }
export interface Hook { url: string; secret: string; origin: string; by: string; createdAt: string }
export interface HookDelivery { id: string; event: string; at: string; status: number | string; sha: string }

/** A public HTTPS endpoint without credentials; Braid never calls addresses on the local network. */
export function validHookUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return 'Enter a full https:// URL.'; }
  if (url.protocol !== 'https:') return 'The webhook URL must use https.';
  if (url.username || url.password) return 'Put credentials in the secret, not the URL.';
  const host = url.hostname.toLowerCase();
  const local = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.(local|internal|localhost)$/.test(host)
    || /^\[(::1?|f[cd][0-9a-f]{0,2}:.*|fe80:.*)\]$/.test(host);
  if (local) return 'The webhook URL must be reachable on the public internet.';
  return raw.length > 500 ? 'The webhook URL is too long.' : null;
}

export function ciStatusesUrl(origin: string, repository: string, sha: string) { return `${origin}/api/statuses/${base64url.encode(repository)}/${sha}`; }
/** The repository key encoded in a statuses URL, or null. */
export function repositoryFromStatuses(segment: string): string | null {
  try {
    const text = new TextDecoder().decode(base64url.decode(segment));
    return /^[\w:.-]{1,200}$/.test(text) ? text : null;
  } catch { return null; }
}

/** GitHub's `merge_group` event, plus what a CI outside GitHub needs to fetch the commit and answer. */
export function ciPayload(input: { hook: Hook; key: string; verifying: { tip: string; base: string; staging: string; batchId: string; entries: { number: number; title: string }[] };
  repository: { id: string; remote: string; branch: string }; token: string; expiresAt: string }) {
  const { verifying, repository } = input;
  return {
    action: 'checks_requested',
    merge_group: { head_sha: verifying.tip, head_ref: `refs/heads/${verifying.staging}`, base_sha: verifying.base, base_ref: `refs/heads/${repository.branch}`,
      pull_requests: verifying.entries.map(entry => ({ number: entry.number, title: entry.title })) },
    repository: { name: repository.id, clone_url: repository.remote, default_branch: repository.branch },
    // Read-only and short-lived: use it as the password for clone_url with any username.
    clone: { token: input.token, expires_at: input.expiresAt },
    statuses_url: ciStatusesUrl(input.hook.origin, input.key, verifying.tip),
  };
}
