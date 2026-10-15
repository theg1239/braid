import { waitForPublicReads } from '../http/public-access';
import { base64url } from 'jose';
import * as oauth from 'oauth4webapi';
import * as v from 'valibot';
import type { AccountIdentity } from '../../shared/account';
import type { GitHubConnection, GitHubInstallation, GitHubPage, GitHubRepository, GitHubRepositorySelection } from '../../shared/github';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import { authorization, type GitEndpoint } from '../git/transport';
import type { RepositoryEntry, RepositoryFile } from '../../shared/repository';
import { base64Bytes, cookie, cookies, digest, equalSecret, jsonBody } from '../http/auth';
import { HttpError, unwrap } from '../errors';
import { githubFlowStart, githubLink, parse, parseFrom, positiveId, queryNumber } from '../schemas';
import { cachedRepositoryToken, canPush, exchangeGitHubToken, githubApi, githubAppToken, githubConfiguration, githubConfigured, repositoryToken } from './client';
import { personHandle } from '../repositories/provenance';
import { TEXT_LIMIT } from '../repositories/repository';
import { repositoryKey, trunkOf } from '../changes/names';
import { githubRepoOf } from './webhook';
import type { Authorization } from '../http/authorization';
import { now } from '../workspace/domain';

const flowCookie = (state: string, request: Request, age = 600) => cookie('braid-github-connect', state, request, age, 'Lax');
type Flow = { kind: 'connect' | 'install'; user: AccountIdentity; workspaceId: string; sessionDigest: string; verifier: string; returnTo?: string };
async function githubOwner(env: BraidEnv, user: AccountIdentity, workspaceId: string): Promise<{ teamId: string }> {
  if (!workspaceId || workspaceId === 'demo') throw new HttpError(400, 'Select a live repository workspace first.');
  return { teamId: unwrap(await directoryOf(env).access(user, workspaceId, true)).teamId };
}
export async function userApi(env: BraidEnv, userId: string, path: string, options?: { allowNotFound?: boolean }): Promise<unknown> {
  const security = securityOf(env), result = await security.githubAccessToken(userId);
  if (!result.ok) throw new HttpError(result.status, result.error);
  try { return await githubApi(path, result.token, options); }
  catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      await security.disconnectGitHub(userId);
      throw new HttpError(409, 'Reconnect GitHub to continue.');
    }
    throw error;
  }
}
/** Repositories, installations and accounts as GitHub's API returns them; a disabled repository is unavailable. */
const githubRepository = v.pipe(
  v.object({ id: positiveId(), name: v.string(), full_name: v.pipe(v.string(), v.regex(/^[a-z\d_.-]+\/[a-z\d_.-]+$/i)), private: v.boolean(), default_branch: v.pipe(v.string(), v.nonEmpty()), disabled: v.optional(v.boolean()) }),
  v.check(repo => !repo.disabled),
  v.transform((repo): GitHubRepository => ({ id: repo.id, name: repo.name, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch })));
