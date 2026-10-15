import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { braid, cleanup, environment, fakeGit, json, repository, server, session, type Sent } from './helpers';
import { reviewComments } from '../../worker/test/review-comments';

afterEach(cleanup);

const origin = 'https://braid.example';
const link = `${origin}/tasks/mission-one?workspace=workspace-one`;
const CONNECTION = `braid_agent_${'a'.repeat(64)}`;
const ARTIFACT = 'temporary-artifacts-password';
const REMOTE = 'https://git.example/repo';
const [FIRST, SECOND] = ['c'.repeat(40), 'd'.repeat(40)];
const missionPath = (action: string) => `/api/missions/mission-one/agents/coder/${action}`;

const details = (baseCommit: string, extra: Record<string, unknown> = {}) => ({ missionId: 'mission-one', agentId: 'coder', title: 'Change the answer', intent: 'Update the requested behavior.', baseCommit, previousCommit: null, branch: 'main', remote: REMOTE, token: ARTIFACT, scope: ['src/'], context: [], ...extra });
const snapshot = (baseCommit: string, status = 'queued', missionStatus = 'running') => ({ missions: [{ id: 'mission-one', source: 'live', execution: 'local', status: missionStatus, baseCommit, agents: [{ id: 'coder', status }] }] });
const sentTo = (sent: Sent[], path: string) => sent.filter(request => request.method === 'POST' && request.path === path);

/** Git as an agent uses it in its checkout. */
function work(dir: string, env: Record<string, string>, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', ...args], { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' }).trim();
  run('add', '--all');
  run('commit', '-q', '-m', message);
  return run('rev-parse', 'HEAD');
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const head = (dir: string, env: Record<string, string>) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();

/** The repository the task is cut from, a mocked Git remote serving it, and an environment with the agent's approval. */
function fixture() {
  const src = repository();
  const base = src.commit({ 'src/main.ts': 'export const answer = 1;\n' }, 'Base');
  const git = fakeGit(src.home, { [REMOTE]: src.root });
  const env = environment(src.home, { BRAID_ACCESS_TOKEN: CONNECTION, BRAID_WORKSPACE_ID: 'workspace-one', PATH: git.PATH });
  return { src, base, git, env, home: src.home, dir: join(src.home, 'task') };
}

/** A task started in a new checkout, with Braid answering `routes` too. */
async function started(routes: Parameters<typeof server>[0] = {}) {
  const f = fixture();
  const api = server({ 'GET /api/state': () => json(snapshot(f.base)), [`POST ${missionPath('checkout')}`]: () => json(details(f.base)), ...routes });
  const result = await braid(['task', 'start', link, '--dir', f.dir], { cwd: f.home, env: f.env, fetch: api.fetch });
  expect(result.stderr).toBe('');
  return { ...f, api };
}

