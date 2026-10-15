import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reviewComments } from '../test/review-comments';

const cli = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
const origin = 'https://braid.example', remote = 'https://git.example/trunk.git';
let root: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'braid-change-cli-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const env = () => ({ ...process.env, BRAID_CONFIG_HOME: join(root, 'config'), BRAID_ACCESS_TOKEN: `braid_agent_${'a'.repeat(64)}`, BRAID_WORKSPACE_ID: 'workspace-one' });
function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
const put = (dir: string, path: string, content: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };

it.each(['wait', 'status'])('the downloadable helper’s %s prints unresolved review comments', async command => {
  const dir = join(root, 'comments');
  mkdirSync(dir);
  git(dir, 'init', '--template=', '--initial-branch=main');
  mkdirSync(join(dir, '.braid'), { mode: 0o700 });
  writeFileSync(join(dir, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'workspace-one', base: 'a'.repeat(40), changeId: 'ch_3abcdefabcdef', revision: 1 }), { mode: 0o600 });
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ accessToken: 'braid_at_test.signature', expiresAt: new Date(Date.now() + 300_000).toISOString() }))
    .mockResolvedValueOnce(Response.json({ number: 42, title: 'Fix the parser', revision: 2, status: 'revise', comments: reviewComments }));
  const log = vi.fn();
  await cli.main(['change', command, '--dir', dir], { env: env(), fetch, log });
  const text = log.mock.calls.map(call => call[0]).join('\n');
  expect(text).toContain('Unresolved review comments:');
  expect(text).toContain('src/parser.ts:14 (RIGHT; revision 1)');
  expect(text).toContain('Handle **empty input** before parsing.');
  expect(text).toContain('Reply to rc_open by GPT-6 Astra for @maya');
  expect(text).toContain('src/retry.ts:6 (LEFT, Outdated; revision 1)');
  expect(text).not.toContain('Already addressed.');
});

