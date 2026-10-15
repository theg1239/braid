import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { braid, cleanup, environment, githubCli, json, server, session, temporary } from './helpers';

afterEach(cleanup);

const origin = 'https://braid.example';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CONNECTION = `braid_agent_${'c'.repeat(64)}`;

/** A clock that only moves when braid sleeps, so polling runs instantly and its waits can be checked. */
function clock() {
  let now = Date.parse('2026-10-08T12:00:00Z');
  const waits: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; }, waits };
}

const request = () => json({ deviceCode: 'd'.repeat(72), userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 600, interval: 5 }, 201);
const approved = (scope = 'work') => () => json({ accessToken: CONNECTION, tokenType: 'Bearer', expiresAt: '2026-10-15T12:00:00.000Z', workspaceId: 'ws_1', scope });

describe('braid login', () => {
  it('polls until the owner approves, honouring Retry-After, and saves the approval owner-only where braid.mjs keeps it', async () => {
    const home = temporary(), env = environment(home), time = clock();
    const braidServer = server({
      'POST /api/agent/requests': request,
      'POST /api/agent/token': [() => json({ status: 'pending' }, 202, { 'retry-after': '8' }), () => json({ status: 'slow_down' }, 429, { 'retry-after': '7' }), () => json({ status: 'pending' }, 202), approved()],
    });
    const result = await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: braidServer.fetch, ...time });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Approve this connection in Braid: ${origin}/?connect=ABCD2345\nCode: ABCD2345`);
    expect(result.stdout).toContain('Signed in to https://braid.example for repository ws_1 until 2026-10-15.');
    expect(result.stdout + result.stderr).not.toContain(CONNECTION);
    expect(result.stdout + result.stderr).not.toContain('d'.repeat(72));
    expect(braidServer.sent[0]).toMatchObject({ method: 'POST', path: '/api/agent/requests', body: { name: 'Braid CLI', scope: 'work' } });
    expect(braidServer.sent.slice(1).map(sent => sent.body)).toEqual(Array(4).fill({ deviceCode: 'd'.repeat(72) }));
    // Five seconds, then the eight the pending answer asks for, then a slow-down adds five to the interval: ten, and ten again.
    expect(time.waits).toEqual([5000, 8000, 10_000, 10_000]);
    const folder = join(env.BRAID_CONFIG_HOME, sha256(origin)), file = join(folder, `${sha256('ws_1')}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ origin, accessToken: CONNECTION, workspaceId: 'ws_1', expiresAt: '2026-10-15T12:00:00.000Z' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it('stops when the request is denied or expires, and refuses read-only approval', async () => {
    const home = temporary(), env = environment(home);
    const denied = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': () => json({ status: 'denied' }, 410) });
    const first = await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: denied.fetch, ...clock() });
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain('The request expired or was denied.');
    const pending = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': () => json({ status: 'pending' }, 202) });
    const second = await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: pending.fetch, ...clock() });
    expect(second.stderr).toContain('The request expired before anyone approved it.');
    expect(pending.sent.length).toBeLessThanOrEqual(121);
    const readOnly = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': approved('read') });
    expect((await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: readOnly.fetch, ...clock() })).stderr).toContain('braid needs work access');
    expect(existsSync(join(env.BRAID_CONFIG_HOME, sha256(origin)))).toBe(false);
  });

  it('refuses an approval page on another origin', async () => {
    const home = temporary(), env = environment(home);
    const elsewhere = server({ 'POST /api/agent/requests': () => json({ deviceCode: 'd'.repeat(72), userCode: 'ABCD2345', verificationUri: 'https://evil.example/?connect=ABCD2345', expiresIn: 600, interval: 5 }, 201) });
    const result = await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: elsewhere.fetch, ...clock() });
    expect(result.stderr).toContain('sign-in details braid will not use');
    expect(elsewhere.sent).toHaveLength(1);
  });

  it('shows who braid acts as without printing a token or email, and forgets the approval on logout', async () => {
    const home = temporary(), env = environment(home), time = clock();
    const braidServer = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': approved(), 'POST /api/agent/session': session() });
    await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: braidServer.fetch, ...time });
    const whoami = await braid(['whoami'], { cwd: home, env, fetch: braidServer.fetch, now: time.now });
    expect(whoami.exitCode).toBe(0);
    expect(whoami.stdout.trimEnd().split('\n')[1]).toMatch(/^https:\/\/braid\.example\s+ws_1\s+Braid CLI\s+Ishaan\s+2026-10-15$/);
    expect(whoami.stdout).not.toContain('@');
    expect(whoami.stdout).not.toContain('braid_agent_');
    expect(whoami.stdout).not.toContain('braid_at_');
    expect(braidServer.sent.at(-1)).toMatchObject({ path: '/api/agent/session', headers: { authorization: `Bearer ${CONNECTION}` } });
    const logout = await braid(['logout'], { cwd: home, env });
    expect(logout.stdout).toContain('Signed out of https://braid.example.');
    expect((await braid(['whoami'], { cwd: home, env })).stderr).toContain('Not signed in');
  });
});

