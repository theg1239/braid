import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { BraidEnv } from '../env';
import { closePullRequest, failedChecks, githubBlame, githubEndpoint, installationToken, mergePullRequest, openPullRequest, pullRequestGate, requestReviewers, type GitHubLink } from './bridge';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let nextRepository = 700;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const link: GitHubLink = { installationId: 70, repositoryId: ++nextRepository, fullName: 'acme/private', defaultBranch: 'main', mode: 'pull-requests', linkedBy: 'Alice', linkedAt: new Date().toISOString(), pusher: 'alice', private: true };
  const access = { read: true, push: true };
  const githubAccessToken = vi.fn(async () => ({ ok: true, token: 'fixture-person-token' }));
  const env = { GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'braid-test', GITHUB_APP_CLIENT_ID: 'test-client', GITHUB_APP_CLIENT_SECRET: 'fixture-client',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), SESSION_SECRET: 'x'.repeat(40), PUBLIC_ORIGIN: 'https://braid.example',
    SECURITY: { idFromName: (name: string) => name, get: () => ({ githubAccessToken }) },
    DIRECTORY: { idFromName: (name: string) => name, get: () => ({ access: async () => ({ ok: true, data: { teamId: 'team' } }) }) },
  } as unknown as BraidEnv;
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.github.com') throw new Error('Only fake GitHub API calls are allowed.');
    if (url.pathname === `/repositories/${link.repositoryId}`) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-person-token');
      return access.read ? Response.json({ id: link.repositoryId, permissions: { pull: true, push: access.push } }) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.pathname === '/app/installations/70/access_tokens') return Response.json({ token: 'fixture-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === '/graphql') return Response.json({ data: { repository: { object: null } } });
    if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    if (url.pathname.endsWith('/status')) return Response.json({ statuses: [] });
    if (url.pathname.endsWith('/pulls/1')) return Response.json({ state: 'open', merged: false, merge_commit_sha: null, mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } });
    if (/\/(reviews|comments)$/.test(url.pathname)) return Response.json([]);
    throw new Error(`Unexpected fake GitHub route: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', network);
  return { env, link, access, network, githubAccessToken };
}

it.each(['endpoint', 'blame', 'checks', 'gate'] as const)('blocks %s reads after the linking person loses access, even with a cached App token', async kind => {
  const f = fixture();
  await installationToken(f.env, f.link, false);
  f.access.read = false;
  f.network.mockClear();
  const read = () => kind === 'endpoint' ? githubEndpoint(f.env, f.link, false)
    : kind === 'blame' ? githubBlame(f.env, f.link, 'a'.repeat(40), 'secret.ts')
    : kind === 'checks' ? failedChecks(f.env, f.link, 'a'.repeat(40))
    : pullRequestGate(f.env, f.link, 1, 'a'.repeat(40), 0, { reviewers: [], waitMs: 0 });
  await expect(read()).rejects.toMatchObject({ status: 403 });
  expect(f.network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([`/repositories/${f.link.repositoryId}`]);
});

it('fails closed for a legacy read link with no authorizing identity', async () => {
  const f = fixture();
  delete f.link.pusher;
  await expect(installationToken(f.env, f.link, false)).rejects.toMatchObject({ status: 403 });
  expect(f.network).not.toHaveBeenCalled();
});

it.each(['endpoint', 'open', 'close/comment', 'merge', 'reviewers'] as const)('blocks %s writes after push permission is revoked, even with a cached App token', async kind => {
  const f = fixture();
  await installationToken(f.env, f.link, true);
  f.access.push = false;
  f.network.mockClear();
  const write = () => kind === 'endpoint' ? githubEndpoint(f.env, f.link, true)
    : kind === 'open' ? openPullRequest(f.env, f.link, { branch: 'topic', title: 'Test', body: 'Test' })
    : kind === 'close/comment' ? closePullRequest(f.env, f.link, 1, 'Closing')
    : kind === 'merge' ? mergePullRequest(f.env, f.link, 1, 'a'.repeat(40), 'Test')
    : requestReviewers(f.env, f.link, 1, ['reviewer']);
  await expect(write()).rejects.toMatchObject({ status: 403 });
  expect(f.network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([`/repositories/${f.link.repositoryId}`]);
});

it('allows read-only access using the stored authorization identity, without allowing writes', async () => {
  const f = fixture();
  delete f.link.pusher;
  f.link.authorization = { user: { id: 'alice', name: 'Alice', email: 'alice@example.test' }, workspaceId: 'workspace', teamId: 'team' };
  f.access.push = false;
  await expect(githubEndpoint(f.env, f.link, false)).resolves.toMatchObject({ remote: 'https://github.com/acme/private.git' });
  expect(f.githubAccessToken).toHaveBeenCalledWith('alice');
  await expect(githubEndpoint(f.env, f.link, true)).rejects.toMatchObject({ status: 403 });
});

it('closes a pull request when GitHub refuses the comment that explains it, and logs the refusal by its status', async () => {
  const f = fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const upstream = f.network.getMockImplementation()!;
  f.network.mockImplementation(async (input, init) => new URL(String(input)).pathname.endsWith('/issues/1/comments') ? Response.json({ message: 'Validation Failed' }, { status: 422 }) : upstream(input, init));
  await closePullRequest(f.env, f.link, 1, 'Closing');
  expect(f.network.mock.calls.some(([url, init]) => new URL(String(url)).pathname === '/repos/acme/private/pulls/1' && init?.method === 'PATCH')).toBe(true);
  expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ event: 'github_comment_failed', repositoryId: f.link.repositoryId, pull: 1, status: 502 });
});
