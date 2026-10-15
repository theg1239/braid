import { createPrivateKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import * as v from 'valibot';
import { publicOrigin, type BraidEnv } from '../env';
import { HttpError } from '../errors';
import { seal, unseal } from '../http/auth';
import { parseFrom } from '../schemas';

export interface GitHubCredentials { login: string; accessToken: string; expiresAt: number; refreshToken?: string; refreshExpiresAt?: number }
export function githubConfigured(env: BraidEnv): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.GITHUB_APP_PRIVATE_KEY && env.SESSION_SECRET);
}
export function githubConfiguration(env: BraidEnv) {
  if (!githubConfigured(env)) throw new HttpError(503, 'GitHub repository connections are not configured for this deployment.');
  const origin = publicOrigin(env);
  if (!/^[a-z\d-]+$/i.test(env.GITHUB_APP_SLUG) || !/^\d+$/.test(env.GITHUB_APP_ID)) throw new HttpError(503, 'GitHub repository configuration is invalid.');
  return { origin: origin.origin, clientId: env.GITHUB_APP_CLIENT_ID, redirect: `${origin.origin}/api/github/callback` };
}
export async function sealGitHub(env: BraidEnv, context: string, value: unknown): Promise<string> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'GitHub credential storage is not configured.');
  return seal(env.SESSION_SECRET, 'braid-github-v1', context, JSON.stringify(value));
}
export async function openGitHub<T>(env: BraidEnv, context: string, value: string): Promise<T> {
  const text = await unseal(env.SESSION_SECRET, 'braid-github-v1', context, value);
  if (text === null) throw new HttpError(409, 'Reconnect GitHub to continue.');
  return JSON.parse(text) as T;
}
/**
 * Calls GitHub's REST API. The answer is unknown until the caller parses the fields it reads.
 * `refused` explains a 422 the caller expects, such as a token whose permissions were never granted;
 * retrying cannot help there, so it is not reported as GitHub failing.
 */
export async function githubApi(path: string, token: string, options: { method?: string; body?: unknown; refused?: string; allowNotFound?: boolean } = {}): Promise<unknown> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path.');
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: options.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Braid', 'x-github-api-version': '2026-03-10', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch { throw new HttpError(502, 'GitHub could not be reached. Try again shortly.'); }
  if (response.status === 401) throw new HttpError(401, 'Reconnect GitHub to continue.');
  if (response.status === 404 && options.allowNotFound) { await response.body?.cancel(); return null; }
  if (response.status === 403 || response.status === 404) throw new HttpError(403, 'GitHub access is unavailable. Check the app’s repository access and your organization permissions.');
  if (response.status === 422 && options.refused) throw new HttpError(403, options.refused);
  if (!response.ok) throw new HttpError(502, 'GitHub could not complete this request. Try again shortly.');
  try { return await response.json(); } catch { throw new HttpError(502, 'GitHub returned an invalid response.'); }
}
/** A repository as GitHub answers a person's own token: its identity and their push permissions. */
const personAccess = v.object({ id: v.number(), permissions: v.optional(v.object({ admin: v.optional(v.boolean()), maintain: v.optional(v.boolean()), push: v.optional(v.boolean()) })) });
/** A successful repository answer to the person's own token proves current read access to that repository. */
export function canRead(answer: unknown, repositoryId: number): boolean {
  const parsed = v.safeParse(personAccess, answer);
  return parsed.success && parsed.output.id === repositoryId;
}
/**
 * Whether GitHub lets the person behind a user token push to a repository. Braid's App can write to every repository
 * it is installed on, whoever asks Braid, so Braid writes only where GitHub itself would let that person push.
 */