describe('braid login for a person new to Braid', () => {
  const GITHUB = `gho_${'g'.repeat(36)}`;
  const connected = (repository = 'octo/web') => () => json({ accessToken: CONNECTION, tokenType: 'Bearer', expiresAt: '2026-10-15T12:00:00.000Z', workspaceId: 'ws_1', scope: 'work', repository, account: { username: 'octo' } }, 201);

  it('signs in with the GitHub CLI account, sends its token only to Braid and prints neither secret', async () => {
    const home = temporary(), env = environment(home, { PATH: githubCli(home, GITHUB) }), time = clock();
    const braidServer = server({ 'POST /api/agent/github': connected() });
    const result = await braid(['login', '--url', origin], { cwd: home, env, fetch: braidServer.fetch, ...time });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Connected to ${origin}/octo/web.\nSigned in to ${origin} for repository ws_1 until 2026-10-15.\n`);
    expect(braidServer.sent).toEqual([expect.objectContaining({ path: '/api/agent/github', body: { token: GITHUB, name: 'Braid CLI', scope: 'work' } })]);
    expect(result.stdout + result.stderr).not.toContain(GITHUB);
    expect(result.stdout + result.stderr).not.toContain(CONNECTION);
    const saved = readFileSync(join(env.BRAID_CONFIG_HOME, sha256(origin), `${sha256('ws_1')}.json`), 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ origin, accessToken: CONNECTION, workspaceId: 'ws_1' });
    expect(saved).not.toContain(GITHUB);
  });

  it('lists the repositories to choose from, and connects the one named', async () => {
    const home = temporary(), env = environment(home, { PATH: githubCli(home, GITHUB) });
    const choose = server({ 'POST /api/agent/github': () => json({ code: 'repository_required', error: 'Name one of these repositories with repository: "owner/repo".', repositories: ['octo/web', 'octo/docs'] }, 409) });
    const refused = await braid(['login', '--url', origin], { cwd: home, env, fetch: choose.fetch, ...clock() });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('Repositories: octo/web, octo/docs. Run braid login again with --repository OWNER/REPO.');
    const named = server({ 'POST /api/agent/github': connected('octo/docs') });
    expect((await braid(['login', '--url', origin, '--repository', 'octo/docs'], { cwd: home, env, fetch: named.fetch, ...clock() })).exitCode).toBe(0);
    expect(named.sent[0].body).toMatchObject({ repository: 'octo/docs' });
  });

  it('reports GitHub errors without browser fallback, and --link skips GitHub', async () => {
    const home = temporary(), env = environment(home, { PATH: githubCli(home, GITHUB) });
    const braidServer = server({ 'POST /api/agent/github': () => json({ code: 'github_email', error: 'GitHub did not share a verified email address.' }, 403), 'POST /api/agent/requests': request, 'POST /api/agent/token': approved() });
    const result = await braid(['login', '--url', origin], { cwd: home, env, fetch: braidServer.fetch, ...clock() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Braid did not connect with GitHub: GitHub did not share a verified email address.');
    expect(braidServer.sent.map(sent => sent.path)).toEqual(['/api/agent/github']);
    const linked = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': approved() });
    expect((await braid(['login', '--url', origin, '--link'], { cwd: home, env, fetch: linked.fetch, ...clock() })).exitCode).toBe(0);
    expect(linked.sent.map(sent => sent.path)).toEqual(['/api/agent/requests', '/api/agent/token']);
    const signedOut = temporary(), quiet = server({ 'POST /api/agent/requests': request, 'POST /api/agent/token': approved() });
    const plain = await braid(['login', '--url', origin], { cwd: signedOut, env: environment(signedOut), fetch: quiet.fetch, ...clock() });
    expect(plain.stderr).toContain('run braid login --email ADDRESS');
  });

  it('signs in with a code Braid emails, kept owner-only between the two runs', async () => {
    const home = temporary(), env = environment(home);
    const flowId = '0b5c6f0e-3c9a-4a8e-9b1d-2f6f1a0c4d21';
    const braidServer = server({
      'POST /api/agent/email/start': () => json({ flowId, expiresAt: '2026-10-08T12:10:00.000Z', scope: 'work' }, 201),
      'POST /api/agent/email/verify': [() => json({ error: 'That code is invalid or expired.' }, 401), connected()],
    });
    const asked = await braid(['login', '--url', origin, '--email', 'maya@example.test'], { cwd: home, env, fetch: braidServer.fetch, ...clock() });
    expect(asked.exitCode).toBe(0);
    expect(asked.stdout).toBe(`Braid emailed the person a code. Ask them for it, then run: braid login --url ${origin} --email ADDRESS --code CODE\n`);
    const file = join(env.BRAID_CONFIG_HOME, sha256(origin), `email-${sha256('maya@example.test')}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const wrong = await braid(['login', '--url', origin, '--email', 'maya@example.test', '--code', 'WRONG123'], { cwd: home, env, fetch: braidServer.fetch, ...clock() });
    expect(wrong.stderr).toContain('That code is invalid or expired.');
    const right = await braid(['login', '--url', origin, '--email', 'Maya@Example.test', '--code', 'ABCD-2345'], { cwd: home, env, fetch: braidServer.fetch, ...clock() });
    expect(right.exitCode).toBe(0);
    expect(braidServer.sent.at(-1)).toMatchObject({ path: '/api/agent/email/verify', body: { flowId, code: 'ABCD-2345', name: 'Braid CLI' } });
    expect(existsSync(file)).toBe(false);
    expect((await braid(['login', '--url', origin, '--code', 'ABCD2345'], { cwd: home, env, ...clock() })).stderr).toContain('--code goes with the --email');
  });
});
