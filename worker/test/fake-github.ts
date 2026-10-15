import { vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, chmodSync, rmSync } from 'node:fs';

interface FakePull { number: number; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeCommit?: string; comments: string[]; requested?: string[]; title?: string; body?: string }
/**
 * A stand-in for github.com: Git traffic for `acme/relay` goes to a real bare
 * repository on the local test server, and REST calls are answered from that
 * repository's state plus scripted checks and reviews.
 */
export function fakeGitHub(options: { root: string; gitOrigin: string; fullName?: string }) {
  const fullName = options.fullName ?? 'acme/relay';
  const path = join(options.root, 'github.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', path], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', path, 'config', 'http.receivepack', 'true']);
  const git = (args: string[], input?: string) => execFileSync('git', ['--git-dir', path, ...args], { encoding: 'utf8', input, env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } });
  const pulls: FakePull[] = [];
  const state = {
    checks: (_sha: string): { name: string; status: string; conclusion: string | null; output?: { title?: string; summary?: string } }[] => [{ name: 'ci / test', status: 'completed', conclusion: 'success' }],
    reviews: (_pull: FakePull): { user: { login: string; type: string }; state: string; body: string; commit_id: string; submitted_at: string }[] => [],
    comments: (_pull: FakePull): { user: { login: string }; path: string; line: number; body: string }[] => [],
    mergeable: 'clean', private: false,
    /** Whether GitHub lets the person who linked the repository push to it, as their own token is told. */
    push: true,
    /** The app's permissions; null grants everything. Tokens asking for more are refused with 422, as GitHub does. */
    granted: null as Record<string, 'read' | 'write'> | null,
    /** GraphQL requests answered, such as blame, and whether GraphQL is failing. */
    graphql: 0, graphqlDown: false,
  };
  const protect = (on: boolean) => {
    const hook = join(path, 'hooks', 'pre-receive');
    if (!on) { rmSync(hook, { force: true }); return; }
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "protected branch hook declined"; exit 1; fi; done\n');
    chmodSync(hook, 0o755);
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    GITHUB_APP_ID: '42', GITHUB_APP_SLUG: 'braid-test', GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_CLIENT_SECRET: 'secret',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), SESSION_SECRET: 'x'.repeat(40), PUBLIC_ORIGIN: 'https://braid.example',
    // The person who linked the repository has GitHub connected; what they may do there is GitHub's answer above.
    SECURITY: { idFromName: (name: string) => name, get: () => ({ githubAccessToken: async () => ({ ok: true, token: 'ghu_maya' }), revokeLeakedToken: async () => null }) },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const real = globalThis.fetch;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://github.com') {
      const rest = url.pathname.replace(`/${fullName}.git`, '/github.git');
      return real(`${options.gitOrigin}${rest}${url.search}`, init);
    }
    if (url.origin !== 'https://api.github.com') return real(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const repo = `/repos/${fullName}`;
    if (method === 'GET' && url.pathname === repo) return json({ private: state.private });
    if (method === 'GET' && url.pathname === '/repositories/99') return json({ id: 99, permissions: { admin: false, maintain: false, push: state.push, pull: true } });
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      const level: Record<string, number> = { read: 1, write: 2 };
      const granted = state.granted;
      if (granted && Object.entries(body.permissions as Record<string, string>).some(([name, access]) => (level[granted[name]] ?? 0) < level[access])) return json({ message: 'The permissions requested are not granted to this installation.' }, 422);
      return json({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (method === 'POST' && url.pathname === `${repo}/pulls`) {
      const pull: FakePull = { number: pulls.length + 1, head: git(['rev-parse', `refs/heads/${body.head}`]).trim(), base: body.base, state: 'open', merged: false, comments: [], title: body.title, body: body.body };
      pulls.push(pull);
      return json({ number: pull.number, html_url: `https://github.com/${fullName}/pull/${pull.number}` }, 201);
    }
    const requestMatch = url.pathname.match(new RegExp(`^${repo}/pulls/(\\d+)/requested_reviewers$`));
    if (requestMatch && method === 'POST') { const pull = pulls[Number(requestMatch[1]) - 1]; if (pull) pull.requested = body.reviewers; return json({ requested_reviewers: (body.reviewers as string[]).map(login => ({ login })) }, 201); }
    const pullMatch = url.pathname.match(new RegExp(`^${repo}/pulls/(\\d+)(/merge|/reviews|/comments)?$`));
    if (pullMatch) {
      const pull = pulls[Number(pullMatch[1]) - 1];
      if (!pull) return json({ message: 'Not Found' }, 404);
      if (!pullMatch[2] && method === 'GET') return json({ state: pull.state, merged: pull.merged, merge_commit_sha: pull.mergeCommit ?? null, mergeable_state: state.mergeable, head: { sha: pull.head } });
      if (!pullMatch[2] && method === 'PATCH') { pull.state = body.state; return json({ state: pull.state }); }
      if (pullMatch[2] === '/reviews') return json(state.reviews(pull));
      if (pullMatch[2] === '/comments') return json(state.comments(pull));
      if (pullMatch[2] === '/merge' && method === 'PUT') {
        const base = git(['rev-parse', 'refs/heads/main']).trim();
        const tree = git(['merge-tree', '--write-tree', base, pull.head]).trim().split('\n')[0];
        const merge = git(['commit-tree', tree, '-p', base, '-p', pull.head], `${body.commit_title}\n`).trim();
        protect(false);
        git(['update-ref', 'refs/heads/main', merge, base]);
        Object.assign(pull, { merged: true, state: 'closed', mergeCommit: merge });
        return json({ merged: true, sha: merge });
      }
    }
    if (method === 'POST' && url.pathname === '/graphql') {
      state.graphql++;
      if (state.graphqlDown) return json({ message: 'Server Error' }, 502);
      // GitHub's blame of one file at one commit, from `git blame` on this repository.
      const { oid, path: file } = body.variables as { oid: string; path: string };
      try { git(['cat-file', '-e', `${oid}^{commit}`]); } catch { return json({ data: { repository: { object: null } } }); }
      const owners: string[] = [];
      for (const line of git(['blame', '--porcelain', oid, '--', file]).split('\n')) {
        const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
        if (header) owners[Number(header[2])] = header[1];
      }
      const ranges: { startingLine: number; endingLine: number; commit: unknown }[] = [];
      for (let line = 1; line < owners.length; line++) {
        const last = ranges.at(-1) as { startingLine: number; endingLine: number; commit: { oid: string } } | undefined;
        if (last && last.commit.oid === owners[line]) { last.endingLine = line; continue; }
        const [name, email, date, ...message] = git(['log', '-1', '--format=%an%n%ae%n%cI%n%B', owners[line]]).split('\n');
        ranges.push({ startingLine: line, endingLine: line, commit: { oid: owners[line], message: message.join('\n').trim(), committedDate: date, author: { name, email } } });
      }
      return json({ data: { repository: { object: { blame: { ranges } } } } });
    }
    const commentMatch = url.pathname.match(new RegExp(`^${repo}/issues/(\\d+)/comments$`));
    if (commentMatch && method === 'POST') { pulls[Number(commentMatch[1]) - 1]?.comments.push(body.body); return json({}, 201); }
    const checkMatch = url.pathname.match(new RegExp(`^${repo}/commits/([0-9a-f]{40})/(check-runs|status)$`));
    if (checkMatch) return checkMatch[2] === 'status' ? json({ statuses: [] }) : json({ check_runs: state.checks(checkMatch[1]) });
    const compare = url.pathname.match(new RegExp(`^${repo}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`));
    if (compare) {
      const [, base, head] = compare;
      try { git(['cat-file', '-e', `${base}^{commit}`]); } catch { return json({ message: 'Not Found' }, 404); }
      const ancestor = (a: string, b: string) => { try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
      return json({ status: base === head ? 'identical' : ancestor(base, head) ? 'ahead' : ancestor(head, base) ? 'behind' : 'diverged' });
    }
    return json({ message: `Unhandled fake GitHub route ${method} ${url.pathname}` }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { path, git, pulls, state, env, protect, fullName, link: (mode: 'pull-requests' | 'mirror') => ({ installationId: 7, repositoryId: 99, fullName, defaultBranch: 'main', mode, linkedBy: 'Maya Chen', linkedAt: new Date().toISOString(), pusher: 'maya' }) };
}