it('starts on trunk, submits a change, rebases after trunk moves and submits the next revision', async () => {
  // A local upstream stands in for the Artifacts trunk; the CLI's Git runner maps the remote to it.
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '--template=', '--initial-branch=main');
  put(upstream, 'src/router.ts', "export const routes = ['/health'];\n");
  put(upstream, 'README.md', '# Relay\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Base');
  const base = git(upstream, 'rev-parse', 'HEAD');
  const runner = vi.fn((args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; token?: string } = {}) =>
    Buffer.from(execFileSync('git', ['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.test', '-c', 'commit.gpgsign=false', ...args.map(arg => arg === remote ? upstream : arg)], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })));
  const requests: { method: string; path: string; body?: Record<string, unknown>; key?: string | null }[] = [];
  let failSubmissions = 0, status = 'open';
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname + url.search, body, key: new Headers(init.headers).get('idempotency-key') });
    const auth = new Headers(init.headers).get('authorization') ?? '';
    if (url.pathname === '/api/agent/session') return Response.json({ accessToken: 'braid_at_test.signature', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (!auth.startsWith('Bearer braid_at_')) return Response.json({ error: 'Use an access token.' }, { status: 401 });
    if (url.pathname === '/api/changes/checkout') return Response.json({ remote, token: 'read-only-token', branch: 'main', head: git(upstream, 'rev-parse', 'HEAD') });
    if (url.pathname === '/api/changes' && method === 'POST') {
      if (failSubmissions-- > 0) return new Response('unavailable', { status: 503 });
      return Response.json({ id: 'ch_3abcdefabcdef', number: 42, title: body.title, status: 'open', revision: 1, next: '0 of 1 reviewer approval for revision 1.', overlaps: [{ changeId: 'ch_1aaaaaaaaaaaa', number: 41, paths: ['src/router.ts'] }] }, { status: 201 });
    }
    if (url.pathname === '/api/changes/ch_3abcdefabcdef/revisions') return Response.json({ id: 'ch_3abcdefabcdef', number: 42, title: 'Add metrics route', status: 'open', revision: 2 });
    if (url.pathname === '/api/changes/ch_3abcdefabcdef') return Response.json({ id: 'ch_3abcdefabcdef', number: 42, title: 'Add metrics route', status, revision: 2, ...(status === 'landed' ? { landedCommit: 'c'.repeat(40) } : {}) });
    if (url.pathname === '/api/coordination') return Response.json({ 'src/router.ts': [{ changeId: 'ch_1aaaaaaaaaaaa', number: 41, title: 'Add health detail', status: 'queued', author: 'Sable' }] });
    return Response.json({ error: 'Not found.' }, { status: 404 });
  });
  const log = vi.fn();
  const options = { env: env(), fetch, git: runner, log };
  const dir = join(root, 'work');
  await cli.main(['change', 'start', '--url', origin, '--dir', dir], options);
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(base);
  expect(JSON.parse(readFileSync(join(dir, '.braid/change.json'), 'utf8'))).toMatchObject({ origin, workspaceId: 'workspace-one', base });
  expect(git(dir, 'status', '--porcelain')).toBe('');

  await cli.main(['change', 'touching', '--dir', dir, '--paths', 'src/router.ts,README.md'], options);
  expect(log).toHaveBeenCalledWith('src/router.ts: #41 Add health detail (Sable, queued)');

  put(dir, 'src/router.ts', "export const routes = ['/health', '/metrics'];\n");
  git(dir, 'commit', '-am', 'Add metrics route');
  // An unconfirmed response keeps the exact payload and key for --retry.
  failSubmissions = 1;
  await expect(cli.main(['change', 'submit', '--dir', dir, '--title', 'Add metrics route', '--summary', 'Expose /metrics.'], options)).rejects.toThrow(/unconfirmed/);
  const pending = requests.filter(request => request.path === '/api/changes').at(-1)!;
  await cli.main(['change', 'submit', '--dir', dir, '--retry'], options);
  const sent = requests.filter(request => request.path === '/api/changes').at(-1)!;
  expect(sent.key).toBe(pending.key);
  expect(sent.body).toEqual({ title: 'Add metrics route', summary: 'Expose /metrics.', baseCommit: base, files: [{ path: 'src/router.ts', content: "export const routes = ['/health', '/metrics'];\n" }] });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Pull request #42 · Add metrics route · open · revision 1'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Also active on the same files: #41'));

  // Trunk moves; the agent fetches it, rebases, and the next revision is based on the new trunk.
  put(upstream, 'README.md', '# Relay\n\nWebhooks for Workers.\n');
  git(upstream, 'commit', '-am', 'Docs landed by someone else');
  const moved = git(upstream, 'rev-parse', 'HEAD');
  await cli.main(['change', 'sync', '--dir', dir], options);
  expect(JSON.parse(readFileSync(join(dir, '.braid/change.json'), 'utf8')).nextBase).toBe(moved);
  git(dir, 'rebase', moved);
  await cli.main(['change', 'submit', '--dir', dir, '--title', 'Add metrics route', '--summary', 'Expose /metrics, rebased.'], options);
  const revision = requests.filter(request => request.path === '/api/changes/ch_3abcdefabcdef/revisions').at(-1)!;
  expect(revision.body).toMatchObject({ baseCommit: moved, previousRevision: 1, files: [{ path: 'src/router.ts', content: "export const routes = ['/health', '/metrics'];\n" }] });
  expect(JSON.parse(readFileSync(join(dir, '.braid/change.json'), 'utf8'))).toMatchObject({ base: moved, revision: 2, changeId: 'ch_3abcdefabcdef' });

  status = 'landed';
  const landed = await cli.main(['change', 'wait', '--dir', dir, '--timeout', '30'], options);
  expect(landed).toMatchObject({ status: 'landed' });
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`Merged as ${'c'.repeat(40)}.`));
  // Tokens never reach arguments, files or logs.
  expect(JSON.stringify(log.mock.calls)).not.toContain('read-only-token');
  expect(readFileSync(join(dir, '.braid/change.json'), 'utf8')).not.toContain('braid_at_');
}, 30_000);

it('refuses to submit uncommitted work or work that does not descend from its base', async () => {
  const dir = join(root, 'work');
  mkdirSync(dir);
  git(dir, 'init', '--template=', '--initial-branch=main');
  put(dir, 'a.txt', 'a\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Base');
  const base = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, '.braid'), { mode: 0o700 });
  writeFileSync(join(dir, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'workspace-one', base }), { mode: 0o600 });
  put(dir, '.git/info/exclude', '.braid/\n');
  const options = { env: env(), fetch: vi.fn(), log: vi.fn() };
  put(dir, 'a.txt', 'changed\n');
  await expect(cli.main(['change', 'submit', '--dir', dir, '--title', 'T', '--summary', 'S'], options)).rejects.toThrow(/Commit the work/);
  expect(options.fetch).not.toHaveBeenCalled();
});