describe('braid task start', () => {
  it('refreshes unresolved review comments in the task brief when the agent resumes', async () => {
    const f = fixture();
    let comments = reviewComments;
    const api = server({ 'GET /api/state': () => json(snapshot(f.base)), [`POST ${missionPath('checkout')}`]: () => json(details(f.base, { reviewComments: comments, pullRequest: { id: 'ch_0123456789abc', number: 73, status: 'open', next: 'Waiting on #51', dependsOn: [{ id: 'ch_1123456789abc', number: 51, status: 'open' }] } })) });
    const started = await braid(['task', 'start', link, '--dir', f.dir], { cwd: f.home, env: f.env, fetch: api.fetch });
    expect(started.stderr).toBe('');
    const brief = read(f.dir, '.braid/TASK.md');
    expect(brief).toContain('## Pull request #73');
    expect(brief).toContain('Waiting on #51');
    expect(brief).toContain('Depends on #51');
    expect(brief).toContain('## Unresolved review comments');
    expect(brief).toContain('src/parser.ts:14 (RIGHT; revision 1)');
    expect(brief).toContain('Handle **empty input** before parsing.');
    expect(brief).toContain('GPT-6 Astra for @maya');
    expect(brief).not.toContain('Already addressed.');
    comments = [];
    expect((await braid(['task', 'resume'], { cwd: f.dir, env: f.env, fetch: api.fetch })).stderr).toBe('');
    expect(read(f.dir, '.braid/TASK.md')).not.toContain('Handle **empty input**');
  });

  it('clones the task at its base, pins it, and keeps every token off disk and out of arguments', async () => {
    const { dir, base, git, env, api } = await started();
    expect(api.sent.map(request => `${request.method} ${request.path}`)).toEqual(['GET /api/state', `POST ${missionPath('checkout')}`]);
    expect(api.sent[1].headers).toMatchObject({ authorization: `Bearer ${CONNECTION}`, 'x-braid-workspace': 'workspace-one' });
    expect(head(dir, env)).toBe(base);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: dir, env, encoding: 'utf8' }).trim()).toBe('');
    const [clone] = git.calls();
    expect(clone.args).toEqual(expect.arrayContaining(['clone', '--no-checkout', REMOTE]));
    expect(clone.password).toBe(ARTIFACT);
    expect(clone.args.join(' ')).not.toContain(ARTIFACT);
    expect(JSON.parse(read(dir, '.braid/task.json'))).toEqual({ url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', baseCommit: base, scope: ['src/'], submissionMode: 'commits' });
    expect(statSync(join(dir, '.braid/task.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.braid')).mode & 0o777).toBe(0o700);
    for (const path of ['.git/config', '.braid/task.json', '.braid/TASK.md']) for (const secret of [ARTIFACT, CONNECTION]) expect(read(dir, path)).not.toContain(secret);
    const brief = read(dir, '.braid/TASK.md');
    for (const text of ['# Change the answer', `Base commit: ${base}`, 'submit sends committed work', '`braid task submit --summary \'What changed\'`', '`braid task update`', '`braid task wait`', `\`braid connect --url ${origin}\``, '`braid task resume`', '`braid task submit --retry`']) expect(brief).toContain(text);
    expect(read(dir, '.git/info/exclude')).toContain('.braid/');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' })).toBe('');
  });

  it('resumes the same checkout when run again, and never adopts a different task', async () => {
    const { dir, env, home, api } = await started();
    const again = await braid(['task', 'start', link, '--dir', dir], { cwd: home, env, fetch: api.fetch });
    expect(again.stdout).toBe('Renewed the checkout for task mission-one, agent coder. Continue the task, run checks, and submit the result.\n');
    const other = await braid(['task', 'start', `${origin}/tasks/mission-two`, '--dir', dir], { cwd: home, env, fetch: api.fetch });
    expect(other.stderr).toContain('This directory belongs to a different task.');
  });

  it('binds a clean checkout at the base without cloning, and refuses one with work of its own before claiming the task', async () => {
    for (const kind of ['clean', 'untracked', 'edited', 'committed'] as const) {
      const f = fixture();
      execFileSync('git', ['clone', '-q', f.src.root, f.dir], { env: f.env });
      if (kind === 'untracked') writeFileSync(join(f.dir, 'notes.txt'), 'mine\n');
      if (kind === 'edited') writeFileSync(join(f.dir, 'src/main.ts'), 'export const answer = 3;\n');
      if (kind === 'committed') work(f.dir, f.env, { 'src/main.ts': 'export const answer = 4;\n' }, 'Mine');
      const api = server({ 'GET /api/state': () => json(snapshot(f.base)), [`POST ${missionPath('checkout')}`]: () => json(details(f.base)) });
      const result = await braid(['task', 'start', link], { cwd: f.dir, env: f.env, fetch: api.fetch });
      if (kind === 'clean') {
        expect(result.stdout).toContain(`Checkout ready at ${f.dir}`);
        expect(f.git.calls()).toEqual([]);
        expect(JSON.parse(read(f.dir, '.braid/task.json'))).toMatchObject({ baseCommit: f.base, submissionMode: 'commits' });
      } else {
        expect(result.stderr).toContain('Use a clean checkout at the task\'s base');
        expect(api.sent.map(request => request.path)).toEqual(['/api/state']);
        expect(existsSync(join(f.dir, '.braid'))).toBe(false);
      }
    }
  });

  it('asks the owner to approve a connection when none is saved, then starts', async () => {
    const f = fixture();
    const env = { ...f.env, BRAID_ACCESS_TOKEN: '', BRAID_WORKSPACE_ID: '' };
    const api = server({
      'POST /api/agent/requests': () => json({ deviceCode: 'd'.repeat(72), userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 600, interval: 5 }, 201),
      'POST /api/agent/token': () => json({ accessToken: CONNECTION, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), workspaceId: 'workspace-one', scope: 'work' }),
      'GET /api/state': () => json(snapshot(f.base)), [`POST ${missionPath('checkout')}`]: () => json(details(f.base)),
    });
    const result = await braid(['task', 'start', link, '--dir', f.dir], { cwd: f.home, env, fetch: api.fetch });
    expect(result.stdout).toContain(`Approve this connection in Braid: ${origin}/?connect=ABCD2345`);
    expect(result.stdout).toContain(`Checkout ready at ${f.dir}`);
    expect(result.stdout).not.toContain(CONNECTION);
  });

  it('leaves everything alone when the task already merged', async () => {
    const f = fixture();
    const api = server({ 'GET /api/state': () => json(snapshot(f.base, 'merged', 'merged')) });
    const result = await braid(['task', 'start', link, '--dir', f.dir], { cwd: f.home, env: f.env, fetch: api.fetch });
    expect(result.stdout).toBe(`This task was merged into main, so there is nothing left to submit. Local files were not changed. ${origin}/tasks/mission-one?workspace=workspace-one\n`);
    expect(existsSync(f.dir)).toBe(false);
  });
});