export function canPush(answer: unknown, repositoryId: number): boolean {
  const parsed = v.safeParse(personAccess, answer);
  if (!parsed.success || parsed.output.id !== repositoryId) return false;
  const { admin, maintain, push } = parsed.output.permissions ?? {};
  return !!(admin || maintain || push);
}
const seconds = v.pipe(v.number(), v.finite(), v.minValue(1));
/** GitHub answers a failed exchange with 200 and an `error` field, which this rejects. */
const tokenAnswer = v.object({
  access_token: v.string(), token_type: v.pipe(v.string(), v.toLowerCase(), v.literal('bearer')),
  expires_in: v.optional(seconds), refresh_token: v.optional(v.string()), refresh_token_expires_in: v.optional(seconds),
});
export async function exchangeGitHubToken(env: BraidEnv, parameters: Record<string, string>, login = ''): Promise<GitHubCredentials> {
  const config = githubConfiguration(env);
  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Braid' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: env.GITHUB_APP_CLIENT_SECRET, ...parameters }),
    });
  } catch { throw new HttpError(502, 'GitHub could not be reached. Try connecting again.'); }
  if (!response.ok) throw new HttpError(502, 'GitHub could not authorize this connection. Try connecting again.');
  let answer: unknown;
  try { answer = await response.json(); } catch { throw new HttpError(502, 'GitHub returned an invalid authorization response.'); }
  const parsed = v.safeParse(tokenAnswer, answer);
  if (!parsed.success) throw new HttpError(409, 'GitHub authorization expired or was declined. Connect again.');
  const result = parsed.output, expiry = (after?: number) => after ? Date.now() + after * 1000 : 0;
  return { login, accessToken: result.access_token, expiresAt: result.expires_in === undefined ? Number.MAX_SAFE_INTEGER : expiry(result.expires_in),
    ...(result.refresh_token ? { refreshToken: result.refresh_token, refreshExpiresAt: expiry(result.refresh_token_expires_in) } : {}) };
}
const installationAccess = v.object({ token: v.string(), expires_at: v.pipe(v.string(), v.check(value => Number.isFinite(Date.parse(value)))) });
/**
 * A token from the App's installation for one repository, with only the permissions an operation needs. `refused`
 * explains GitHub refusing permissions the App, or this installation of it, was never granted.
 */
export async function repositoryToken(env: BraidEnv, installationId: number, repositoryId: number, permissions: Record<string, 'read' | 'write'>, refused?: string): Promise<{ token: string; expires: number }> {
  const answer = parseFrom(installationAccess, await githubApi(`/app/installations/${installationId}/access_tokens`, await githubAppToken(env), {
    method: 'POST', body: { repository_ids: [repositoryId], permissions }, refused,
  }), 'GitHub did not return repository access. Try again.');
  return { token: answer.token, expires: Date.parse(answer.expires_at) };
}
const repositoryTokens = new Map<string, { token: string; expires: number }>();
/** `repositoryToken`, reused until five minutes before it expires. */
export async function cachedRepositoryToken(env: BraidEnv, installationId: number, repositoryId: number, permissions: Record<string, 'read' | 'write'>, refused?: string): Promise<string> {
  const key = `${installationId}:${repositoryId}:${JSON.stringify(permissions)}`;
  const cached = repositoryTokens.get(key);
  if (cached && cached.expires > Date.now() + 5 * 60_000) return cached.token;
  const access = await repositoryToken(env, installationId, repositoryId, permissions, refused);
  repositoryTokens.set(key, access);
  return access.token;
}
/** The App's private key, parsed once per isolate; each token is still signed fresh. */
const appKeys = new WeakMap<BraidEnv, Promise<CryptoKey>>();
export async function githubAppToken(env: BraidEnv): Promise<string> {
  githubConfiguration(env);
  try {
    let key = appKeys.get(env);
    if (!key) {
      key = importPKCS8(createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n')).export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256');
      appKeys.set(env, key);
    }
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.GITHUB_APP_CLIENT_ID).setIssuedAt(now - 60).setExpirationTime(now + 540).sign(await key);
  } catch { throw new HttpError(503, 'The GitHub App signing key is not configured correctly.'); }
}
