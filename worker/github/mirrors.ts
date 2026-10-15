import { base64url } from 'jose';
import type { AccountIdentity } from '../../shared/account';
import { RESERVED_OWNERS, SLUG } from '../../shared/routes';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import { HttpError } from '../errors';
import { readAdvertisement, authorization, FLUSH, GitError, pktLine, type GitEndpoint } from '../git/transport';
import { userApi } from './routes';
import { githubNamespace, githubOrganizationMembership, githubMirrorHead, githubMirrorRepository, repositoryAddress, parseFrom } from '../schemas';
import { digest } from '../http/auth';

/** GitHub advertises every pull request's refs too; busy repositories such as openai/codex list over 25,000 refs (1.8 MB). */
export const MIRROR_ADVERTISEMENT_BYTES = 16 * 1024 * 1024;
export const MIRROR_SYNC_MS = 5 * 60_000;
export const MIRROR_ACCESS_MS = 30_000;
export const MIRROR_NETWORK_LIMIT = 20;
export const MIRROR_DAILY_LIMIT = 200;
const MIRROR_PRIVATE = "Not found on GitHub, or you don't have access.";
const MIRROR_MISSING = "Not found on GitHub. If it's private, sign in with GitHub to see it.";
export const MIRROR_NOT_FOUND_CODE = 'github_not_found_or_private';
export const MIRROR_PRIVATE_ACCESS_MS = 60_000;
export const MIRROR_PACK_BYTES = 64 * 1024 * 1024;
/**
 * Artifacts refuses an import above about 40 MB without naming the cause. The bridge stops a larger one first and
 * marks the mirror too large, so the workspace knows to copy the snapshot in parts instead.
 */
export const MIRROR_IMPORT_BYTES = 36 * 1024 * 1024;
/**
 * Bytes a mirror may transfer for its import, history, branches and syncs. Artifacts stores at most 1 GB a repository,
 * and transfers also carry objects a repository already has. Reaching it stops copying, never what the mirror serves.
 */
export const MIRROR_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MIRROR_LARGE = 'Too large to mirror.';
export const MIRROR_NAMESPACE_CHANGED = 'The GitHub account behind this name changed. This mirror is frozen.';
type MirrorSource = { fullName: string; branch: string; head: string; repositoryId?: number; private?: boolean; namespaceId?: number };
export type MirrorRecord = { workspaceId: string; teamId: string; fullName: string; branch: string; head: string; repositoryId: number | null; namespaceId: number | null; private: number; syncedAt: string | null; importing: number; enabled: number; error: string | null };
export type ClaimProof = { claimable: boolean; kind?: 'user' | 'organization'; namespaceId?: number; member?: boolean; reason?: string; /** Links an existing Braid organization to GitHub rather than claiming a new owner. */ link?: boolean; /** The viewer already owns the name; a claim only turns on its read-only mirrors. */ owned?: boolean };
export const mirrorNotFound = (signedIn: boolean) => new HttpError(404, signedIn ? MIRROR_PRIVATE : MIRROR_MISSING, undefined, MIRROR_NOT_FOUND_CODE);
export const MIRROR_FROZEN_CODE = 'github_namespace_changed';
export const mirrorFrozen = () => new HttpError(409, MIRROR_NAMESPACE_CHANGED, undefined, MIRROR_FROZEN_CODE);
export const MIRROR_LARGE_CODE = 'mirror_too_large';
export const mirrorTooLarge = () => new HttpError(413, MIRROR_LARGE, undefined, MIRROR_LARGE_CODE);

