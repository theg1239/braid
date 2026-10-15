import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { changeHarness } from '../test/changes-harness';
import { fakeGitHub } from '../test/fake-github';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await harness?.close(); harness = undefined; });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};

async function linked(mode: 'pull-requests' | 'mirror' = 'pull-requests', policy?: unknown) {
  harness = await changeHarness();
  const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
  Object.assign(harness.env, github.env);
  const base = harness.git.commitTree({ 'src/a.ts': 'export const a = 1;\n', 'README.md': '# Relay\n', ...(policy ? { '.braid/policy.json': JSON.stringify(policy) } : {}) });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  execFileSync('git', ['--git-dir', github.path, 'fetch', '--quiet', `${harness.git.root}/repo.git`, 'main:main']);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
  const link = await harness.trunk.linkGitHub(harness.repository, github.link(mode));
  expect(link).toMatchObject({ ok: true, data: { status: 'synced', mode } });
  return { harness, github, base };
}
const change = (title: string, path: string, content: string, base: string) => ({ title, summary: title, baseCommit: base, files: [{ path, content }] });
/** Lets the GitHub gate be read again immediately, as a webhook would. */
async function wake(h: NonNullable<typeof harness>, rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await h.trunk.githubEvent(h.repository, { name: 'check_suite', sha: (await h.trunk.status(h.repository)).landing?.head });
    await h.settle(1);
  }
}