describe('braid task submit', () => {
  it('submits committed work with a saved key, replays identical work, and revises from the receipt', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: [() => json({ commit: FIRST }), () => json({ commit: SECOND })] });
    work(t.dir, t.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
    const first = await braid(['task', 'submit', '--summary', 'Change the answer'], { cwd: t.dir, env: t.env, fetch: t.api.fetch });
    expect(first.stdout).toBe(`Submitted proposal ${FIRST} for review. Tests are agent-reported and unverified.\nNext, wait until it merges or needs changes:\n  braid task wait\n`);
    const [sent] = sentTo(t.api.sent, missionPath('submit'));
    expect(sent.body).toEqual({ baseCommit: t.base, previousCommit: null, summary: 'Change the answer', rationale: 'Change the answer', files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });
    expect(sent.headers['idempotency-key']).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
    const receipt = JSON.parse(read(t.dir, '.braid/submission.json'));
    expect(receipt).toMatchObject({ status: 'complete', commit: FIRST, key: sent.headers['idempotency-key'] });
    expect(JSON.parse(read(t.dir, '.braid/task.json')).previousCommit).toBe(FIRST);

    expect((await braid(['task', 'submit'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stdout).toContain(`Previously submitted proposal ${FIRST} for review.`);
    expect(sentTo(t.api.sent, missionPath('submit'))).toHaveLength(1);

    work(t.dir, t.env, { 'src/main.ts': 'export const answer = 3;\n' }, 'Answer three');
    const revised = await braid(['task', 'submit'], { cwd: t.dir, env: t.env, fetch: t.api.fetch });
    expect(revised.stdout).toContain(`Submitted proposal ${SECOND} for review, replacing ${FIRST}.`);
    expect(sentTo(t.api.sent, missionPath('submit'))[1].body).toMatchObject({ previousCommit: FIRST, summary: 'Change the answer', files: [{ path: 'src/main.ts', content: 'export const answer = 3;\n' }] });
    expect(JSON.parse(read(t.dir, `.braid/submissions/${receipt.key}.json`)).body).toBe(receipt.body);
  });

  it('keeps an unconfirmed submission and resends its exact body and key', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: [() => json({ error: 'Busy.' }, 503), () => json({ commit: FIRST })] });
    work(t.dir, t.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
    const lost = await braid(['task', 'submit', '--summary', 'Change the answer'], { cwd: t.dir, env: t.env, fetch: t.api.fetch });
    expect(lost.stderr).toContain('The submission is unconfirmed (HTTP 503). Resend the saved payload and key with braid task submit --retry.');
    expect(JSON.parse(read(t.dir, '.braid/submission.json')).status).toBe('pending');
    expect((await braid(['task', 'submit', '--summary', 'Something else'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stderr).toContain('An earlier submission has no confirmed result.');
    expect((await braid(['task', 'submit', '--retry'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stdout).toContain(`Submitted proposal ${FIRST}`);
    const [original, resent] = sentTo(t.api.sent, missionPath('submit'));
    expect(resent.headers['idempotency-key']).toBe(original.headers['idempotency-key']);
    expect(resent.body).toEqual(original.body);
  });

  it('refuses uncommitted work, credentials and protected paths before sending anything', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: () => json({ commit: FIRST }) });
    writeFileSync(join(t.dir, 'src/draft.ts'), 'draft\n');
    expect((await braid(['task', 'submit', '--summary', 'Draft'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stderr).toContain('Commit the work you want reviewed before submitting.');
    work(t.dir, t.env, { 'src/draft.ts': 'const apiKey = "highly-sensitive-key";\n' }, 'Key');
    expect((await braid(['task', 'submit', '--summary', 'Key'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stderr).toContain('looks like it contains a credential');
    work(t.dir, t.env, { 'src/draft.ts': 'fine\n', 'src/.env': 'NAME=value\n' }, 'Env');
    expect((await braid(['task', 'submit', '--summary', 'Env'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stderr).toContain('src/.env is a protected or invalid path');
    expect(sentTo(t.api.sent, missionPath('submit'))).toHaveLength(0);
  });

  it('renews an expired task claim and resends the same body and key', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: [() => json({ error: 'The claim expired.' }, 403), () => json({ commit: FIRST })] });
    work(t.dir, t.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
    const result = await braid(['task', 'submit', '--summary', 'Change the answer'], { cwd: t.dir, env: t.env, fetch: t.api.fetch });
    expect(result.stdout).toContain('Renewed the checkout for task mission-one');
    expect(result.stdout).toContain(`Submitted proposal ${FIRST}`);
    const posted = t.api.sent.filter(request => request.method === 'POST').map(request => request.path);
    expect(posted.slice(-3)).toEqual([missionPath('submit'), missionPath('checkout'), missionPath('submit')]);
    const [original, resent] = sentTo(t.api.sent, missionPath('submit'));
    expect(resent.headers['idempotency-key']).toBe(original.headers['idempotency-key']);
  });

  it('records a refusal and lets a corrected submission through', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: [() => json({ error: 'Conflict.' }, 409), () => json({ commit: FIRST })] });
    work(t.dir, t.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
    const refused = await braid(['task', 'submit', '--summary', 'Change the answer'], { cwd: t.dir, env: t.env, fetch: t.api.fetch });
    expect(refused.stderr).toContain('Braid refused the submission (HTTP 409). No proposal was confirmed. The task or its latest proposal changed: run braid task resume, then submit again.');
    expect(JSON.parse(read(t.dir, '.braid/submission.json')).status).toBe('rejected');
    expect((await braid(['task', 'submit', '--summary', 'Corrected'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stdout).toContain(`Submitted proposal ${FIRST}`);
  });
});

describe('braid task update, resume, progress and wait', () => {
  it('fetches a newer main without touching the branch or files, and submits against it once integrated', async () => {
    const t = await started({ [`POST ${missionPath('submit')}`]: () => json({ commit: FIRST }) });
    const main = t.src.commit({ 'src/other.ts': 'export const other = 1;\n' }, 'Main moved');
    t.api.sent.length = 0;
    const routes = server({ [`POST ${missionPath('update')}`]: () => json(details(main)), [`POST ${missionPath('submit')}`]: () => json({ commit: FIRST }) });
    const mine = work(t.dir, t.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
    const updated = await braid(['task', 'update'], { cwd: t.dir, env: t.env, fetch: routes.fetch });
    expect(updated.stdout).toContain(`Fetched main at ${main} without changing your branch or files.`);
    expect(t.git.calls().at(-1)).toMatchObject({ args: expect.arrayContaining(['fetch', REMOTE, main]), password: ARTIFACT });
    expect(head(t.dir, t.env)).toBe(mine);
    expect(JSON.parse(read(t.dir, '.braid/task.json'))).toMatchObject({ baseCommit: main, acceptedBase: t.base });
    expect(read(t.dir, '.braid/TASK.md')).toContain(`Main moved after the accepted base ${t.base}.`);
    expect((await braid(['task', 'submit', '--summary', 'Too early'], { cwd: t.dir, env: t.env, fetch: routes.fetch })).stderr).toContain(`Merge or rebase the fetched main commit ${main} into this checkout`);
    execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.test', 'merge', '-q', '--no-edit', main], { cwd: t.dir, env: t.env });
    expect((await braid(['task', 'submit', '--summary', 'Integrated'], { cwd: t.dir, env: t.env, fetch: routes.fetch })).exitCode).toBe(0);
    expect(sentTo(routes.sent, missionPath('submit'))[0].body).toMatchObject({ baseCommit: main });
    expect(JSON.parse(read(t.dir, '.braid/task.json'))).not.toHaveProperty('acceptedBase');
  });

  it('refreshes task instructions on resume without changing local edits', async () => {
    const t = await started();
    writeFileSync(join(t.dir, 'src/main.ts'), 'export const answer = 9;\n');
    const api = server({ [`POST ${missionPath('checkout')}`]: () => json(details(t.base, { context: [{ title: 'Task instruction', body: 'Preserve the public API.', missionId: 'mission-one' }] })) });
    const resumed = await braid(['task', 'resume', '--dir', t.dir], { cwd: t.home, env: t.env, fetch: api.fetch });
    expect(resumed.exitCode).toBe(0);
    expect(read(t.dir, '.braid/TASK.md')).toContain('Preserve the public API.');
    expect(read(t.dir, 'src/main.ts')).toBe('export const answer = 9;\n');
    expect(head(t.dir, t.env)).toBe(t.base);
  });

  it('renews a reviewed task and records its latest proposal without changing work', async () => {
    const t = await started();
    const api = server({ [`POST ${missionPath('checkout')}`]: () => json(details(t.base, { previousCommit: FIRST })) });
    const resumed = await braid(['task', 'resume', '--dir', t.dir], { cwd: t.home, env: t.env, fetch: api.fetch });
    expect(resumed.stdout).toBe(`Renewed the checkout for task mission-one, agent coder. Proposal ${FIRST} is the latest result; submit again from this checkout to revise it.\n`);
    expect(JSON.parse(read(t.dir, '.braid/task.json')).previousCommit).toBe(FIRST);
    execFileSync('git', ['config', 'core.sparseCheckout', 'true'], { cwd: t.dir, env: t.env });
    expect((await braid(['task', 'resume'], { cwd: t.dir, env: t.env, fetch: api.fetch })).stderr).toContain('Agents need a full repository checkout.');
    expect(api.sent).toHaveLength(1);
  });

  it('shares progress, reusing the key when the same message is retried', async () => {
    const t = await started({ [`POST ${missionPath('progress')}`]: [() => json({ error: 'Busy.' }, 503), () => json({ ok: true })] });
    expect((await braid(['task', 'progress', '--message', 'Tests pass; checking the build.'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stderr).toContain('Progress was not confirmed (HTTP 503).');
    expect((await braid(['task', 'progress', '--message', 'Tests pass; checking the build.'], { cwd: t.dir, env: t.env, fetch: t.api.fetch })).stdout).toBe('Progress shared.\n');
    const [first, second] = sentTo(t.api.sent, missionPath('progress'));
    expect(second.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
    expect(second.body).toEqual({ message: 'Tests pass; checking the build.' });
  });

  it('waits for the change the task became and points back at task commands', async () => {
    const t = await started();
    const change = { id: 'ch_0123456789abc', number: 7, title: 'Change the answer', revision: 1, conflicts: [], checks: [], reviews: [], overlaps: [] };
    const api = server({
      'POST /api/agent/session': session('workspace-one'),
      'GET /api/changes?task=mission-one&limit=5': () => json({ items: [{ id: change.id }], nextCursor: null }),
      [`GET /api/changes/${change.id}`]: [() => json({ ...change, status: 'queued' }), () => json({ ...change, status: 'revise', conflicts: [{ path: 'src/main.ts', kind: 'content' }] })],
    });
    const result = await braid(['task', 'wait', '--dir', t.dir], { cwd: t.home, env: t.env, fetch: api.fetch });
    expect(result.stdout).toBe([
      'Pull request #7 · Change the answer · changes requested · revision 1',
      'Conflict (content) in src/main.ts',
      'Fetch main, merge it and resolve the conflicts, fix anything else listed, commit, then resubmit:',
      `  braid task update --dir ${t.dir}`,
      `  braid task submit --dir ${t.dir}`,
      '',
    ].join('\n'));
  });
});

describe('braid task checkout', () => {
  it('clones into a new directory whose submissions read the working tree', async () => {
    const f = fixture();
    const api = server({ [`POST ${missionPath('checkout')}`]: () => json(details(f.base)), [`POST ${missionPath('submit')}`]: () => json({ commit: FIRST }) });
    const args = ['task', 'checkout', '--url', origin, '--mission', 'mission-one', '--agent', 'coder', '--dir', f.dir];
    expect((await braid(args, { cwd: f.home, env: f.env, fetch: api.fetch })).stdout).toContain(`Checkout ready at ${f.dir}`);
    expect(JSON.parse(read(f.dir, '.braid/task.json'))).not.toHaveProperty('submissionMode');
    writeFileSync(join(f.dir, 'src/main.ts'), 'export const answer = 5;\n');
    writeFileSync(join(f.dir, 'src/added.ts'), 'export const added = true;\n');
    expect((await braid(['task', 'submit', '--summary', 'Uncommitted edits'], { cwd: f.dir, env: f.env, fetch: api.fetch })).exitCode).toBe(0);
    expect(sentTo(api.sent, missionPath('submit'))[0].body).toMatchObject({ files: [{ path: 'src/added.ts', content: 'export const added = true;\n' }, { path: 'src/main.ts', content: 'export const answer = 5;\n' }] });
    expect((await braid(args, { cwd: f.home, env: f.env, fetch: api.fetch })).stderr).toContain('Checkout needs a NEW directory');
  });
});

it.each([false, true])('uses the canonical task address and prints task links throughout the workflow (downloadable=%s)', async downloadable => {
  const helper = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
  const f = fixture(), dir = f.src.root, html_url = `${origin}/alice/notes/tasks/mission-one`;
  const pull_url = `${origin}/alice/notes/pull/12`;
  const api = server({
    'GET /api/repos/alice/notes': () => json({ workspaceId: 'workspace-one' }),
    'GET /api/state': () => json(snapshot(f.base)),
    [`POST ${missionPath('checkout')}`]: () => json(details(f.base, { html_url })),
    [`POST ${missionPath('update')}`]: () => json(details(f.base, { html_url })),
    [`POST ${missionPath('progress')}`]: () => json({ ok: true, html_url }),
    [`POST ${missionPath('submit')}`]: () => json({ commit: FIRST, html_url }),
    'POST /api/agent/session': session('workspace-one'),
    'GET /api/changes?task=mission-one&limit=5': () => json({ items: [{ id: 'ch_0123456789abc' }] }),
    'GET /api/changes/ch_0123456789abc': () => json({ id: 'ch_0123456789abc', number: 12, title: 'Task result', revision: 1, status: 'landed', html_url: pull_url }),
  });
  const run = async (args: string[]) => {
    if (!downloadable) {
      const result = await braid(['task', ...args, '--dir', dir], { cwd: dir, env: f.env, fetch: api.fetch });
      expect(result.stderr).toBe('');
      return result.stdout;
    }
    const output: string[] = [];
    await helper.main([...args, '--dir', dir], { env: f.env, fetch: api.fetch, log: (line: string) => output.push(line) });
    return output.join('\n');
  };
  expect(await run(['start', html_url])).toContain(html_url);
  expect(api.sent[0].path).toBe('/api/repos/alice/notes');
  expect(api.sent[0].headers.authorization).toBe(`Bearer ${CONNECTION}`);
  expect(await run(['resume'])).toContain(html_url);
  expect(await run(['update'])).toContain(html_url);
  expect(await run(['progress', '--message', 'Implementation finished'])).toContain(html_url);
  work(dir, f.env, { 'src/main.ts': 'export const answer = 2;\n' }, 'Answer two');
  expect(await run(['submit', '--summary', 'Answer two'])).toContain(html_url);
  expect(await run(['submit'])).toContain(html_url);
  expect(await run(['wait'])).toContain(pull_url);
});

it('rejects a canonical task address in another repository before reading or claiming a task', async () => {
  const f = fixture();
  const api = server({ 'GET /api/repos/alice/other': () => json({ workspaceId: 'another-repository' }) });
  const result = await braid(['task', 'start', `${origin}/alice/other/tasks/mission-one`, '--dir', f.dir], { cwd: f.home, env: f.env, fetch: api.fetch });
  expect(result.stderr).toContain('another repository');
  expect(api.sent).toHaveLength(1);
  expect(existsSync(f.dir)).toBe(false);
});