/** Public callers never supply credentials. Private probes follow a successful check with this viewer's token. */
async function probe(fullName: string, token = ''): Promise<MirrorSource> {
  const [owner, repo, extra] = fullName.split('/');
  const parsedName = parseFrom(repositoryAddress, { owner, repo }, 'Invalid GitHub address.');
  if (extra !== undefined || `${parsedName.owner}/${parsedName.repo}` !== fullName || RESERVED_OWNERS.has(owner)) throw new HttpError(404, 'Repository not found.');
  let response: Response;
  try { response = await fetch(`https://github.com/${fullName}.git/info/refs?service=git-upload-pack`, {
    redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Braid', ...(token ? { authorization: authorization({ token, username: 'x-access-token' }) } : {}) },
  }); } catch { throw new HttpError(502, 'GitHub could not be reached. Try again shortly.'); }
  if (!response.ok) {
    await response.body?.cancel();
    // GitHub deliberately uses 401 for both private and nonexistent repositories. Anonymous callers cannot tell.
    if (response.status === 401 || response.status === 404) throw mirrorNotFound(!!token);
    throw new HttpError(502, 'GitHub could not verify this public repository.');
  }
  if (!response.body) throw new HttpError(502, 'GitHub returned an invalid advertisement.');
  if (Number(response.headers.get('content-length')) > MIRROR_ADVERTISEMENT_BYTES) { await response.body.cancel(); throw mirrorTooLarge(); }
  try {
    const { refs, capabilities } = await readAdvertisement(response, 'git-upload-pack', MIRROR_ADVERTISEMENT_BYTES);
    const branch = [...capabilities].find(cap => cap.startsWith('symref=HEAD:refs/heads/'))?.slice('symref=HEAD:refs/heads/'.length);
    const head = refs.get('HEAD');
    const parsed = parseFrom(githubMirrorHead, { branch, head }, 'GitHub did not advertise a default branch. Empty repositories cannot be mirrored.');
    if (refs.get(`refs/heads/${parsed.branch}`) !== parsed.head) throw new HttpError(502, 'GitHub returned an inconsistent default branch.');
    return { fullName, ...parsed };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof GitError && error.code === 'too_large') throw mirrorTooLarge();
    throw new HttpError(502, 'GitHub returned an invalid advertisement.');
  }
}
type CacheEntry<T> = { until: number; answer: Promise<T> };
type PrivateRepository = ReturnType<typeof parsePrivateRepository>;
const parsePrivateRepository = (answer: unknown) => parseFrom(githubMirrorRepository, answer, 'GitHub returned an invalid repository.');
const privateAccess = new WeakMap<BraidEnv, Map<string, CacheEntry<PrivateRepository>>>();
/** A lease is keyed by viewer, current token digest and immutable repo ID; tokens never enter an edge cache. */
export async function privateMirrorRepository(env: BraidEnv, userId: string | null, fullName: string, repositoryId?: number | null, fresh = false): Promise<PrivateRepository> {
  if (!userId) throw mirrorNotFound(false);
  const security = securityOf(env), access = await security.githubAccessToken(userId);
  if (!access.ok) throw mirrorNotFound(true);
  const key = `${userId}:${await digest(access.token)}:${repositoryId ?? fullName}`;
  let cache = privateAccess.get(env);
  if (!cache) { cache = new Map(); privateAccess.set(env, cache); }
  const known = cache.get(key);
  if (!fresh && known && known.until > Date.now()) return known.answer;
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  const answer = (async () => {
    try {
      const repo = parsePrivateRepository(await userApi(env, userId, repositoryId ? `/repositories/${repositoryId}` : `/repos/${fullName}`));
      if (repo.disabled || repo.full_name.toLowerCase() !== fullName || repositoryId && repo.id !== repositoryId) throw mirrorNotFound(true);
      return repo;
    } catch { throw mirrorNotFound(true); }
  })();
  cache.set(key, { until: Date.now() + MIRROR_PRIVATE_ACCESS_MS, answer });
  return answer;
}
export async function mirrorSource(env: BraidEnv, fullName: string, user: AccountIdentity | null): Promise<MirrorSource> {
  try { return await publicMirrorSource(env, fullName); }
  catch (error) {
    if (!(error instanceof HttpError) || error.code !== MIRROR_NOT_FOUND_CODE) throw error;
    const repo = await privateMirrorRepository(env, user?.id ?? null, fullName);
    if (!repo.private) throw mirrorNotFound(!!user);
    const endpoint = await privateMirrorEndpoint(env, user!.id, fullName, repo.id);
    return { ...await probe(fullName, endpoint.token), private: true, repositoryId: repo.id, namespaceId: repo.owner.id };
  }
}
async function privateMirrorEndpoint(env: BraidEnv, userId: string, fullName: string, repositoryId: number): Promise<GitEndpoint> {
  await privateMirrorRepository(env, userId, fullName, repositoryId);
  const access = await securityOf(env).githubAccessToken(userId);
  if (!access.ok) throw mirrorNotFound(true);
  return { remote: `https://github.com/${fullName}.git`, token: access.token, username: 'x-access-token' };
}
export async function mirrorEndpoint(env: BraidEnv, mirror: MirrorRecord, userId?: string): Promise<GitEndpoint> {
  if (mirror.namespaceId) await mirrorNamespaceProof(env, mirror, userId ?? null);
  if (mirror.private) {
    if (!userId || !mirror.repositoryId) throw mirrorNotFound(!!userId);
    return privateMirrorEndpoint(env, userId, mirror.fullName, mirror.repositoryId);
  }
  await publicMirrorSource(env, mirror.fullName);
  return { remote: `https://github.com/${mirror.fullName}.git`, token: '' };
}
/** Verify the current address with this viewer. A recycled login freezes the old copy before any transfer. */
export async function mirrorNamespaceProof(env: BraidEnv, mirror: MirrorRecord, userId: string | null) {
  const source = await privateMirrorRepository(env, userId, mirror.fullName);
  if (mirror.namespaceId && source.owner.id !== mirror.namespaceId) {
    await directoryOf(env).mirrorUpdated(mirror.workspaceId, { importing: false, error: MIRROR_NAMESPACE_CHANGED });
    throw mirrorFrozen();
  }
  if (mirror.repositoryId && source.id !== mirror.repositoryId) throw mirrorNotFound(!!userId);
  return source;
}
export async function refreshedMirrorSource(env: BraidEnv, mirror: MirrorRecord, userId?: string, fresh = true): Promise<MirrorSource> {
  if (mirror.private) return probe(mirror.fullName, (await mirrorEndpoint(env, mirror, userId)).token);
  if (mirror.namespaceId) await mirrorNamespaceProof(env, mirror, userId ?? null);
  return publicMirrorSource(env, mirror.fullName, fresh);
}
/**
 * Reserve before fetching, refund only bytes that never arrived. Crashes conservatively retain the reservation.
 * A transfer past its limit marks the mirror too large, unless the caller splits what it asked for, as a copy in
 * parts does.
 */
