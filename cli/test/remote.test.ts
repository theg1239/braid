import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveCredentials } from '../src/config';
import { strict } from '../src/git';
import { braid, cleanup, fakeGit, json, repository, server, session, testContext } from './helpers';

afterEach(cleanup);

const origin = 'https://braid.example', url = `${origin}/git/ws_1.git`;
const CONNECTION = `braid_agent_${'c'.repeat(64)}`;
const signIn = (env: Record<string, string>) => saveCredentials(env, { origin, accessToken: CONNECTION, workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
const init = (repo: ReturnType<typeof repository>) => braid(['init', '--url', origin, '--workspace', 'ws_1'], { cwd: repo.root, env: repo.env });

describe('the braid remote', () => {
  it('is added by init with braid as its only credential helper, once however often init runs', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'First');
    for (let run = 0; run < 2; run++) expect((await init(repo)).exitCode).toBe(0);
    expect(repo.git(['remote', 'get-url', 'braid'])).toBe(url);
    expect(repo.git(['config', '--null', '--get-all', `credential.${url}.helper`]).split('\0')).toEqual(['', '!braid git-credential', '']);
    expect(repo.git(['config', '--get', `credential.${url}.useHttpPath`])).toBe('true');
    repo.git(['remote', 'set-url', 'braid', 'https://elsewhere.example/repo.git']);
    await init(repo);
    expect(repo.git(['remote', 'get-url', 'braid'])).toBe(url);
  });

  it('answers Git with the saved agent token for its repository, and nothing for anyone else', async () => {
    const repo = repository();
    signIn(repo.env);
    const ask = async (input: string, operation = 'get', env = repo.env) => braid(['git-credential', operation], { cwd: repo.root, env, input });
    expect((await ask('protocol=https\nhost=braid.example\npath=git/ws_1.git\n\n')).stdout).toBe(`username=x\npassword=${CONNECTION}\n`);
    expect((await ask('protocol=https\nhost=elsewhere.example\npath=git/ws_1.git\n')).stdout).toBe('');
    expect((await ask('protocol=http\nhost=braid.example\n')).stdout).toBe('');
    const unknown = await ask('protocol=https\nhost=braid.example\npath=git/ws_2.git\n');
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('braid: Not signed in to https://braid.example.');
    for (const operation of ['store', 'erase']) expect((await ask(`protocol=https\nhost=braid.example\npath=git/ws_1.git\nusername=x\npassword=${CONNECTION}\n`, operation)).stdout).toBe('');
    // A token from the environment goes only to the Braid this repository is linked to.
    const env = { ...repo.env, BRAID_ACCESS_TOKEN: 'braid_agent_from_environment_value', BRAID_WORKSPACE_ID: 'ws_1' };
    expect((await ask('protocol=https\nhost=braid.example\npath=git/ws_1.git\n', 'get', env)).stdout).toBe('');
    await init(repo);
    expect((await ask('protocol=https\nhost=braid.example\npath=git/ws_1.git\n', 'get', env)).stdout).toBe('username=x\npassword=braid_agent_from_environment_value\n');
  });

  it('installs a credential helper that still runs when the CLI was invoked through node', async () => {
    const repo = repository();
    expect((await braid(['init', '--url', origin, '--workspace', 'ws_1'], { cwd: repo.root, env: repo.env, self: ['node', '/path with spaces/braid.mjs'] })).exitCode).toBe(0);
    expect(repo.git(['config', '--get-all', `credential.${url}.helper`])).toContain("!node '/path with spaces/braid.mjs' git-credential");
  });

  it('takes submit --push: the same checks, then the commits and their notes over Git with the token kept out of arguments', async () => {
    const repo = repository();
    const base = repo.commit({ 'parser.ts': 'export const parse = () => null;\n' }, 'Start');
    const bare = join(repo.home, 'braid.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: repo.env });
    const git = fakeGit(repo.home, { [url]: bare }, `Opened change #7: ${origin}/pull/7`);
    const env = { ...repo.env, PATH: git.PATH, BRAID_MODEL: 'claude-opus-5-5', BRAID_SESSION: 's_run' };
    signIn(env);
    await braid(['init', '--url', origin, '--workspace', 'ws_1'], { cwd: repo.root, env });
    repo.git(['checkout', '-q', '-b', 'parser']);
    const tip = repo.commit({ 'parser.ts': 'export const parse = (text: string) => text.trim();\n' }, 'Trim input\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    const api = server({
      'POST /api/agent/session': session(),
      'POST /api/changes/checkout': () => json({ remote: 'https://git.example/repo.git', token: 'read-token-value', branch: 'main', head: base }),
      'GET /api/changes/7': () => json({ id: 'ch_0123456789abc', number: 7, title: 'Trim input', status: 'open', revision: 1 }),
      'GET /api/changes/ch_0123456789abc': () => json({ id: 'ch_0123456789abc', number: 7, title: 'Trim input', status: 'open', revision: 1 }),
    });
    expect((await braid(['submit', '--push', '--title', 'No'], { cwd: repo.root, env, fetch: api.fetch })).stderr).toContain('--push sends the commits over Git');
    const pushed = await braid(['submit', '--push'], { cwd: repo.root, env, fetch: api.fetch });
    expect(pushed.stderr).toBe(`remote: Opened change #7: ${origin}/pull/7\n`);
    expect(pushed.stdout).toBe('Pull request #7 · Trim input · open · revision 1\nNext, wait until it merges or needs changes:\n  braid wait\n');
    const calls = git.calls();
    expect(calls.map(call => call.args.slice(call.args.indexOf('push') + 1))).toEqual([[url, 'HEAD:refs/for/main', 'refs/notes/braid:refs/notes/braid']]);
    for (const call of calls) {
      expect(call.password).toBe(CONNECTION);
      expect(call.args.join(' ')).not.toContain(CONNECTION);
      expect(call.args).toEqual(expect.arrayContaining(['credential.helper=', `core.hooksPath=/dev/null`]));
    }
    expect(execFileSync('git', ['rev-parse', 'refs/for/main'], { cwd: bare, encoding: 'utf8' }).trim()).toBe(tip);
    expect(JSON.parse(execFileSync('git', ['notes', '--ref=refs/notes/braid', 'show', tip], { cwd: bare, encoding: 'utf8' }))).toMatchObject({ v: 1, agent: { model: 'claude-opus-5-5', session: 's_run' } });
    expect(api.sent.filter(request => request.method === 'POST' && request.path === '/api/changes')).toHaveLength(0);
    // The branch now follows change #7.
    expect((await braid(['status'], { cwd: repo.root, env, fetch: api.fetch })).stdout).toContain('Pull request #7 · Trim input · open');
  });

  it('names a hardened Git command that failed, and withholds its output only when a token was involved', () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'a\n' }, 'First');
    writeFileSync(join(repo.root, 'a.txt'), 'b\n');
    const { context } = testContext({ cwd: repo.root, env: repo.env });
    expect(() => strict(context, ['diff', '--quiet'])).toThrow('git diff failed: exit 1');
    expect(() => strict(context, ['diff', '--quiet'], { token: CONNECTION })).toThrow('Its output is withheld because it involved a Braid token.');
  });

  it('never answers a credential request for another repository or a non-Braid path with the environment token', async () => {
    const repo = repository();
    await init(repo);
    const env = { ...repo.env, BRAID_ACCESS_TOKEN: 'braid_agent_environment_value', BRAID_WORKSPACE_ID: 'ws_1' };
    for (const path of ['git/ws_2.git', 'other.git', 'git/ws_1.git/elsewhere']) {
      const answer = await braid(['git-credential', 'get'], { cwd: repo.root, env, input: `protocol=https\nhost=braid.example\npath=${path}\n` });
      expect(answer.stdout).toBe('');
      expect(answer.stderr).not.toContain(env.BRAID_ACCESS_TOKEN);
    }
  });
});