describe('landing through GitHub pull requests', () => {
  it('opens a pull request for the composed batch and lands it when GitHub checks pass', async () => {
    const { harness, github, base } = await linked();
    const one = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    const two = ok(await harness.submit('sable', change('Add c', 'src/c.ts', 'export const c = 3;\n', base)));
    // Both changes need a reviewer under the default policy; the stand-in reviewer approves.
    await harness.settle(2);
    const status = await harness.trunk.status(harness.repository);
    expect(status.landing).toMatchObject({ status: 'verifying', pullRequest: { number: 1 } });
    expect(github.pulls[0]).toMatchObject({ base: 'main', state: 'open' });
    // GitHub has the batch branch; neither main has moved yet.
    expect(github.git(['rev-parse', 'main']).trim()).toBe(base);
    await wake(harness);
    const head = github.git(['rev-parse', 'main']).trim();
    expect(head).not.toBe(base);
    expect(harness.head()).toBe(head);
    expect(github.git(['show', 'main:src/c.ts'])).toBe('export const c = 3;\n');
    for (const item of [one, two]) {
      const landed = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
      expect(landed.status).toBe('landed');
      expect(landed.checks.at(-1)).toMatchObject({ source: 'github', status: 'passed', label: 'ci / test' });
    }
    // The landing branch is deleted on both hosts.
    expect(() => github.git(['rev-parse', '--verify', `refs/heads/braid/land/${status.landing!.id}`])).toThrow();
  }, 60_000);

  it('records comment-only reviews as comments and neutral checks as warnings', async () => {
    const { harness, github, base } = await linked();
    github.state.checks = () => [
      { name: 'Macroscope - Correctness Check', status: 'completed', conclusion: 'neutral', output: { title: '1 issue found' } },
      { name: 'ci / test', status: 'completed', conclusion: 'success' },
    ];
    github.state.reviews = pull => [{ user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'One suggestion on naming.', commit_id: pull.head, submitted_at: new Date().toISOString() }];
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    const landed = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(landed.status).toBe('landed');
    // A review app that only commented never counts as an approval.
    expect(landed.reviews.find(review => review.reviewer === 'github:copilot-pull-request-reviewer[bot]')).toMatchObject({ verdict: 'comment' });
    expect(landed.checks.find(check => check.label === 'Macroscope - Correctness Check')).toMatchObject({ status: 'warning', source: 'github' });
    expect(landed.checks.find(check => check.label === 'ci / test')).toMatchObject({ status: 'passed' });
  }, 60_000);

  it('treats a cancelled GitHub run as a failure, not a pass', async () => {
    const { harness, github, base } = await linked();
    // Cancelled on the merge-queue pull request only; main itself is green.
    github.state.checks = sha => sha === base ? [{ name: 'ci / test', status: 'completed', conclusion: 'success' }] : [{ name: 'ci / test', status: 'completed', conclusion: 'cancelled' }];
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    expect(github.git(['rev-parse', 'main']).trim()).toBe(base);
    const current = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(current.status).not.toBe('landed');
    expect(current.checks.some(check => check.source === 'github' && check.status === 'failed')).toBe(true);
  }, 60_000);

  it('asks review apps to review the merge-queue pull request and gives each change only its own comments', async () => {
    const { harness, github, base } = await linked('pull-requests', { github: { reviewers: ['copilot'], wait: 30 } });
    let reviewed = false;
    github.state.reviews = pull => reviewed ? [{ user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'Copilot reviewed 2 files.', commit_id: pull.head, submitted_at: new Date().toISOString() }] : [];
    github.state.comments = () => reviewed ? [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, path: 'src/b.ts', line: 1, body: 'Consider a clearer name than b.' }] : [];
    const one = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    const two = ok(await harness.submit('sable', change('Add c', 'src/c.ts', 'export const c = 3;\n', base)));
    await harness.settle(2);
    await wake(harness, 2);
    expect(github.pulls[0].requested).toEqual(['copilot-pull-request-reviewer[bot]']);
    // Checks passed, but the requested review has not arrived, so nothing merges yet.
    expect((await harness.trunk.status(harness.repository)).landing?.pullRequest).toMatchObject({ state: 'pending', reason: 'Waiting for copilot-pull-request-reviewer[bot] to review.' });
    expect(github.git(['rev-parse', 'main']).trim()).toBe(base);
    reviewed = true;
    await wake(harness);
    const b = ok(await harness.shard(parseInt(one.id[3], 16)).get(one.id)), c = ok(await harness.shard(parseInt(two.id[3], 16)).get(two.id));
    expect([b.status, c.status]).toEqual(['landed', 'landed']);
    expect(b.reviews.find(review => review.reviewer === 'github:copilot-pull-request-reviewer[bot]')).toMatchObject({ verdict: 'comment', findings: [expect.objectContaining({ path: 'src/b.ts' })] });
    expect(c.reviews.some(review => review.reviewer === 'github:copilot-pull-request-reviewer[bot]')).toBe(false);
  }, 60_000);

  it('merges without a review app that never reviews, and records that it did not', async () => {
    const { harness, base } = await linked('pull-requests', { github: { reviewers: ['coderabbit'], wait: 0 } });
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    const landed = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(landed.status).toBe('landed');
    expect(landed.checks.find(check => check.label === 'CodeRabbit review')).toMatchObject({ status: 'warning', source: 'github', detail: expect.stringContaining('no review arrived') });
  }, 60_000);

  it('pauses instead of blaming anyone when GitHub CI already fails on main', async () => {
    const { harness, github, base } = await linked();
    github.state.checks = () => [{ name: 'ci / test', status: 'completed', conclusion: 'failure', output: { title: '1 test failed' } }];
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    expect((await harness.trunk.status(harness.repository)).paused).toBe('Main fails `ci / test` on GitHub on its own. Merging is paused until main is fixed; no pull request was blamed.');
    const current = ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id));
    expect(current.status).toBe('queued');
    expect(current.checks.some(check => check.status === 'failed')).toBe(false);
  }, 60_000);

  it('merges through GitHub when branch protection forbids direct pushes', async () => {
    const { harness, github, base } = await linked();
    github.protect(true);
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    const head = github.git(['rev-parse', 'main']).trim();
    expect(github.git(['show', '-s', '--format=%P', head]).trim().split(' ')).toHaveLength(2);
    expect(harness.head()).toBe(head);
    expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    harness.git.native(['fsck', '--no-dangling']);
  }, 60_000);

  it('narrows a failing GitHub check to the responsible change', async () => {
    const { harness, github, base } = await linked();
    github.state.checks = sha => {
      const broken = github.git(['ls-tree', '-r', '--name-only', sha]).includes('src/broken.ts');
      return [{ name: 'ci / test', status: 'completed', conclusion: broken ? 'failure' : 'success', output: { title: broken ? '1 test failed' : 'All tests passed' } }];
    };
    const good = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    const bad = ok(await harness.submit('sable', change('Add broken', 'src/broken.ts', 'export const broken = true;\n', base)));
    await harness.settle(2);
    for (let round = 0; round < 8; round++) await wake(harness, 1);
    expect(ok(await harness.shard(parseInt(good.id[3], 16)).get(good.id)).status).toBe('landed');
    const sentBack = ok(await harness.shard(parseInt(bad.id[3], 16)).get(bad.id));
    expect(sentBack.status).toBe('revise');
    expect(sentBack.checks.some(check => check.source === 'github' && check.status === 'failed' && check.detail.includes('1 test failed'))).toBe(true);
    expect(github.pulls.filter(pull => pull.state === 'closed' && !pull.merged).length).toBeGreaterThan(0);
  }, 90_000);

  it('routes review comments to the change that touched the file', async () => {
    const { harness, github, base } = await linked();
    let rejected = false;
    github.state.reviews = pull => rejected ? [] : [{ user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', body: 'One issue found.', commit_id: pull.head, submitted_at: new Date().toISOString() }];
    github.state.comments = () => rejected ? [] : [{ user: { login: 'coderabbitai[bot]' }, path: 'src/unsafe.ts', line: 1, body: 'eval() on request input allows code injection.' }];
    const safe = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    const unsafe = ok(await harness.submit('sable', change('Add unsafe', 'src/unsafe.ts', 'export const run = (input: string) => eval(input);\n', base)));
    await harness.settle(2);
    await wake(harness, 1);
    rejected = true;
    const sentBack = ok(await harness.shard(parseInt(unsafe.id[3], 16)).get(unsafe.id));
    expect(sentBack).toMatchObject({ status: 'revise' });
    expect(sentBack.reviews.at(-1)).toMatchObject({ reviewer: 'github:coderabbitai[bot]', verdict: 'revise', findings: [expect.objectContaining({ path: 'src/unsafe.ts', message: expect.stringContaining('code injection') })] });
    await harness.settle(2);
    await wake(harness);
    expect(ok(await harness.shard(parseInt(safe.id[3], 16)).get(safe.id)).status).toBe('landed');
    expect(() => github.git(['show', 'main:src/unsafe.ts'])).toThrow();
  }, 90_000);

  it('does not sync new private GitHub commits after the linking person loses read access', async () => {
    const { harness, github, base } = await linked();
    github.state.private = true;
    const upstream = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.github.com/repositories/99') return Response.json({ message: 'Not Found' }, { status: 404 });
      return upstream(input, init);
    }));
    const human = github.git(['commit-tree', github.git(['rev-parse', 'main^{tree}']).trim(), '-p', base], 'Private commit after revocation\n').trim();
    github.git(['update-ref', 'refs/heads/main', human, base]);
    await harness.trunk.githubEvent(harness.repository, { name: 'push', ref: 'refs/heads/main', sha: human });
    ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    expect(harness.head()).toBe(base);
    expect(github.pulls).toHaveLength(0);
  }, 60_000);

  it('follows commits pushed to GitHub directly before composing', async () => {
    const { harness, github, base } = await linked();
    const human = github.git(['commit-tree', github.git(['rev-parse', 'main^{tree}']).trim(), '-p', base], 'Hotfix pushed by a person\n').trim();
    github.git(['update-ref', 'refs/heads/main', human, base]);
    const item = ok(await harness.submit('atlas', change('Add b', 'src/b.ts', 'export const b = 2;\n', base)));
    await harness.settle(2);
    await wake(harness);
    expect(ok(await harness.shard(parseInt(item.id[3], 16)).get(item.id)).status).toBe('landed');
    expect(github.git(['rev-parse', 'main~1']).trim()).toBe(human);
    expect(harness.head()).toBe(github.git(['rev-parse', 'main']).trim());
  }, 60_000);
});