const repository = (value: unknown) => parseFrom(githubRepository, value, 'GitHub returned an unavailable repository.');
const githubInstallation = v.object({ id: positiveId(), account: v.object({ login: v.string(), type: v.string() }), suspended_at: v.nullish(v.string()) });
const githubProfile = v.object({ id: positiveId(), login: v.pipe(v.string(), v.regex(/^[a-z\d-]+$/i)) });
const page = queryNumber(1, v.pipe(v.number('Invalid repository page.'), v.safeInteger('Invalid repository page.'), v.minValue(1, 'Invalid repository page.'), v.maxValue(1000, 'Invalid repository page.')));
const installationQuery = queryNumber(0, positiveId('Choose a GitHub account.'));
async function beginFlow(request: Request, env: BraidEnv, user: AccountIdentity, workspaceId: string, kind: Flow['kind']) {
  const config = githubConfiguration(env);
  if (new URL(request.url).origin !== config.origin) throw new HttpError(400, 'Connect GitHub from the configured application URL.');
  const session = cookies(request)['braid-session'];
  if (!session) throw new HttpError(401, 'Sign in to connect GitHub.');
  const { returnTo } = parse(githubFlowStart, await jsonBody(request));
  const state = oauth.generateRandomState(), verifier = oauth.generateRandomCodeVerifier();
  const flow: Flow = { kind, user, workspaceId, sessionDigest: await digest(session), verifier, returnTo };
  await securityOf(env).challenge(`github:${await digest(state)}`, JSON.stringify(flow), Date.now() + 600_000);
  const url = new URL(kind === 'connect' ? 'https://github.com/login/oauth/authorize' : `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  url.searchParams.set('state', state);
  if (kind === 'connect') {
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirect);
    url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return Response.json({ url: url.toString() }, { headers: { 'set-cookie': flowCookie(state, request) } });
}
export async function githubReturn(request: Request, env: BraidEnv): Promise<Response> {
  const config = githubConfiguration(env), url = new URL(request.url), security = securityOf(env);
  if (url.origin !== config.origin) throw new HttpError(400, 'Invalid GitHub callback origin.');
  const state = cookies(request)['braid-github-connect'], returned = url.searchParams.get('state');
  if (!state || !returned || state.length > 128 || !await equalSecret(state, returned)) throw new HttpError(400, 'This GitHub connection expired or belongs to another browser. Connect again.');
  const stored = await security.takeChallenge(`github:${await digest(state)}`);
  if (!stored) throw new HttpError(400, 'This GitHub connection has expired or has already been used. Connect again.');
  const flow = JSON.parse(stored) as Flow;
  const user = await security.identity(flow.sessionDigest);
  if (!user || user.id !== flow.user.id) throw new HttpError(401, 'Sign in again before connecting GitHub.');
  await githubOwner(env, user, flow.workspaceId);
  const target = new URL(flow.returnTo ?? '/', config.origin);
  if (!flow.returnTo) { target.searchParams.set('setup', 'github'); target.searchParams.set('workspace', flow.workspaceId); }
  if (url.searchParams.has('error')) target.searchParams.set('github', 'declined');
  else if (flow.kind === 'connect' && url.pathname === '/api/github/callback') {
    const code = url.searchParams.get('code'), issuer = url.searchParams.get('iss');
    if (!code || code.length > 1000 || (issuer && issuer !== 'https://github.com/login/oauth')) throw new HttpError(400, 'GitHub authorization could not be verified. Connect again.');
    const credentials = await exchangeGitHubToken(env, { code, code_verifier: flow.verifier, redirect_uri: config.redirect });
    const profile = parseFrom(githubProfile, await githubApi('/user', credentials.accessToken), 'GitHub returned an invalid account.');
    await security.connectGitHub(user.id, { ...credentials, login: profile.login });
    await security.recordGitHubIdentity(user.id, { id: profile.id, login: profile.login }, 'connection');
  } else if (flow.kind === 'install' && url.pathname === '/api/github/installed') {
    // installation_id is untrusted. Repository access is always read from the user API.
    if (url.searchParams.get('setup_action') === 'request') target.searchParams.set('github', 'pending');
  } else throw new HttpError(400, 'This GitHub callback does not match the connection request.');
  return new Response(null, { status: 303, headers: { location: target.toString(), 'set-cookie': flowCookie('', request, 0) } });
}
export async function githubRoute(request: Request, env: BraidEnv, user: AccountIdentity, workspaceId: string): Promise<Response> {
  const { teamId } = await githubOwner(env, user, workspaceId);
  const url = new URL(request.url), path = url.pathname, security = securityOf(env);
  if (path === '/api/github/link') {
    const repository = repositoryKey(teamId, workspaceId);
    const trunk = trunkOf(env, repository);
    if (request.method === 'GET') return Response.json(await trunk.githubLink(repository));
    if (request.method === 'DELETE') {
      const unlinked = unwrap(await trunk.unlinkGitHub(repository));
      if (unlinked) await githubRepoOf(env, unlinked.repositoryId).unlink(repository);
      return Response.json({ ok: true });
    }
    if (request.method === 'POST') {
      const selection = parse(githubLink, await jsonBody(request));
      const repo = await githubRepositoryForImport(env, user, selection, 'push');
      const linked = unwrap(await trunk.linkGitHub(repository, { installationId: selection.installationId, repositoryId: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch,
        mode: selection.mode, private: repo.private, linkedBy: personHandle(user), linkedAt: now(), pusher: user.id, authorization: { user, workspaceId, teamId } }));
      await githubRepoOf(env, repo.id).link(repository);
      return Response.json(linked, { status: 201 });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  if (path === '/api/github/connection' && request.method === 'GET') {
    const configured = githubConfigured(env), connection = configured ? await security.githubConnection(user.id) : null;
    return Response.json({ configured, connected: !!connection, ...(connection ?? {}) } satisfies GitHubConnection);
  }
  if (path === '/api/github/connection' && request.method === 'DELETE') { await security.disconnectGitHub(user.id); return Response.json({ ok: true }); }
  if (path === '/api/github/connect' && request.method === 'POST') return beginFlow(request, env, user, workspaceId, 'connect');
  if (path === '/api/github/install' && request.method === 'POST') return beginFlow(request, env, user, workspaceId, 'install');
  githubConfiguration(env);
  const number = parse(page, url.searchParams.get('page'));
  if (path === '/api/github/installations' && request.method === 'GET') {
    const { installations } = parseFrom(v.object({ installations: v.array(v.unknown()) }), await userApi(env, user.id, `/user/installations?per_page=100&page=${number}`), 'GitHub returned an invalid account list.');
    // Suspended or unreadable installations are left out rather than failing the list.
    const items = installations.flatMap((item): GitHubInstallation[] => {
      const parsed = v.safeParse(githubInstallation, item);
      return parsed.success && !parsed.output.suspended_at ? [{ id: parsed.output.id, account: parsed.output.account.login, kind: parsed.output.account.type === 'Organization' ? 'Organization' : 'User' }] : [];
    });
    return Response.json({ items, nextPage: installations.length === 100 ? number + 1 : null } satisfies GitHubPage<GitHubInstallation>);
  }
  if (path === '/api/github/repositories' && request.method === 'GET') {
    const selected = parse(installationQuery, url.searchParams.get('installationId'));
    const { repositories } = parseFrom(v.object({ repositories: v.array(githubRepository) }), await userApi(env, user.id, `/user/installations/${selected}/repositories?per_page=100&page=${number}`), 'GitHub returned an unavailable repository.');
    return Response.json({ items: repositories, nextPage: repositories.length === 100 ? number + 1 : null } satisfies GitHubPage<GitHubRepository>);
  }
  throw new HttpError(404, 'GitHub endpoint not found.');
}
/**
 * A repository the person chose, read with their own GitHub authorization. The App's installation reaches every
 * repository it is installed on, so linking, which lets Braid write there, also needs the person's own push access.
 */
export async function githubRepositoryForImport(env: BraidEnv, user: AccountIdentity, selected: GitHubRepositorySelection, access: 'read' | 'push' = 'read'): Promise<GitHubRepository> {
  const answer = await userApi(env, user.id, `/repositories/${selected.repositoryId}`), repo = repository(answer);
  if (repo.id !== selected.repositoryId) throw new HttpError(403, 'The selected GitHub repository changed. Select it again.');
  if (access === 'push' && !canPush(answer, repo.id)) throw new HttpError(403, `Linking needs your push access to ${repo.fullName} on GitHub.`);
  const installation = parseFrom(v.object({ id: positiveId(), suspended_at: v.nullish(v.string()) }), await githubApi(`/repos/${repo.fullName}/installation`, await githubAppToken(env)), 'GitHub returned an invalid installation.');
  if (installation.id !== selected.installationId || installation.suspended_at) throw new HttpError(403, 'This repository is not available through the selected GitHub installation.');
  return repo;
}
const CONTENTS = { contents: 'read' } as const;
/** A repository that turned private on GitHub makes its Braid copy private before anything is read from it. */
async function keepPrivate(env: BraidEnv, repo: GitHubRepository, workspaceId: string) {
  if (repo.private) await waitForPublicReads(await directoryOf(env).repositoryImported(workspaceId, false));
}
export async function githubImportSource(env: BraidEnv, user: AccountIdentity, workspaceId: string, selected: GitHubRepositorySelection, repo: GitHubRepository): Promise<string> {
  await githubOwner(env, user, workspaceId);
  const access = await repositoryToken(env, selected.installationId, selected.repositoryId, CONTENTS);
  const expires = Math.min(access.expires, Date.now() + 3_600_000);
  if (expires <= Date.now() + 60_000) throw new HttpError(502, 'GitHub did not return repository access. Try again.');
  const capability = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  await securityOf(env).issueGitHubImport(await digest(capability), { user, workspaceId, repositoryId: repo.id, fullName: repo.fullName, token: access.token, expires });
  return `${githubConfiguration(env).origin}/api/github/import/${capability}/repository.git`;
}
/**
 * Read-only Git access to a selected repository for Braid's own transfers, such as copying an import's other branches.
 * A repository that turned private since its import makes the Braid repository private first, as the import did.
 */
export async function githubReadEndpoint(env: BraidEnv, user: AccountIdentity, workspaceId: string, selected: GitHubRepositorySelection): Promise<GitEndpoint> {
  await githubOwner(env, user, workspaceId);
  const repo = await githubRepositoryForImport(env, user, selected);
  await keepPrivate(env, repo, workspaceId);
  return { remote: `https://github.com/${repo.fullName}.git`, token: await cachedRepositoryToken(env, selected.installationId, selected.repositoryId, CONTENTS), username: 'x-access-token' };
}

/** Where an import's files can be read while Artifacts copies them: the selected repository on GitHub, at the branch being copied. */
export interface ImportPreview { github: GitHubRepositorySelection; fullName: string; branch: string; authorization?: Authorization }
const previewKind = v.picklist(['file', 'dir', 'symlink', 'submodule']);
const previewEntry = v.object({ name: v.string(), path: v.string(), sha: v.string(), type: previewKind });
const previewFileAnswer = v.object({ type: previewKind, sha: v.string(), size: v.number(), content: v.optional(v.string()), encoding: v.optional(v.string()), target: v.optional(v.string()) });
const PREVIEW_MODES = { file: '100644', dir: '40000', symlink: '120000', submodule: '160000' } as const;
async function previewRead(env: BraidEnv, preview: ImportPreview, path: string): Promise<unknown> {
  if (!preview.authorization) throw new HttpError(403, 'Retry the import so Braid can confirm who may read its source.');
  const { user, workspaceId } = preview.authorization;
  await githubOwner(env, user, workspaceId);
  const repo = await githubRepositoryForImport(env, user, preview.github);
  if (repo.fullName !== preview.fullName) throw new HttpError(409, 'The GitHub repository changed during import. Retry from Braid.');
  await keepPrivate(env, repo, workspaceId);
  const route = `/repos/${preview.fullName}/contents${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}?ref=${encodeURIComponent(preview.branch)}`;
  try { return await githubApi(route, await cachedRepositoryToken(env, preview.github.installationId, preview.github.repositoryId, CONTENTS)); }
  catch (error) { throw error instanceof HttpError && error.status === 403 ? new HttpError(404, 'Not found in the source.') : error; }
}
/** One directory of an import's source, so its files show before the copy lands. */
export async function previewDirectory(env: BraidEnv, preview: ImportPreview, path: string): Promise<RepositoryEntry[]> {
  const answer = await previewRead(env, preview, path);
  if (!Array.isArray(answer)) throw new HttpError(404, 'Directory not found.');
  return parseFrom(v.array(previewEntry), answer, 'GitHub returned an invalid directory.').map(item => ({ name: item.name, path: item.path, hash: item.sha, mode: PREVIEW_MODES[item.type], kind: item.type }));
}
/** One file of an import's source, read as Braid reads its own copy: text up to 500 KB, otherwise its kind alone. */
export async function previewFile(env: BraidEnv, preview: ImportPreview, path: string): Promise<Omit<RepositoryFile, 'ref'>> {
  const answer = await previewRead(env, preview, path);
  if (Array.isArray(answer)) return { content: '', path, kind: 'dir' };
  const file = parseFrom(previewFileAnswer, answer, 'GitHub returned an invalid file.');
  const meta = { path, hash: file.sha, size: file.size };
  if (file.type === 'submodule') return { ...meta, content: '', kind: 'submodule' };
  if (file.type === 'symlink') return { ...meta, content: file.target ?? '', kind: 'symlink' };
  if (file.size > TEXT_LIMIT || file.encoding !== 'base64' || file.content === undefined) return { ...meta, content: '', kind: 'large' };
  const bytes = base64Bytes(file.content.replace(/\s/g, ''));
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? { ...meta, content: '', kind: 'binary' } : { ...meta, content: text, kind: 'text' };
  } catch { return { ...meta, content: '', kind: 'binary' }; }
}
/** Streams read-only Git traffic to Artifacts without cloning or retaining repository blobs in a Worker. */
export async function githubImportTransport(request: Request, env: BraidEnv): Promise<Response> {
  const url = new URL(request.url), match = url.pathname.match(/^\/api\/github\/import\/([a-zA-Z0-9_-]{43})\/repository\.git\/(info\/refs|git-upload-pack)$/);
  if (!match) throw new HttpError(404, 'Import endpoint not found.');
  const advertisement = match[2] === 'info/refs';
  if ((advertisement && (request.method !== 'GET' || url.search !== '?service=git-upload-pack'))
    || (!advertisement && (request.method !== 'POST' || url.search || request.headers.get('content-type') !== 'application/x-git-upload-pack-request')))
    throw new HttpError(405, 'Only read-only Git import requests are allowed.');
  const security = securityOf(env), grant = await security.githubImport(await digest(match[1]));
  if (!grant) throw new HttpError(401, 'The GitHub import has expired. Retry the import from Braid.');
  if (grant.mirror) return (await import('./mirrors')).mirrorImportTransport(request, env, grant);
  await githubOwner(env, grant.user, grant.workspaceId);
  const repo = repository(await userApi(env, grant.user.id, `/repositories/${grant.repositoryId}`));
  if (repo.id !== grant.repositoryId || repo.fullName !== grant.fullName) throw new HttpError(409, 'The GitHub repository changed during import. Retry from Braid.');
  await keepPrivate(env, repo, grant.workspaceId);
  const upstreamHeaders: Record<string, string> = { authorization: authorization({ token: grant.token, username: 'x-access-token' }), 'user-agent': 'Braid' };
  if (!advertisement) upstreamHeaders['content-type'] = 'application/x-git-upload-pack-request';
  const protocol = request.headers.get('git-protocol');
  if (protocol === 'version=2') upstreamHeaders['git-protocol'] = protocol;
  let upstream: Response;
  try {
    upstream = await fetch(`https://github.com/${repo.fullName}.git/${match[2]}${url.search}`, { method: request.method, headers: upstreamHeaders,
      body: advertisement ? undefined : request.body, redirect: 'manual', signal: AbortSignal.timeout(300_000) });
  } catch { throw new HttpError(502, 'GitHub could not complete the repository transfer.'); }
  const expectedType = advertisement ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result';
  if (upstream.status !== 200 || !upstream.headers.get('content-type')?.startsWith(expectedType)) throw new HttpError(502, 'GitHub did not complete the repository transfer. Check repository access and retry.');
  return new Response(upstream.body, { headers: { 'content-type': expectedType, 'cache-control': 'no-store' } });
}