export async function mirrorTransfer(env: BraidEnv, workspaceId: string, { recordOversize = true }: { recordOversize?: boolean } = {}) {
  const directory = directoryOf(env);
  const reserved = await directory.reserveMirrorBytes(workspaceId, MIRROR_PACK_BYTES);
  if (!reserved) throw mirrorTooLarge();
  // Only a transfer that reached its end is charged: one cut short stored nothing. An oversized one is charged in full.
  let used = 0, charged = 0, finished = false;
  const finish = async () => { if (!finished) { finished = true; await directory.releaseMirrorBytes(workspaceId, MIRROR_PACK_BYTES - charged); } };
  return {
    finish,
    wrap(body: ReadableStream<Uint8Array>, limit = MIRROR_PACK_BYTES): ReadableStream<Uint8Array> {
      const reader = body.getReader();
      return new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { charged = used; await finish(); controller.close(); return; }
            if (chunk.value.byteLength > limit - used) {
              charged = MIRROR_PACK_BYTES;
              await reader.cancel();
              if (recordOversize) await directory.mirrorUpdated(workspaceId, { importing: false, error: MIRROR_LARGE });
              throw mirrorTooLarge();
            }
            used += chunk.value.byteLength; controller.enqueue(chunk.value);
          } catch (error) { await reader.cancel(error).catch(() => { /* Only releases the upstream body; the stream reports `error` either way. */ }); await finish(); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason); await finish(); },
      });
    },
  };
}
/**
 * The import's view of GitHub's refs: HEAD and the default branch it names. An import copies one branch one commit
 * deep, and GitHub also lists every pull request, which makes the list too long for Artifacts to read on large repositories.
 */