describe('mirroring to GitHub', () => {
  it('pushes every landing to GitHub and stops if someone pushes there directly', async () => {
    const { harness, github, base } = await linked('mirror');
    ok(await harness.submit('scribe', change('Docs', 'docs/guide.md', '# Guide\n', base)));
    await harness.settle(3);
    expect(github.git(['rev-parse', 'main']).trim()).toBe(harness.head());
    const direct = github.git(['commit-tree', github.git(['rev-parse', 'main^{tree}']).trim(), '-p', harness.head()], 'Direct push\n').trim();
    github.git(['update-ref', 'refs/heads/main', direct]);
    ok(await harness.submit('scribe', change('More docs', 'docs/more.md', '# More\n', harness.head())));
    await harness.settle(3);
    expect(github.git(['rev-parse', 'main']).trim()).toBe(direct);
    expect((await harness.trunk.status(harness.repository)).github).toMatchObject({ status: 'diverged', message: expect.stringContaining('pushed to GitHub directly') });
  }, 60_000);
});

describe('linking GitHub', () => {
  it('refuses a GitHub history without trunk in it, and reports a failed comparison as GitHub failing', async () => {
    harness = await changeHarness();
    const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
    Object.assign(harness.env, github.env);
    harness.git.native(['update-ref', 'refs/heads/main', harness.git.commitTree({ 'README.md': '# Relay\n' })]);
    // GitHub's main has a history of its own, without Braid's commit in it.
    github.git(['update-ref', 'refs/heads/main', github.git(['commit-tree', github.git(['mktree'], '').trim()], 'Unrelated\n').trim()]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    expect(await harness.trunk.linkGitHub(harness.repository, github.link('pull-requests'))).toEqual({ ok: false, status: 409, error: expect.stringContaining('history is not part of this GitHub repository') });
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/compare/') ? Promise.resolve(new Response('{}', { status: 502 })) : answer(input, init));
    expect(await harness.trunk.linkGitHub(harness.repository, github.link('pull-requests'))).toEqual({ ok: false, status: 502, error: 'GitHub could not complete this request. Try again shortly.' });
    expect(await harness.trunk.githubLink(harness.repository)).toBeNull();
  }, 60_000);

  it('names the missing permissions when the app was installed read-only', async () => {
    harness = await changeHarness();
    const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
    Object.assign(harness.env, github.env);
    github.state.granted = { contents: 'read', metadata: 'read' };
    harness.git.native(['update-ref', 'refs/heads/main', harness.git.commitTree({ 'README.md': '# Relay\n' })]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    // An installation no other test uses, so no cached token answers for it.
    const link = (mode: 'pull-requests' | 'mirror') => ({ ...github.link(mode), installationId: 70 });
    expect(await harness.trunk.linkGitHub(harness.repository, link('pull-requests'))).toEqual({ ok: false, status: 403, error: expect.stringContaining('read access to pull requests, checks and statuses') });
    expect(await harness.trunk.linkGitHub(harness.repository, link('mirror'))).toEqual({ ok: false, status: 403, error: expect.stringContaining('read and write access to contents and pull requests') });
    expect(await harness.trunk.githubLink(harness.repository)).toBeNull();
  }, 60_000);

  it('writes to GitHub only while the person who linked it may push there, never on the App installation alone', async () => {
    harness = await changeHarness();
    const github = fakeGitHub({ root: harness.git.root, gitOrigin: harness.git.remote.replace(/\/repo\.git$/, '') });
    Object.assign(harness.env, github.env);
    // GitHub's repository is empty, so linking as a mirror pushes Braid's history there at once.
    const ahead = harness.git.commitTree({ 'README.md': '# Relay\n' });
    harness.git.native(['update-ref', 'refs/heads/main', ahead]);
    const githubMain = () => { try { return github.git(['rev-parse', '--verify', 'refs/heads/main']).trim(); } catch { return null; } };
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner' });
    // Anyone can read a public repository, and the App is installed on it, but its owner never let this person push.
    github.state.push = false;
    expect(await harness.trunk.linkGitHub(harness.repository, github.link('mirror'))).toEqual({ ok: false, status: 403, error: 'The person who linked acme/relay can no longer push to it on GitHub.' });
    const { pusher: _, ...legacy } = github.link('mirror');
    expect(await harness.trunk.linkGitHub(harness.repository, legacy)).toEqual({ ok: false, status: 403, error: 'Link acme/relay again so Braid can confirm who may push to it.' });
    expect(githubMain()).toBeNull();
    expect(await harness.trunk.githubLink(harness.repository)).toBeNull();
    // Someone who may push links it; once GitHub takes that away, Braid stops writing there.
    github.state.push = true;
    expect(await harness.trunk.linkGitHub(harness.repository, github.link('mirror'))).toMatchObject({ ok: true });
    expect(githubMain()).toBe(ahead);
    github.state.push = false;
    ok(await harness.submit('scribe', change('Docs', 'docs/guide.md', '# Guide\n', ahead)));
    await harness.settle(3);
    expect(githubMain()).toBe(ahead);
  }, 60_000);
});

describe('GitHub webhooks', () => {
  it('accepts only signed deliveries, ignores repeats and wakes every linked repository', async () => {
    const { createHmac } = await import('node:crypto');
    const { storageFixture } = await import('../test/storage');
    const { GitHubRepo, githubWebhook } = await import('../github/webhook');
    const events: unknown[] = [];
    const fixture = storageFixture();
    const env = { GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret', TRUNKS: { getByName: () => ({ githubEvent: async (repository: string, event: unknown) => { events.push({ repository, event }); } }) } } as never;
    const repo = new GitHubRepo(fixture.ctx, env);
    Object.assign(env, { GITHUB_REPOS: { getByName: () => repo } });
    repo.link('team:t:repository:w');
    const body = JSON.stringify({ action: 'completed', repository: { id: 99 }, check_suite: { head_sha: 'a'.repeat(40), pull_requests: [{ number: 3 }] } });
    const sign = (text: string, secret = 'webhook-secret') => `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`;
    const send = (signature: string, delivery = 'delivery-1') => githubWebhook(new Request('https://braid.example/api/github/webhook', { method: 'POST', body, headers: { 'x-github-event': 'check_suite', 'x-github-delivery': delivery, 'x-hub-signature-256': signature } }), env);
    expect((await send(sign(body, 'wrong'))).status).toBe(401);
    expect((await send('sha256=00')).status).toBe(401);
    const accepted = await send(sign(body));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ duplicate: false, repositories: 1 });
    expect(await (await send(sign(body))).json()).toMatchObject({ duplicate: true });
    expect(events).toEqual([{ repository: 'team:t:repository:w', event: { name: 'check_suite', action: 'completed', sha: 'a'.repeat(40), number: 3 } }]);
    fixture.db.close();
  });
});