async function importRefs(advertised: Response): Promise<Blob> {
  const { refs, capabilities } = await readAdvertisement(advertised, 'git-upload-pack', MIRROR_ADVERTISEMENT_BYTES);
  const branch = [...capabilities].find(capability => capability.startsWith('symref=HEAD:'))?.slice('symref=HEAD:'.length);
  const kept = [['HEAD', refs.get('HEAD')], [branch, branch && refs.get(branch)]].filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]);
  return new Blob([pktLine('# service=git-upload-pack\n'), FLUSH, ...kept.map(([ref, oid], index) => pktLine(`${oid} ${ref}${index ? '' : `\0${[...capabilities].join(' ')}`}\n`)), FLUSH] as BlobPart[]);
}
/** An opaque capability identifies an import, never a GitHub token. Every bridge request rechecks its authority. */
export async function mirrorImportSource(env: BraidEnv, mirror: MirrorRecord, userId?: string): Promise<string> {
  const capability = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  await securityOf(env).issueGitHubImport(await digest(capability), { mirror: true, user: { id: userId ?? '', email: '', name: '' }, workspaceId: mirror.workspaceId,
    repositoryId: mirror.repositoryId ?? 0, fullName: mirror.fullName, token: '', expires: Date.now() + 3_600_000 });
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new HttpError(503, 'The public application URL is not configured.');
  return `${origin.origin}/api/github/import/${capability}/repository.git`;
}
export async function mirrorImportTransport(request: Request, env: BraidEnv, grant: { workspaceId: string; fullName: string; user: AccountIdentity }): Promise<Response> {
  const mirror = await directoryOf(env).mirrorRecord(grant.workspaceId);
  if (!mirror || mirror.enabled || mirror.error || mirror.fullName !== grant.fullName) throw mirrorNotFound(!!grant.user.id);
  const endpoint = await mirrorEndpoint(env, mirror, grant.user.id);
  const url = new URL(request.url), advertisement = url.pathname.endsWith('/info/refs');
  const transfer = await mirrorTransfer(env, mirror.workspaceId);
  try {
    const upstream = await fetch(`${endpoint.remote}/${advertisement ? 'info/refs?service=git-upload-pack' : 'git-upload-pack'}`, {
      method: advertisement ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(300_000),
      headers: { 'user-agent': 'Braid', ...(endpoint.token ? { authorization: authorization(endpoint) } : {}), ...(!advertisement ? { 'content-type': 'application/x-git-upload-pack-request' } : {}) },
      body: advertisement ? undefined : request.body,
    });
    const type = `application/x-git-upload-pack-${advertisement ? 'advertisement' : 'result'}`;
    if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.startsWith(type)) { await upstream.body?.cancel(); throw new HttpError(502, 'GitHub could not complete the repository transfer.'); }
    if (advertisement) return new Response(await importRefs(new Response(transfer.wrap(upstream.body, MIRROR_ADVERTISEMENT_BYTES), { headers: { 'content-type': type } })), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    return new Response(transfer.wrap(upstream.body, MIRROR_IMPORT_BYTES), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  } catch (error) { await transfer.finish(); throw error; }
}
const publicSources = new WeakMap<BraidEnv, Map<string, CacheEntry<MirrorSource>>>();
/** Short, bounded, in-memory leases include refusals. Repeated reads never update repository SQLite. */
export function publicMirrorSource(env: BraidEnv, fullName: string, fresh = false): Promise<MirrorSource> {
  let cache = publicSources.get(env);
  if (!cache) { cache = new Map(); publicSources.set(env, cache); }
  const known = cache.get(fullName);
  if (!fresh && known && known.until > Date.now()) return known.answer;
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  const answer = probe(fullName);
  cache.set(fullName, { until: Date.now() + MIRROR_ACCESS_MS, answer });
  return answer;
}

/** Names are checked only with the requesting person's token. Public Git reads never depend on the REST quota. */
export async function githubAccount(env: BraidEnv, userId: string, slug: string) {
  if (!SLUG.test(slug) || RESERVED_OWNERS.has(slug)) throw new HttpError(404, 'Owner not found.');
  const value = await userApi(env, userId, `/users/${slug}`, { allowNotFound: true });
  if (value === null) return null;
  const account = parseFrom(githubNamespace, value, 'GitHub returned an invalid account.');
  if (account.login.toLowerCase() !== slug) throw new HttpError(409, 'The GitHub account has moved. Use its current name.');
  return account;
}

const proofs = new WeakMap<BraidEnv, Map<string, CacheEntry<ClaimProof>>>();
/** The optional UI hint is cached; a POST always makes a fresh proof. Installation access is not admin proof. */
export async function githubClaimProof(env: BraidEnv, user: AccountIdentity | null, slug: string, fresh = false): Promise<ClaimProof> {
  if (!user) return { claimable: false, reason: 'Sign in and connect GitHub to claim this owner.' };
  const security = securityOf(env);
  const [identity, connection] = await Promise.all([security.githubIdentity(user.id), security.githubConnection(user.id)]);
  if (!identity || !connection) return { claimable: false, reason: 'Connect GitHub to claim this owner.' };
  // A repository connection may differ from the identity used to sign in. Never let that claim another person's login.
  if (connection.login.toLowerCase() !== identity.login.toLowerCase()) return { claimable: false, reason: 'Connect the GitHub account you signed in with.' };
  const key = `${user.id}:${identity.id}:${identity.login}:${slug}`;
  let cache = proofs.get(env);
  if (!cache) { cache = new Map(); proofs.set(env, cache); }
  const known = cache.get(key);
  if (!fresh && known && known.until > Date.now()) return known.answer;
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  const answer = (async (): Promise<ClaimProof> => {
    try {
      // Recheck the token's identity, so changing or revoking a connection invalidates the next uncached proof.
      const current = parseFrom(githubNamespace, await userApi(env, user.id, '/user'), 'GitHub returned an invalid account.');
      if (current.id !== identity.id || current.login.toLowerCase() !== identity.login.toLowerCase()) return { claimable: false, reason: 'Reconnect the GitHub account you signed in with.' };
      if (identity.login.toLowerCase() === slug) return { claimable: true, kind: 'user', namespaceId: current.id };
      const membership = parseFrom(githubOrganizationMembership, await userApi(env, user.id, `/user/memberships/orgs/${slug}`), 'GitHub returned an invalid organization membership.');
      if (membership.organization.login.toLowerCase() !== slug) return { claimable: false, reason: 'GitHub returned a different organization.' };
      if (membership.state !== 'active') return { claimable: false, reason: 'An active GitHub organization admin must claim this owner.' };
      return { claimable: membership.role === 'admin', kind: 'organization', namespaceId: membership.organization.id, member: true,
        ...(membership.role === 'admin' ? {} : { reason: 'Only a GitHub organization admin can claim this owner.' }) };
    } catch {
      return { claimable: false, reason: 'GitHub could not confirm organization admin access. Braid needs permission to read your organization membership; installation access alone is not sufficient.' };
    }
  })();
  cache.set(key, { until: Date.now() + 3 * 60_000, answer });
  return answer;
}
