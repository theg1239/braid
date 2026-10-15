import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validPath as domainValidPath } from './domain';
import { setupGuide } from '../http/setup-guide';
import { reviewComments } from '../test/review-comments';

const cli = await import(new URL('../../public/cli/braid.mjs', import.meta.url).href);
const origin = 'https://braid.example';
const accessToken = `braid_agent_${'a'.repeat(64)}`;
const artifactToken = 'temporary-artifacts-password';
const commit = 'b'.repeat(40);
let root: string;

beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'braid-cli-test-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

type GitOptions = { cwd?: string; env?: NodeJS.ProcessEnv; token?: string };

function env() {
  return { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0', BRAID_CONFIG_HOME: join(root, 'config'), BRAID_ACCESS_TOKEN: accessToken, BRAID_WORKSPACE_ID: 'workspace-one' };
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function put(dir: string, path: string, content: string | Buffer) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function repository(scope = ['src/'], metadata: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const dir = join(root, 'repo');
  mkdirSync(dir);
  git(dir, 'init', '--template=', '--initial-branch=main');
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'gc.auto', '0');
  put(dir, 'src/main.ts', 'export const answer = 1;\n');
  for (const [path, content] of Object.entries(files)) put(dir, path, content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Base');
  const baseCommit = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, '.braid'), { mode: 0o700 });
  put(dir, '.braid/task.json', JSON.stringify({ url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', baseCommit, scope, ...metadata }));
  chmodSync(join(dir, '.braid/task.json'), 0o600);
  mkdirSync(join(dir, '.git/info'), { recursive: true });
  put(dir, '.git/info/exclude', '.braid/\n');
  return { dir, baseCommit };
}

const committedRepository = () => repository(['src/'], { submissionMode: 'commits' });

it.each(['sparse', 'skip-worktree', 'partial'])('rejects an incomplete %s checkout before renewing or submitting', async kind => {
  const { dir } = repository();
  if (kind === 'sparse') git(dir, 'config', 'core.sparseCheckout', 'true');
  if (kind === 'skip-worktree') git(dir, 'update-index', '--skip-worktree', 'src/main.ts');
  if (kind === 'partial') git(dir, 'config', 'remote.origin.promisor', 'true');
  const fetch = vi.fn();
  await expect(cli.resume({ dir }, { env: env(), fetch })).rejects.toThrow('full repository checkout');
  await expect(cli.submit({ dir, summary: 'Update', rationale: 'Task' }, { env: env(), fetch })).rejects.toThrow('full repository checkout');
  expect(fetch).not.toHaveBeenCalled();
});

function checkoutSnapshot(dir: string): unknown {
  return Object.fromEntries(readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, {
      mode: stat.mode, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
      ...(stat.isSymbolicLink() ? { link: readlinkSync(path) } : stat.isDirectory() ? { entries: checkoutSnapshot(path) } : { content: readFileSync(path).toString('base64') }),
    }];
  }));
}

const checkoutDetails = (baseCommit: string, scope = ['src/']) => ({ missionId: 'mission-one', agentId: 'coder', title: 'Change the answer', intent: 'Update the requested behavior.', baseCommit, branch: 'main', remote: 'https://git.example/repo', token: artifactToken, scope, context: [] });
const renewal = (baseCommit: string, previousCommit: string | null) => Response.json({ ...checkoutDetails(baseCommit), previousCommit });
const submission = (dir: string) => ({ dir, summary: 'Update the answer', rationale: 'Match the requested behavior' });
const grant = () => ({ accessToken, workspaceId: 'workspace-one', tokenType: 'Bearer', scope: 'work', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
const metadata = (dir: string) => JSON.parse(readFileSync(join(dir, '.braid/task.json'), 'utf8'));
const receipt = (dir: string) => JSON.parse(readFileSync(join(dir, '.braid/submission.json'), 'utf8'));
const lost = () => vi.fn().mockRejectedValue(new Error('Response lost'));

describe('local CLI inputs and credentials', () => {
  it('matches the server path rules, including nested protected names', () => {
    const paths = ['src/main.ts', 'a file.txt', 'src/über.ts', '', '/etc/passwd', '../escape', 'a/../b', 'a/./b', 'a//b', 'a\\b', '.Git/config', 'a/.BRAID/task.json', '.env', 'a/.env.local', '.dev.vars.production', 'a/credentials.json', 'a/id_rsa', 'a/id_ed25519', 'a\0b', 'a\nb', 'a'.repeat(241)];
    for (const path of paths) expect(cli.validPath(path)).toBe(domainValidPath(path));
  });

  it('rejects unsafe origins and credential-bearing or non-HTTPS remotes', () => {
    expect(cli.normalizeOrigin('https://BRAID.example:443/')).toBe(origin);
    expect(cli.normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    for (const value of ['http://public.example', 'https://user:secret@braid.example', `${origin}/path`, `${origin}?token=secret`, `${origin}#fragment`]) expect(() => cli.normalizeOrigin(value)).toThrow();
    for (const value of ['file:///repo', 'git@host:repo', 'http://localhost/repo', 'https://user:secret@git.example/repo', 'https://git.example/repo?token=secret', 'https://git.example/repo#secret']) expect(() => cli.validateRemote(value)).toThrow();
    expect(cli.validateRemote('https://git.example/repo')).toBe('https://git.example/repo');
  });

  it('stores private credentials per origin and repository and supports environment overrides', () => {
    const settings = { BRAID_CONFIG_HOME: join(root, 'private-config') };
    cli.saveCredentials(origin, grant(), settings);
    const file = cli.credentialFile(origin, settings, 'workspace-one');
    for (const folder of [settings.BRAID_CONFIG_HOME, dirname(file)]) expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(cli.credentialFile(origin, settings))).toBe(false);
    expect(cli.loadCredentials('https://BRAID.example:443/', settings)).toEqual({ accessToken, workspaceId: 'workspace-one' });
    expect(cli.loadCredentials(origin, settings, { workspaceId: 'workspace-one' })).toEqual({ accessToken, workspaceId: 'workspace-one' });
    expect(() => cli.loadCredentials(origin, settings, { workspaceId: 'workspace-two' })).toThrow(/Run connect .*--workspace workspace-two/);
    expect(() => cli.loadCredentials('https://other.example', settings)).toThrow(/connect/);
    expect(cli.loadCredentials('https://other.example', env())).toEqual({ accessToken, workspaceId: 'workspace-one' });
    expect(cli.credentialFile(origin, { XDG_CONFIG_HOME: root }, 'workspace-one')).toBe(join(root, 'braid', ...file.split('/').slice(-2)));
    chmodSync(file, 0o644);
    cli.loadCredentials(origin, settings);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, JSON.stringify({ ...grant(), origin: 'https://other.example' }));
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/different Braid origin/);
    writeFileSync(file, JSON.stringify({ ...grant(), origin, workspaceId: 'workspace-two' }));
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/do not match their repository/);
    writeFileSync(file, JSON.stringify({ ...grant(), origin, expiresAt: '2000-01-01T00:00:00Z' }));
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/expired/);
  });

  it('keeps approvals for several repositories and still reads the origin-wide file of earlier releases', () => {
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') }, second = `braid_agent_${'e'.repeat(64)}`, renewed = `braid_agent_${'f'.repeat(64)}`;
    mkdirSync(settings.BRAID_CONFIG_HOME, { mode: 0o700 });
    writeFileSync(cli.credentialFile(origin, settings), JSON.stringify({ origin, accessToken, workspaceId: 'workspace-one', expiresAt: grant().expiresAt }), { mode: 0o600 });
    expect(cli.loadCredentials(origin, settings)).toEqual({ accessToken, workspaceId: 'workspace-one' });
    expect(cli.loadCredentials(origin, settings, { readOnly: true, workspaceId: 'workspace-one' })).toEqual({ accessToken, workspaceId: 'workspace-one' });
    cli.saveCredentials(origin, { ...grant(), accessToken: second, workspaceId: 'workspace-two' }, settings);
    expect(cli.loadCredentials(origin, settings, { workspaceId: 'workspace-two' })).toEqual({ accessToken: second, workspaceId: 'workspace-two' });
    expect(cli.loadCredentials(origin, settings, { workspaceId: 'workspace-one' })).toEqual({ accessToken, workspaceId: 'workspace-one' });
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/Several repositories/);
    expect(cli.loadCredentials(origin, { ...settings, BRAID_WORKSPACE_ID: 'workspace-two' })).toEqual({ accessToken: second, workspaceId: 'workspace-two' });
    // The approval that lasts longest wins when both layouts hold one for the same repository.
    cli.saveCredentials(origin, { ...grant(), accessToken: renewed, expiresAt: new Date(Date.now() + 7_200_000).toISOString() }, settings);
    expect(cli.loadCredentials(origin, settings, { workspaceId: 'workspace-one' }).accessToken).toBe(renewed);
    expect(JSON.parse(readFileSync(cli.credentialFile(origin, settings), 'utf8')).accessToken).toBe(accessToken);
  });

  it('does not follow symlinked credential files or directories', () => {
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') };
    mkdirSync(settings.BRAID_CONFIG_HOME);
    const external = join(root, 'outside.json'), externalDirectory = join(root, 'elsewhere'), outside = JSON.stringify({ ...grant(), origin });
    writeFileSync(external, outside);
    symlinkSync(external, cli.credentialFile(origin, settings));
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/private Braid credentials/);
    unlinkSync(cli.credentialFile(origin, settings));
    const file = cli.credentialFile(origin, settings, 'workspace-one');
    mkdirSync(dirname(file));
    symlinkSync(external, file);
    expect(() => cli.loadCredentials(origin, settings, { workspaceId: 'workspace-one' })).toThrow(/private Braid credentials/);
    expect(() => cli.saveCredentials(origin, grant(), settings)).toThrow(/symlink/);
    rmSync(dirname(file), { recursive: true });
    mkdirSync(externalDirectory);
    symlinkSync(externalDirectory, dirname(file));
    expect(() => cli.saveCredentials(origin, grant(), settings)).toThrow(/symlink/);
    expect(() => cli.loadCredentials(origin, settings)).toThrow(/private Braid credentials/);
    rmSync(settings.BRAID_CONFIG_HOME, { recursive: true });
    symlinkSync(externalDirectory, settings.BRAID_CONFIG_HOME);
    expect(() => cli.saveCredentials(origin, grant(), settings)).toThrow(/symlink/);
    expect(readdirSync(externalDirectory)).toEqual([]);
    expect(readFileSync(external, 'utf8')).toBe(outside);
  });

  it('shows help without running commands or accessing the network', async () => {
    const fetch = vi.fn(), log = vi.fn();
    await cli.main(['--help'], { fetch, log });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('agent-reported and unverified');
    expect(log.mock.calls[0][0]).toContain('node braid.mjs resume --dir DIRECTORY');
    expect(log.mock.calls[0][0]).toContain('node braid.mjs update --dir DIRECTORY');
    expect(log.mock.calls[0][0]).toContain('connect again, then resume the original checkout');
    await cli.main(['resume', '--help'], { fetch, log });
    expect(log).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    await expect(cli.main(['submit', '--dir', root, '--retry', '--summary', 'new'], { fetch })).rejects.toThrow(/saved payload/);
    await expect(cli.main(['change', 'submit', '--dir', root, '--retry', '--proof'], { fetch })).rejects.toThrow(/saved payload/);
    expect(log.mock.calls[0][0]).toContain('--proof runs .braid/proof.json');
    expect(log.mock.calls[0][0]).toContain('npx playwright install chromium');
  });

  it.each([
    ['resume'], ['resume', '--dir'], ['resume', '--dir', 'one', '--dir', 'two'],
    ['resume', '--dir', 'checkout', '--url', origin], ['resume', '--dir', 'checkout', '--retry'],
    ['update'], ['update', '--dir', 'checkout', '--retry'], ['update', '--dir', 'checkout', '--summary', 'text'],
    ['constructor'], ['connect', '--url', origin, '--workspace', '../other'],
  ].map(argv => ({ argv })))('rejects invalid arguments $argv without accessing the network', async ({ argv }) => {
    const fetch = vi.fn();
    await expect(cli.main(argv, { fetch })).rejects.toThrow(/required options|missing its value|Unknown or duplicate|Unknown command|Invalid task, agent, or workspace ID/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('owner-approved device connection', () => {
  it('respects polling intervals and Retry-After without printing secrets or approving itself', async () => {
    const log = vi.fn(), waits: number[] = [];
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') };
    let now = Date.now();
    const deviceCode = 'private-device-code-0123456789';
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ deviceCode, userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 120, interval: 2 }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: 'pending' }, { status: 202, headers: { 'retry-after': '7' } }))
      .mockResolvedValueOnce(Response.json({ status: 'slow_down' }, { status: 429, headers: { 'retry-after': '15' } }))
      .mockResolvedValueOnce(Response.json(grant()));
    await cli.connect(origin, { env: settings, fetch, log, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } }, undefined, { link: true });
    expect(waits).toEqual([2000, 7000, 15000]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Local coding agent', scope: 'work' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${origin}/api/agent/requests`, ...Array(3).fill(`${origin}/api/agent/token`)]);
    expect(fetch.mock.calls.every(call => call[1].redirect === 'error')).toBe(true);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain(`${origin}/?connect=ABCD2345`);
    expect(output).toContain('ABCD2345');
    expect(output).not.toContain(deviceCode);
    expect(output).not.toContain(accessToken);
    expect(cli.loadCredentials(origin, settings).accessToken).toBe(accessToken);
    expect(cli.retryDelay(new Date(now + 20_000).toUTCString(), 5000, now)).toBeGreaterThanOrEqual(19_000);
  });

  it.each(['expired', 'denied'])('stops when authorization is %s', async state => {
    let now = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ deviceCode: 'device-code-0123456789', userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 3, interval: 1 }))
      .mockResolvedValueOnce(Response.json({ status: state }, state === 'denied' ? { status: 410 } : { status: 202, headers: { 'retry-after': '10' } }));
    await expect(cli.connect(origin, { env: {}, fetch, log: vi.fn(), now: () => now, sleep: async (ms: number) => { now += ms; } }, undefined, { link: true })).rejects.toThrow(/expired|denied/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps an approval for another repository but refuses to use it for the required one', async () => {
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') }, log = vi.fn();
    let now = Date.now();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ deviceCode: 'private-device-code-for-connect', userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 120, interval: 1 }))
      .mockResolvedValueOnce(Response.json(grant()));
    await expect(cli.main(['connect', '--url', origin, '--workspace', 'workspace-two', '--link'], { env: settings, fetch, log, now: () => now, sleep: async (ms: number) => { now += ms; } }))
      .rejects.toThrow(/approved repository workspace-one, but workspace-two is required/);
    // The approval page is unchanged; the owner still chooses the repository there.
    expect(log.mock.calls.flat().join('\n')).toContain(`Approve this connection in Braid: ${origin}/?connect=ABCD2345\n`);
    expect(cli.loadCredentials(origin, settings, { workspaceId: 'workspace-one' }).accessToken).toBe(accessToken);
    expect(() => cli.loadCredentials(origin, settings, { workspaceId: 'workspace-two' })).toThrow(/Run connect/);
  });
});

describe('pinned local checkout', () => {
  it.each([['src/'], ['*']])('pins a new checkout with scope %j and keeps credentials ephemeral', async scopePath => {
    const scope = [scopePath];
    const source = repository(), destination = join(root, 'checkout'), log = vi.fn();
    put(source.dir, 'src/main.ts', 'export const answer = 99;\n');
    git(source.dir, 'add', 'src/main.ts');
    git(source.dir, 'commit', '-m', 'Trunk moved');
    const details = checkoutDetails(source.baseCommit, scope);
    const fetch = vi.fn().mockResolvedValue(Response.json(details));
    let helper = '';
    const runner = vi.fn((args: string[], options: GitOptions) => {
      expect(args.join(' ')).not.toContain(artifactToken);
      if (args[0] === 'clone') {
        expect(args).toContain('--no-checkout');
        expect(options.token).toBe(artifactToken);
        helper = options.env!.GIT_ASKPASS!;
        expect(statSync(helper).mode & 0o777).toBe(0o700);
        expect(readFileSync(helper, 'utf8')).not.toContain(artifactToken);
        expect(execFileSync(process.execPath, [helper, "Username for 'https://git.example':"], { encoding: 'utf8' })).toBe('x\n');
        expect(execFileSync(process.execPath, [helper, "Password for 'https://git.example':"], { encoding: 'utf8', env: { ...process.env, BRAID_GIT_TOKEN: artifactToken } })).toBe(`${artifactToken}\n`);
        git(root, 'clone', '--no-checkout', '--template=', '--', source.dir, destination);
        git(destination, 'remote', 'set-url', 'origin', details.remote);
        return Buffer.from('');
      }
      expect(options.token).toBeUndefined();
      return cli.runGit(args, options);
    });
    await cli.checkout({ url: origin, mission: 'mission-one', agent: 'coder', dir: destination }, { env: env(), fetch, git: runner, log });
    expect(git(destination, 'rev-parse', 'HEAD')).toBe(source.baseCommit);
    expect(git(destination, 'branch', '--show-current')).toBe('');
    expect(readFileSync(join(destination, 'src/main.ts'), 'utf8')).toContain('answer = 1');
    expect(existsSync(helper)).toBe(false);
    expect(readFileSync(join(destination, '.git/info/exclude'), 'utf8')).toContain('.braid/');
    expect(git(destination, 'status', '--porcelain')).toBe('');
    for (const path of ['.git/config', '.braid/task.json', '.braid/TASK.md']) {
      const content = readFileSync(join(destination, path), 'utf8');
      expect(content).not.toContain(artifactToken);
      expect(content).not.toContain(accessToken);
    }
    expect(metadata(destination)).toEqual({ url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', baseCommit: source.baseCommit, scope });
    const guide = readFileSync(join(destination, '.braid/TASK.md'), 'utf8');
    expect(guide).toContain(`braid.mjs connect --url ${origin}`);
    expect(guide).toContain('braid.mjs resume --dir DIRECTORY');
    expect(guide).toContain('braid.mjs submit --dir DIRECTORY --retry');
    expect(log.mock.calls.flat().join('\n')).not.toContain(artifactToken);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: `Bearer ${accessToken}`, 'X-Braid-Workspace': 'workspace-one' });
    await expect(cli.checkout({ url: origin, mission: 'mission-one', agent: 'coder', dir: destination }, { env: env(), fetch, git: runner })).rejects.toThrow(/NEW directory/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('start from a task link', () => {
  const link = `${origin}/tasks/mission-one?workspace=workspace-one`;
  type State = { missions: Array<{ id: string; source: string; execution: string; status: string; baseCommit?: string; agents: Array<{ id: string; status: string; commit?: string }> }> };
  const snapshot = (status = 'queued', missionStatus = 'running'): State => ({ missions: [{ id: 'mission-one', source: 'live', execution: 'local', status: missionStatus, agents: [{ id: 'coder', status }] }] });

  it('reuses approval and prepares the only agent for committed submissions without lane arguments', async () => {
    const source = repository(), dir = join(root, 'started');
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(snapshot()))
      .mockResolvedValueOnce(Response.json({ ...checkoutDetails(source.baseCommit), reviewComments, pullRequest: { id: 'ch_0123456789abc', number: 73, status: 'open', next: 'Waiting on #51', dependsOn: [{ id: 'ch_1123456789abc', number: 51, status: 'open' }] } }));
    const runner = (args: string[], options: GitOptions) => {
      if (args[0] === 'clone') { git(root, 'clone', '--no-checkout', '--template=', '--', source.dir, dir); return Buffer.from(''); }
      return cli.runGit(args, options);
    };
    await cli.main(['start', link, '--dir', dir], { env: env(), fetch, git: runner, log: vi.fn() });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${origin}/api/state`, `${origin}/api/missions/mission-one/agents/coder/checkout`]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(source.baseCommit);
    expect(metadata(dir)).toMatchObject({ missionId: 'mission-one', submissionMode: 'commits' });
    const guide = readFileSync(join(dir, '.braid/TASK.md'), 'utf8');
    expect(guide).toContain('submit sends committed work');
    expect(guide).toContain('braid.mjs update --dir DIRECTORY');
    expect(guide).toContain('## Pull request #73');
    expect(guide).toContain('Waiting on #51');
    expect(guide).toContain('Depends on #51');
    expect(guide).toContain('src/parser.ts:14 (RIGHT; revision 1)');
    expect(guide).toContain('Handle **empty input** before parsing.');
    expect(guide).not.toContain('Already addressed.');
  });

  it.each([false, true])('binds a clean existing checkout without choosing a branch (worktree: %s)', worktree => {
    // Each case gets its own fixture; Braid metadata is absent until start binds it.
    return (async () => {
      const source = repository();
      let dir = source.dir;
      if (worktree) { dir = join(root, 'worktree'); git(source.dir, 'worktree', 'add', '-b', 'agent-work', dir); }
      else rmSync(join(dir, '.braid'), { recursive: true });
      const branch = git(dir, 'branch', '--show-current'), head = git(dir, 'rev-parse', 'HEAD');
      const state = snapshot(); Object.assign(state.missions[0], { baseCommit: source.baseCommit });
      const fetch = vi.fn().mockResolvedValueOnce(Response.json(state)).mockResolvedValueOnce(Response.json(checkoutDetails(source.baseCommit)));
      const runner = vi.fn((args: string[], options: GitOptions) => cli.runGit(args, options));
      await cli.start({ task: link, dir }, { env: env(), fetch, git: runner, log: vi.fn() });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(dir, 'branch', '--show-current')).toBe(branch);
      expect(readFileSync(join(dir, 'src/main.ts'), 'utf8')).toContain('answer = 1');
      expect(runner.mock.calls.some(call => ['clone', 'checkout', 'reset', 'fetch'].includes(call[0][0]))).toBe(false);
      expect(metadata(dir).submissionMode).toBe('commits');
    })();
  });

  it.each(['untracked', 'edited', 'committed'])('refuses to bind existing %s work before claiming or fetching the task', async kind => {
    const { dir, baseCommit } = repository();
    rmSync(join(dir, '.braid'), { recursive: true });
    put(dir, kind === 'untracked' ? 'personal.txt' : 'src/main.ts', 'Work from another task\n');
    if (kind === 'committed') { git(dir, 'add', 'src/main.ts'); git(dir, 'commit', '-m', 'Other task'); }
    const state = snapshot();
    Object.assign(state.missions[0], { baseCommit });
    const before = checkoutSnapshot(dir), fetch = vi.fn().mockResolvedValue(Response.json(state));
    await expect(cli.start({ task: link, dir }, { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/clean checkout/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checkoutSnapshot(dir)).toEqual(before);
  });

  it('resumes committed work in its existing directory without cloning or resetting', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 42;\n');
    git(dir, 'add', 'src/main.ts'); git(dir, 'commit', '-m', 'Integrated work');
    const before = renewalSnapshot(dir), runner = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(snapshot('working'))).mockResolvedValueOnce(Response.json(checkoutDetails(baseCommit)));
    await cli.start({ task: link, dir }, { env: env(), fetch, git: runner, log: vi.fn() });
    expect(runner).not.toHaveBeenCalled();
    expect(renewalSnapshot(dir)).toEqual(before);
  });

  it('asks for email without credentials and resumes after explicit approval', async () => {
    const { dir, baseCommit } = repository();
    let now = Date.now();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ deviceCode: 'private-device-code-for-start', userCode: 'ABCD2345', verificationUri: `${origin}/?connect=ABCD2345`, expiresIn: 120, interval: 1 }))
      .mockResolvedValueOnce(Response.json(grant()))
      .mockResolvedValueOnce(Response.json(snapshot('working')))
      .mockResolvedValueOnce(Response.json(checkoutDetails(baseCommit)));
    const settings = { BRAID_CONFIG_HOME: join(root, 'first-connection') };
    await expect(cli.start({ task: link, dir }, { env: settings, fetch, log: vi.fn() })).rejects.toThrow('run connect --email ADDRESS');
    expect(fetch).not.toHaveBeenCalled();
    await cli.connect(origin, { env: settings, fetch, log: vi.fn(), now: () => now, sleep: async (ms: number) => { now += ms; } }, 'workspace-one', { link: true });
    await cli.start({ task: link, dir }, { env: settings, fetch, log: vi.fn(), now: () => now, sleep: async (ms: number) => { now += ms; } });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${origin}/api/agent/requests`, `${origin}/api/agent/token`, `${origin}/api/state`, `${origin}/api/missions/mission-one/agents/coder/checkout`]);
    expect(existsSync(cli.credentialFile(origin, settings, 'workspace-one'))).toBe(true);
  });

  it('uses the approval for the task repository when several repositories are connected', async () => {
    const { dir, baseCommit } = repository(), other = `braid_agent_${'e'.repeat(64)}`;
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') };
    cli.saveCredentials(origin, grant(), settings);
    cli.saveCredentials(origin, { ...grant(), accessToken: other, workspaceId: 'workspace-two' }, settings);
    // A link without a repository resumes with the checkout's own approval.
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(snapshot('working'))).mockResolvedValueOnce(Response.json(checkoutDetails(baseCommit)));
    await cli.start({ task: `${origin}/tasks/mission-one`, dir }, { env: settings, fetch, log: vi.fn() });
    for (const call of fetch.mock.calls) expect(call[1].headers).toMatchObject({ Authorization: `Bearer ${accessToken}`, 'X-Braid-Workspace': 'workspace-one' });
    const elsewhere = join(root, 'elsewhere'), refused = vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(Response.json({ error: 'Claimed' }, { status: 409 }));
    await expect(cli.start({ task: `${origin}/tasks/mission-one?workspace=workspace-two`, dir: elsewhere }, { env: settings, fetch: refused, log: vi.fn() })).rejects.toThrow(/HTTP 409/);
    for (const call of refused.mock.calls) expect(call[1].headers).toMatchObject({ Authorization: `Bearer ${other}`, 'X-Braid-Workspace': 'workspace-two' });
    await expect(cli.start({ task: `${origin}/tasks/mission-one?workspace=workspace-two`, dir }, { env: settings, fetch: vi.fn() })).rejects.toThrow(/different task/);
  });

  it('renews a reviewed task from its checkout and records the latest proposal without changing work', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-am', 'Reviewed work');
    const head = git(dir, 'rev-parse', 'HEAD'), log = vi.fn(), runner = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(snapshot('review', 'review'))).mockResolvedValueOnce(renewal(baseCommit, commit));
    await expect(cli.start({ task: link, dir }, { env: env(), fetch, log, git: runner })).resolves.toMatchObject({ baseCommit, previousCommit: commit });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${origin}/api/state`, `${origin}/api/missions/mission-one/agents/coder/checkout`]);
    expect(metadata(dir).previousCommit).toBe(commit);
    expect(runner).not.toHaveBeenCalled();
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(log.mock.calls.flat().join(' ')).toContain(`Proposal ${commit} is the latest result; submit again from this checkout to revise it.`);
  });

  it.each([
    { kind: 'reviewed', agent: 'review', mission: 'review', status: 'review', message: /in review .*run start again from the checkout that submitted it/ },
    { kind: 'merged', agent: 'merged', mission: 'merged', status: 'merged', message: /merged into main/ },
    { kind: 'cancelled', agent: 'failed', mission: 'failed', status: 'failed', message: /no longer accepting work/ },
    { kind: 'closed lane', agent: 'skipped', mission: 'review', status: 'skipped', message: /no longer accepting work/ },
  ])('only reports a $kind task when no checkout holds its work', async ({ agent, mission, status, message }) => {
    const dir = join(root, 'elsewhere'), log = vi.fn(), state = snapshot(agent, mission);
    state.missions[0].agents[0].commit = commit;
    const fetch = vi.fn().mockResolvedValue(Response.json(state));
    await expect(cli.start({ task: link, dir }, { env: env(), fetch, log, git: vi.fn() })).resolves.toEqual({ missionId: 'mission-one', agentId: 'coder', commit, status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(dir)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(message);
  });

  it('reports a merged task from its checkout and leaves receipts and files alone', async () => {
    const { dir } = repository();
    put(dir, 'notes.txt', 'Local notes\n');
    put(dir, '.braid/submission.json', JSON.stringify({ status: 'complete' }));
    const before = checkoutSnapshot(dir), log = vi.fn();
    const fetch = vi.fn().mockResolvedValue(Response.json(snapshot('merged', 'merged')));
    await expect(cli.start({ task: link, dir }, { env: env(), fetch, log })).resolves.toMatchObject({ status: 'merged' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checkoutSnapshot(dir)).toEqual(before);
    expect(log.mock.calls.flat().join(' ')).toContain('merged into main');
  });

  it('waits for the change a submitted task became and reports how it ended', async () => {
    const { dir } = repository();
    let polls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/agent/session') return Response.json({ accessToken: 'braid_at_test.signature' });
      if (url.pathname === '/api/changes' && url.searchParams.get('task') === 'mission-one') return Response.json({ items: polls++ ? [{ id: 'ch_3abcdefabcdef', number: 7 }] : [], nextCursor: null });
      if (url.pathname === '/api/changes/ch_3abcdefabcdef') return Response.json({ id: 'ch_3abcdefabcdef', number: 7, title: 'Change the answer', status: 'landed', revision: 1, landedCommit: commit });
      return Response.json({ error: 'Not found.' }, { status: 404 });
    });
    const log = vi.fn(), sleep = vi.fn(async () => {});
    await expect(cli.main(['wait', '--dir', dir, '--timeout', '60'], { env: env(), fetch, log, sleep })).resolves.toMatchObject({ status: 'landed', number: 7 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Merged as ${commit}.`));
    expect(JSON.stringify(log.mock.calls)).not.toContain(accessToken);
  });

  it('never adopts a different task or mismatched repository', async () => {
    const { dir } = repository(), fetch = vi.fn();
    await expect(cli.start({ task: link.replace('mission-one', 'mission-other'), dir }, { env: env(), fetch })).rejects.toThrow(/different task/);
    await expect(cli.start({ task: link, dir: join(root, 'new') }, { env: { ...env(), BRAID_WORKSPACE_ID: 'other' }, fetch })).rejects.toThrow(/another repository/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([`${origin}/`, `${origin}/tasks/one?secret=value`, `${origin}/tasks/one?workspace=a&workspace=b`, 'https://user:secret@braid.example/tasks/one', 'https://braid.example/tasks/../api', 'http://public.example/tasks/one'])('rejects ambiguous or unsafe task links %s', link => {
    expect(() => cli.taskLink(link)).toThrow();
  });
});

// Renewal may refresh TASK.md; all other files, receipts, permissions and Git state must stay intact.
function renewalSnapshot(dir: string): unknown {
  const snapshot = checkoutSnapshot(dir) as Record<string, { mtime?: number; ctime?: number; entries: Record<string, unknown> }>;
  delete snapshot['.braid'].mtime;
  delete snapshot['.braid'].ctime;
  delete snapshot['.braid'].entries['TASK.md'];
  return snapshot;
}

describe('checkout renewal', () => {
  it('refreshes task instructions without touching the branch or local work', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'Uncommitted implementation.\n');
    const before = renewalSnapshot(dir);
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...checkoutDetails(baseCommit), context: 'Keep the public API unchanged.' }));
    await cli.resume({ dir }, { env: env(), fetch, log: vi.fn() });
    expect(readFileSync(join(dir, '.braid/TASK.md'), 'utf8')).toContain('Keep the public API unchanged.');
    expect(renewalSnapshot(dir)).toEqual(before);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });

  it('uses fresh repository credentials after expiry without changing the checkout or retaining its read token', async () => {
    const { dir, baseCommit } = repository(['*']);
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') }, previousGrant = grant();
    cli.saveCredentials(origin, previousGrant, settings);
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'add', 'src/main.ts');
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    put(dir, 'untracked.bin', Buffer.from([0, 1, 2]));
    put(dir, '.braid/TASK.md', 'Original task instructions.\n');
    git(dir, 'remote', 'add', 'origin', 'https://git.example/original');
    const before = checkoutSnapshot(dir), unchangedFiles = renewalSnapshot(dir);
    const fetch = vi.fn().mockResolvedValue(Response.json(checkoutDetails(baseCommit, ['*']))), log = vi.fn(), runner = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(previousGrant.expiresAt) + 1);
    await expect(cli.resume({ dir }, { env: settings, fetch, log, git: runner })).rejects.toThrow(/expired/);
    expect(fetch).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);

    const renewedToken = `braid_agent_${'c'.repeat(64)}`;
    cli.saveCredentials(origin, { ...grant(), accessToken: renewedToken }, settings);
    const result = await cli.main(['resume', '--dir', dir], { env: settings, fetch, log, git: runner });
    expect(result).toEqual(metadata(dir));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/api/missions/mission-one/agents/coder/checkout`, expect.objectContaining({
      method: 'POST', body: '{}', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${renewedToken}`, 'X-Braid-Workspace': 'workspace-one' },
    }));
    expect(runner).not.toHaveBeenCalled();
    expect(renewalSnapshot(dir)).toEqual(unchangedFiles);
    expect(readFileSync(cli.credentialFile(origin, settings, 'workspace-one'), 'utf8')).not.toContain(artifactToken);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Renewed checkout for task mission-one, agent coder');
    for (const secret of [accessToken, renewedToken, artifactToken]) expect(output).not.toContain(secret);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });

  it('preserves an unconfirmed submission journal through renewal and retries the exact saved body and key', async () => {
    const { dir, baseCommit } = repository();
    const settings = { BRAID_CONFIG_HOME: join(root, 'config') }, previousGrant = grant();
    cli.saveCredentials(origin, previousGrant, settings);
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    await expect(cli.submit(submission(dir), { env: settings, fetch: lost(), log: vi.fn() })).rejects.toThrow(/uncertain/);
    const journalPath = join(dir, '.braid/submission.json'), saved = readFileSync(journalPath, 'utf8'), journal = JSON.parse(saved);
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(previousGrant.expiresAt) + 1);
    const renewedToken = `braid_agent_${'d'.repeat(64)}`;
    cli.saveCredentials(origin, { ...grant(), accessToken: renewedToken }, settings);
    const before = renewalSnapshot(dir), log = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(checkoutDetails(baseCommit)))
      .mockResolvedValueOnce(Response.json({ commit }));
    await cli.resume({ dir }, { env: settings, fetch, log });
    expect(renewalSnapshot(dir)).toEqual(before);
    expect(readFileSync(journalPath, 'utf8')).toBe(saved);
    expect(journal.status).toBe('pending');
    expect(log.mock.calls.flat().join(' ')).toContain('submit --dir DIRECTORY --retry');
    await expect(cli.submit({ dir, retry: true }, { env: settings, fetch, log: vi.fn() })).resolves.toEqual({ commit });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      `${origin}/api/missions/mission-one/agents/coder/checkout`, `${origin}/api/missions/mission-one/agents/coder/submit`,
    ]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ body: journal.body, headers: { 'Idempotency-Key': journal.key, Authorization: `Bearer ${renewedToken}` } });
    expect(JSON.parse(journal.body).files).toEqual([{ path: 'src/main.ts', content: 'export const answer = 2;\n' }]);
    expect(readFileSync(join(dir, 'src/main.ts'), 'utf8')).toBe('export const answer = 3;\n');
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ status: 'complete', key: journal.key, commit });
    expect(metadata(dir).previousCommit).toBe(commit);
  });

  it('leaves private credentials unchanged when their config directory is inside the checkout', async () => {
    const { dir, baseCommit } = repository(), settings = { BRAID_CONFIG_HOME: join(dir, '.braid/credentials') };
    cli.saveCredentials(origin, grant(), settings);
    const before = renewalSnapshot(dir), fetch = vi.fn().mockResolvedValue(Response.json(checkoutDetails(baseCommit)));
    await cli.resume({ dir }, { env: settings, fetch, log: vi.fn() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(renewalSnapshot(dir)).toEqual(before);
  });

  it('rejects credentials for a different workspace before making a request', async () => {
    const { dir } = repository(), fetch = vi.fn(), log = vi.fn(), before = checkoutSnapshot(dir);
    await expect(cli.resume({ dir }, { env: { ...env(), BRAID_WORKSPACE_ID: 'workspace-other' }, fetch, log })).rejects.toThrow(/workspace does not match/);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);
  });

  it.each([
    { field: 'mission', changes: { missionId: 'mission-other' } },
    { field: 'agent', changes: { agentId: 'agent-other' } },
    { field: 'base', changes: { baseCommit: commit } },
    { field: 'scope', changes: { scope: ['*'] } },
    { field: 'expanded scope', changes: { scope: ['src/', 'docs/'] } },
    { field: 'previous proposal', changes: { previousCommit: 'not-a-commit' } },
  ])('rejects a renewed $field that differs from the pinned task', async ({ changes }) => {
    const { dir, baseCommit } = repository(), before = checkoutSnapshot(dir), log = vi.fn();
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...checkoutDetails(baseCommit), ...changes }));
    await expect(cli.resume({ dir }, { env: env(), fetch, log })).rejects.toThrow(/invalid checkout details|pinned task base or scope/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);
  });

  it.each(['task symlink', 'metadata directory symlink', 'nonprivate metadata', 'nested directory', 'unrelated HEAD', 'invalid scope', 'invalid accepted base', 'missing task'])('rejects %s without changing files or making a request', async kind => {
    const { dir } = repository(), taskPath = join(dir, '.braid/task.json');
    let requested = dir;
    if (kind === 'task symlink') {
      const external = join(root, 'task.json');
      renameSync(taskPath, external);
      symlinkSync(external, taskPath);
    } else if (kind === 'metadata directory symlink') {
      const external = join(root, 'metadata');
      renameSync(join(dir, '.braid'), external);
      symlinkSync(external, join(dir, '.braid'));
    } else if (kind === 'nonprivate metadata') chmodSync(taskPath, 0o644);
    else if (kind === 'nested directory') requested = join(dir, 'src');
    else if (kind === 'unrelated HEAD') {
      git(dir, 'checkout', '--orphan', 'unrelated');
      put(dir, 'src/main.ts', 'export const answer = 2;\n');
      git(dir, 'add', 'src/main.ts');
      git(dir, 'commit', '-m', 'Unpinned commit');
    } else if (kind === 'invalid scope' || kind === 'invalid accepted base') {
      const task = JSON.parse(readFileSync(taskPath, 'utf8'));
      writeFileSync(taskPath, JSON.stringify(kind === 'invalid scope' ? { ...task, scope: ['../elsewhere'] } : { ...task, acceptedBase: task.baseCommit }));
    } else unlinkSync(taskPath);
    const before = checkoutSnapshot(dir), fetch = vi.fn(), log = vi.fn();
    await expect(cli.resume({ dir: requested }, { env: env(), fetch, log })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);
  });

  it.each([
    { field: 'credential-bearing remote', changes: { remote: `https://x:${artifactToken}@git.example/repo` } },
    { field: 'invalid read token', changes: { token: `invalid token ${artifactToken}` } },
    { field: 'missing title', changes: { title: undefined } },
    { field: 'protected scope', changes: { scope: ['.git/'] } },
    { field: 'credential in context', changes: { context: [artifactToken] } },
  ])('validates a $field in renewal responses without leaking credentials', async ({ changes }) => {
    const { dir, baseCommit } = repository(), before = checkoutSnapshot(dir), log = vi.fn();
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...checkoutDetails(baseCommit), ...changes }));
    const error = await cli.resume({ dir }, { env: env(), fetch, log }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(cli.CliError);
    expect(String(error)).not.toContain(artifactToken);
    expect(String(error)).not.toContain(accessToken);
    expect(log).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);
  });

  it.each(['lost response', 'claim conflict', 'invalid JSON'])('keeps a failed renewal unchanged after a %s', async kind => {
    const { dir } = repository(), before = checkoutSnapshot(dir), log = vi.fn();
    const fetch = kind === 'lost response' ? vi.fn().mockRejectedValue(new Error(accessToken))
      : vi.fn().mockResolvedValue(kind === 'claim conflict' ? Response.json({ error: artifactToken }, { status: 409 }) : new Response(artifactToken));
    const error = await cli.resume({ dir }, { env: env(), fetch, log }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(cli.CliError);
    expect(String(error)).not.toContain(artifactToken);
    expect(String(error)).not.toContain(accessToken);
    expect(log).not.toHaveBeenCalled();
    expect(checkoutSnapshot(dir)).toEqual(before);
  });
});

describe('updating to a newer main', () => {
  const remote = 'https://git.example/main';
  const updateResponse = (baseCommit: string, previousCommit: string | null = null) => Response.json({ ...checkoutDetails(baseCommit), remote, previousCommit });

  /** Main advances from the task base in a separate repository, as it would in Braid while the agent works. */
  function advanceMain(dir: string, baseCommit: string) {
    const upstream = join(root, 'upstream');
    git(root, 'clone', '-q', '--no-local', '--template=', '--', dir, upstream);
    git(upstream, 'reset', '-q', '--hard', baseCommit);
    put(upstream, 'src/other.ts', 'export const other = true;\n');
    git(upstream, 'add', 'src/other.ts');
    git(upstream, 'commit', '-m', 'Main advanced');
    return { upstream, main: git(upstream, 'rev-parse', 'HEAD') };
  }

  /** Runs Git's real fetch from the local upstream instead of the network remote. */
  const fetching = (upstream: string, calls: string[][] = []) => (args: string[], options: GitOptions) => {
    calls.push(args);
    if (args[0] !== 'fetch') return cli.runGit(args, options);
    expect(options.token).toBe(artifactToken);
    expect(args.join(' ')).not.toContain(artifactToken);
    expect(args).toContain('--no-write-fetch-head');
    expect(statSync(options.env!.GIT_ASKPASS!).mode & 0o777).toBe(0o700);
    git(options.cwd!, ...args.map(arg => arg === remote ? upstream : arg));
    return Buffer.from('');
  };

  it('fetches main without touching the branch, files or receipts and records it as the next submission base', async () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-am', 'First result');
    await cli.submit(submission(dir), { env: env(), fetch: vi.fn().mockResolvedValue(Response.json({ commit })), log: vi.fn() });
    const completed = readFileSync(join(dir, '.braid/submission.json'), 'utf8'), { upstream, main } = advanceMain(dir, baseCommit);
    put(dir, 'notes.txt', 'Uncommitted notes\n');
    const head = git(dir, 'rev-parse', 'HEAD'), branch = git(dir, 'branch', '--show-current'), status = git(dir, 'status', '--porcelain'), refs = git(dir, 'for-each-ref');
    const calls: string[][] = [], log = vi.fn(), fetch = vi.fn().mockResolvedValue(updateResponse(main, commit));
    const updated = await cli.main(['update', '--dir', dir], { env: env(), fetch, git: fetching(upstream, calls), log });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/api/missions/mission-one/agents/coder/update`, expect.objectContaining({ method: 'POST', body: '{}', redirect: 'error' }));
    expect(calls.map(args => args[0])).toEqual(['cat-file', 'fetch', 'cat-file']);
    expect([git(dir, 'rev-parse', 'HEAD'), git(dir, 'branch', '--show-current'), git(dir, 'status', '--porcelain'), git(dir, 'for-each-ref')]).toEqual([head, branch, status, refs]);
    expect(git(dir, 'cat-file', '-t', main)).toBe('commit');
    expect(existsSync(join(dir, '.git/FETCH_HEAD'))).toBe(false);
    expect(updated).toEqual(metadata(dir));
    expect(metadata(dir)).toMatchObject({ baseCommit: main, acceptedBase: baseCommit, previousCommit: commit, submissionMode: 'commits' });
    expect(readFileSync(join(dir, '.braid/submission.json'), 'utf8')).toBe(completed);
    const guide = readFileSync(join(dir, '.braid/TASK.md'), 'utf8');
    expect(guide).toContain(`Base commit: ${main}`);
    expect(guide).toContain(`Merge or rebase ${main} into your work`);
    for (const path of ['.braid/task.json', '.braid/TASK.md', '.git/config']) expect(readFileSync(join(dir, path), 'utf8')).not.toContain(artifactToken);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain(`git merge ${main}`);
    expect(output).toContain('rerun the repository checks');
    expect(output).not.toContain(artifactToken);
  });

  it('submits from the fetched main only once it is integrated and adopts it after acceptance', async () => {
    const { dir, baseCommit } = repository(['src/'], { submissionMode: 'commits', previousCommit: commit });
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-am', 'Reviewed work');
    const { upstream, main } = advanceMain(dir, baseCommit);
    await cli.update({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(updateResponse(main, commit)), git: fetching(upstream), log: vi.fn() });
    const unsent = vi.fn();
    await expect(cli.submit(submission(dir), { env: env(), fetch: unsent })).rejects.toThrow(new RegExp(`Merge or rebase the fetched main commit ${main}`));
    expect(unsent).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.braid/submission.json'))).toBe(false);
    // Braid keeps reporting the accepted base until a submission against the fetched main is accepted.
    const updated = readFileSync(join(dir, '.braid/task.json'), 'utf8'), log = vi.fn();
    await expect(cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(baseCommit, commit)), log })).resolves.toMatchObject({ baseCommit: main, acceptedBase: baseCommit });
    expect(readFileSync(join(dir, '.braid/task.json'), 'utf8')).toBe(updated);
    expect(log.mock.calls.flat().join(' ')).toContain(`Merge or rebase the fetched main commit ${main}`);
    git(dir, 'merge', '--no-edit', main);
    const second = 'c'.repeat(40), accepted = vi.fn().mockResolvedValue(Response.json({ commit: second }));
    await cli.submit(submission(dir), { env: env(), fetch: accepted, log: vi.fn() });
    expect(JSON.parse(accepted.mock.calls[0][1].body)).toEqual({ baseCommit: main, previousCommit: commit, summary: 'Update the answer', rationale: 'Match the requested behavior', files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });
    expect(metadata(dir)).toMatchObject({ baseCommit: main, previousCommit: second });
    expect(metadata(dir)).not.toHaveProperty('acceptedBase');
    await cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(main, second)), log: vi.fn() });
    await expect(cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(baseCommit, second)), log: vi.fn() })).rejects.toThrow(/pinned task base/);
  });

  it('refuses to update past an unconfirmed submission and retries exact requests before and after updating', async () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-am', 'First result');
    await expect(cli.submit(submission(dir), { env: env(), fetch: lost(), log: vi.fn() })).rejects.toThrow(/uncertain/);
    const pending = receipt(dir), { upstream, main } = advanceMain(dir, baseCommit), refused = vi.fn(), calls: string[][] = [];
    await expect(cli.update({ dir }, { env: env(), fetch: refused, git: fetching(upstream, calls) })).rejects.toThrow(/--retry before updating/);
    expect(refused).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(receipt(dir)).toEqual(pending);
    expect(metadata(dir).baseCommit).toBe(baseCommit);
    // Later commits never leak into the saved request.
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    git(dir, 'commit', '-am', 'Later work');
    const retried = vi.fn().mockResolvedValue(Response.json({ commit }));
    await cli.submit({ dir, retry: true }, { env: env(), fetch: retried, log: vi.fn() });
    expect(retried.mock.calls[0][1]).toMatchObject({ body: pending.body, headers: { 'Idempotency-Key': pending.key } });
    expect(JSON.parse(pending.body)).toMatchObject({ baseCommit, previousCommit: null, files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });

    await cli.update({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(updateResponse(main, commit)), git: fetching(upstream), log: vi.fn() });
    git(dir, 'merge', '--no-edit', main);
    await expect(cli.submit(submission(dir), { env: env(), fetch: lost(), log: vi.fn() })).rejects.toThrow(/uncertain/);
    const updatedPending = receipt(dir);
    expect(JSON.parse(updatedPending.body)).toMatchObject({ baseCommit: main, previousCommit: commit, files: [{ path: 'src/main.ts', content: 'export const answer = 3;\n' }] });
    expect(JSON.parse(readFileSync(join(dir, '.braid/submissions', `${pending.key}.json`), 'utf8'))).toMatchObject({ key: pending.key, body: pending.body, status: 'complete', commit });
    await expect(cli.update({ dir }, { env: env(), fetch: refused })).rejects.toThrow(/--retry before updating/);
    // Braid accepted it before the response was lost: renewal adopts the fetched base and keeps the receipt pending.
    const second = 'c'.repeat(40), log = vi.fn();
    await cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(main, second)), log });
    expect(metadata(dir)).toMatchObject({ baseCommit: main, previousCommit: second });
    expect(metadata(dir)).not.toHaveProperty('acceptedBase');
    expect(receipt(dir)).toEqual(updatedPending);
    expect(log.mock.calls.flat().join(' ')).toContain('--retry');
    const recovered = vi.fn().mockResolvedValue(Response.json({ commit: second }));
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch: recovered, log: vi.fn() })).resolves.toEqual({ commit: second });
    expect(recovered.mock.calls[0][1]).toMatchObject({ body: updatedPending.body, headers: { 'Idempotency-Key': updatedPending.key } });
    expect(receipt(dir)).toMatchObject({ status: 'complete', commit: second, key: updatedPending.key });
    expect(refused).not.toHaveBeenCalled();
  });

  it('leaves a current checkout unchanged when main has not moved', async () => {
    const { dir, baseCommit } = repository(), before = readFileSync(join(dir, '.braid/task.json'), 'utf8'), calls: string[][] = [], log = vi.fn();
    await cli.update({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(updateResponse(baseCommit)), git: fetching('unused', calls), log });
    expect(calls.map(args => args[0])).toEqual(['cat-file', 'cat-file']);
    expect(readFileSync(join(dir, '.braid/task.json'), 'utf8')).toBe(before);
    expect(log.mock.calls.flat().join(' ')).toContain('this checkout is current');
  });

  it.each([
    { kind: 'refusal', response: () => Response.json({ error: artifactToken }, { status: 409 }) },
    { kind: 'expanded scope', response: () => Response.json({ ...checkoutDetails(commit, ['src/', 'docs/']), remote }) },
    { kind: 'credential in context', response: () => Response.json({ ...checkoutDetails(commit), remote, context: [artifactToken] }) },
    { kind: 'invalid previous proposal', response: () => Response.json({ ...checkoutDetails(commit), remote, previousCommit: 'main' }) },
  ])('keeps the checkout unchanged after an update $kind', async ({ response }) => {
    const { dir } = committedRepository(), task = readFileSync(join(dir, '.braid/task.json'), 'utf8'), calls: string[][] = [];
    const work = () => [git(dir, 'rev-parse', 'HEAD'), git(dir, 'status', '--porcelain'), git(dir, 'for-each-ref'), readFileSync(join(dir, 'src/main.ts'), 'utf8')];
    const before = work();
    const error = await cli.update({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(response()), git: fetching('unused', calls), log: vi.fn() }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(cli.CliError);
    expect(String(error)).not.toContain(artifactToken);
    expect(calls).toEqual([]);
    expect(work()).toEqual(before);
    expect(readFileSync(join(dir, '.braid/task.json'), 'utf8')).toBe(task);
    expect(readdirSync(join(dir, '.braid')).sort()).toEqual(['task.json']);
  });
});

describe('patch collection', () => {
  function specialEntries(initialized = true) {
    const { dir } = repository(), module = join(dir, 'vendor/module');
    symlinkSync('src/main.ts', join(dir, 'alias.ts'));
    mkdirSync(module, { recursive: true });
    git(module, 'init', '--template=', '--initial-branch=main');
    put(module, 'child.txt', 'Original child\n');
    git(module, 'add', 'child.txt');
    git(module, 'commit', '-m', 'Submodule base');
    const moduleCommit = git(module, 'rev-parse', 'HEAD');
    git(dir, 'add', 'alias.ts');
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${moduleCommit},vendor/module`);
    git(dir, 'commit', '-m', 'Existing symlink and submodule');
    if (!initialized) { rmSync(module, { recursive: true }); mkdirSync(module); }
    const baseCommit = git(dir, 'rev-parse', 'HEAD');
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    return { dir, module, baseCommit };
  }

  it.each([false, true])('skips unchanged symlinks and submodules (initialized: %s)', initialized => {
    const { dir, baseCommit } = specialEntries(initialized);
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'src/main.ts', content: 'export const answer = 2;\n' }]);
    git(dir, 'commit', '-qam', 'Committed result');
    expect(cli.collectChanges(dir, baseCommit, [], { committed: true })).toEqual([{ path: 'src/main.ts', content: 'export const answer = 2;\n' }]);
  });

  it.each(['symlink', 'staged symlink', 'assume-unchanged symlink', 'deleted symlink', 'submodule HEAD', 'submodule file', 'submodule untracked file', 'staged submodule', 'submodule directory symlink'])('rejects changes to an existing %s', kind => {
    const { dir, module, baseCommit } = specialEntries();
    if (kind.includes('symlink') && !kind.startsWith('submodule')) {
      if (kind === 'assume-unchanged symlink') git(dir, 'update-index', '--assume-unchanged', 'alias.ts');
      unlinkSync(join(dir, 'alias.ts'));
      if (kind !== 'deleted symlink') symlinkSync('changed.ts', join(dir, 'alias.ts'));
      if (kind === 'staged symlink') {
        git(dir, 'add', 'alias.ts');
        unlinkSync(join(dir, 'alias.ts'));
        symlinkSync('src/main.ts', join(dir, 'alias.ts'));
      }
    } else if (kind === 'submodule HEAD') {
      put(module, 'child.txt', 'Changed child\n'); git(module, 'add', 'child.txt'); git(module, 'commit', '-m', 'Changed submodule');
    } else if (kind === 'submodule file') put(module, 'child.txt', 'Dirty submodule\n');
    else if (kind === 'submodule untracked file') put(module, 'untracked.txt', 'New submodule file\n');
    else if (kind === 'staged submodule') git(dir, 'update-index', '--cacheinfo', `160000,${baseCommit},vendor/module`);
    else if (kind === 'submodule directory symlink') {
      const external = join(root, 'external-module'); renameSync(module, external); symlinkSync(external, module);
    }
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/Symlinks|submodules|missing/);
  });

  it.each(['symlink', 'deleted symlink', 'submodule'])('rejects a committed change to an existing %s', kind => {
    const { dir, module, baseCommit } = specialEntries();
    if (kind === 'submodule') {
      put(module, 'child.txt', 'Changed child\n');
      git(module, 'commit', '-qam', 'Changed submodule');
    } else {
      unlinkSync(join(dir, 'alias.ts'));
      if (kind === 'symlink') symlinkSync('changed.ts', join(dir, 'alias.ts'));
    }
    git(dir, 'add', '-A', '--', 'src/main.ts', kind === 'submodule' ? 'vendor/module' : 'alias.ts');
    git(dir, 'commit', '-qm', 'Changed special entry');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(() => cli.collectChanges(dir, baseCommit, [], { committed: true })).toThrow(/Symlinks and submodules/);
  });

  it('collects staged, unstaged, and untracked UTF-8 changes without executing Git filters', () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'add', 'src/main.ts');
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    put(dir, 'src/new file.txt', '﻿Hello, café\n');
    put(dir, '.gitattributes', '*.ts filter=danger\n');
    git(dir, 'config', 'filter.danger.clean', `touch '${join(root, 'filter-ran')}'`);
    const files = cli.collectChanges(dir, baseCommit);
    expect(files).toContainEqual({ path: 'src/main.ts', content: 'export const answer = 3;\n' });
    expect(files).toContainEqual({ path: 'src/new file.txt', content: '﻿Hello, café\n' });
    expect(files.some((file: { path: string }) => file.path.startsWith('.braid/'))).toBe(false);
    expect(existsSync(join(root, 'filter-ran'))).toBe(false);
  });

  it('collects integrated commits and later edits against the pinned base', () => {
    const { dir, baseCommit } = repository();
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/No changed files/);
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'add', 'src/main.ts');
    git(dir, 'commit', '-m', 'Local commit');
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'src/main.ts', content: 'export const answer = 2;\n' }]);
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'src/main.ts', content: 'export const answer = 3;\n' }]);
    git(dir, 'checkout', '--orphan', 'unrelated');
    git(dir, 'add', 'src/main.ts');
    git(dir, 'commit', '-m', 'Unrelated history');
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/pinned base/);
  });

  it.each([false, true])('collects deleted files with staged=%s', staged => {
    const { dir, baseCommit } = repository();
    if (staged) git(dir, 'rm', '-q', 'src/main.ts');
    else unlinkSync(join(dir, 'src/main.ts'));
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'src/main.ts', content: null }]);
  });

  it('records executable modes and rejects deleting protected files', () => {
    const { dir, baseCommit } = repository(['*'], {}, { 'scripts/run.sh': 'echo run\n', '.env': 'MODE=local\n' });
    chmodSync(join(dir, 'scripts/run.sh'), 0o755);
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'scripts/run.sh', content: 'echo run\n', mode: '100755' }]);
    unlinkSync(join(dir, '.env'));
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/protected/);
  });

  it.each(['file', 'directory', 'staged'])('rejects %s symlinks and path escapes', kind => {
    const { dir, baseCommit } = repository();
    const external = join(root, 'external');
    mkdirSync(external);
    put(external, 'main.ts', 'private external content');
    if (kind === 'directory') {
      rmSync(join(dir, 'src'), { recursive: true });
      symlinkSync(external, join(dir, 'src'));
    } else {
      symlinkSync(join(external, 'main.ts'), join(dir, 'link.ts'));
      if (kind === 'staged') git(dir, 'add', 'link.ts');
    }
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/Symlinks/);
  });

  it.each(['.env', '.dev.vars.production', 'nested/credentials.json', 'nested/id_ed25519', '.braid/proposal.txt'])('rejects protected file %s', path => {
    const { dir, baseCommit } = repository();
    put(dir, path, 'content');
    git(dir, 'add', '--force', '--', path);
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/protected/);
    git(dir, 'commit', '-qm', 'Protected file');
    expect(() => cli.collectChanges(dir, baseCommit, [], { committed: true })).toThrow(/protected/);
  });

  it.each([Buffer.from([0xc3, 0x28]), Buffer.from('binary\0content'), Buffer.from([0x07, 0x61])])('rejects binary or invalid UTF-8 bytes %j', content => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', content);
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/UTF-8|Binary/);
    git(dir, 'commit', '-qam', 'Binary content');
    expect(() => cli.collectChanges(dir, baseCommit, [], { committed: true })).toThrow(/UTF-8|Binary/);
  });

  // Construct the synthetic header so the source archive never contains a private-key marker.
  it.each([accessToken, ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'const apiKey = "highly-sensitive-key";', 'AWS=AKIAABCDEFGHIJKLMNOP', 'https://user:password@example.test/private'])('blocks recognizable credentials in file content', content => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', content);
    expect(() => cli.collectChanges(dir, baseCommit, [accessToken])).toThrow(/secret/);
    git(dir, 'commit', '-qam', 'Credential');
    expect(() => cli.collectChanges(dir, baseCommit, [accessToken], { committed: true })).toThrow(/secret/);
  });

  it('enforces the 256-file and 3 MiB limits, including multi-byte text', () => {
    const { dir, baseCommit } = repository();
    const large = 'é'.repeat(1_572_864);
    put(dir, 'large.txt', large);
    expect(cli.collectChanges(dir, baseCommit)).toEqual([{ path: 'large.txt', content: large }]);
    put(dir, 'extra.txt', 'x');
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/3 MiB/);
    git(dir, 'add', 'large.txt', 'extra.txt');
    git(dir, 'commit', '-qm', 'Too large');
    expect(() => cli.collectChanges(dir, baseCommit, [], { committed: true })).toThrow(/3 MiB/);
    git(dir, 'rm', '-q', 'large.txt', 'extra.txt');
    for (let index = 0; index < 256; index++) put(dir, `many/${index}.txt`, 'x');
    expect(cli.collectChanges(dir, baseCommit)).toHaveLength(256);
    put(dir, 'many/256.txt', 'x');
    expect(() => cli.collectChanges(dir, baseCommit)).toThrow(/256 UTF-8 text files/);
  });
});

describe('committed submissions', () => {
  it('submit the committed tree, including deletions and executable modes', () => {
    const { dir, baseCommit } = repository(['*'], { submissionMode: 'commits' }, { 'scripts/run.sh': 'echo run\n', 'docs/old.md': 'Old\n' });
    git(dir, 'rm', '-q', 'docs/old.md');
    chmodSync(join(dir, 'scripts/run.sh'), 0o755);
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'Committed result');
    expect(cli.collectChanges(dir, baseCommit, [], { committed: true })).toEqual([
      { path: 'docs/old.md', content: null },
      { path: 'scripts/run.sh', content: 'echo run\n', mode: '100755' },
      { path: 'src/main.ts', content: 'export const answer = 2;\n' },
    ]);
  });

  it('reads committed objects rather than working files that Git was told to ignore', () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Committed result');
    git(dir, 'update-index', '--assume-unchanged', 'src/main.ts');
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    expect(cli.collectChanges(dir, baseCommit, [], { committed: true })).toEqual([{ path: 'src/main.ts', content: 'export const answer = 2;\n' }]);
  });

  it.each(['edited', 'staged', 'untracked'])('refuses %s work that is not committed before sending anything', async kind => {
    const { dir } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Committed result');
    if (kind === 'untracked') put(dir, 'src/new.ts', 'export {};\n');
    else {
      put(dir, 'src/main.ts', 'export const answer = 3;\n');
      if (kind === 'staged') git(dir, 'add', 'src/main.ts');
    }
    const fetch = vi.fn();
    await expect(cli.submit(submission(dir), { env: env(), fetch })).rejects.toThrow(/Commit the work/);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.braid/submission.json'))).toBe(false);
  });

  it.each(['working file', 'index', 'HEAD'])('rejects a %s change during collection before sending anything', async kind => {
    const { dir } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Committed result');
    let changed = false;
    const runner = (args: string[], options: GitOptions) => {
      if (args[0] === 'cat-file' && args[1] === 'blob' && !changed) {
        changed = true;
        if (kind === 'working file') put(dir, 'src/main.ts', 'export const answer = 3;\n');
        else if (kind === 'index') { put(dir, 'src/late.ts', 'export {};\n'); git(dir, 'add', 'src/late.ts'); }
        else { put(dir, 'src/main.ts', 'export const answer = 4;\n'); git(dir, 'commit', '-qam', 'Late commit'); }
      }
      return cli.runGit(args, options);
    };
    const fetch = vi.fn();
    await expect(cli.submit(submission(dir), { env: env(), fetch, git: runner })).rejects.toThrow(/changed while preparing/);
    expect(changed).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.braid/submission.json'))).toBe(false);
  });

  it('rejects a HEAD change while collecting uncommitted edits from an earlier checkout', () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    let changed = false;
    const runner = (args: string[], options: GitOptions) => {
      if (args.includes('--others') && !changed) { changed = true; git(dir, 'commit', '-qam', 'Concurrent commit'); }
      return cli.runGit(args, options);
    };
    expect(() => cli.collectChanges(dir, baseCommit, [], { git: runner })).toThrow(/changed while preparing/);
    expect(changed).toBe(true);
  });
});

describe('revisions', () => {
  it('replays identical work, revises from the latest receipt, and archives the replaced receipt', async () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'First result');
    const second = 'c'.repeat(40), log = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ commit })).mockResolvedValueOnce(Response.json({ commit: second }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log })).resolves.toEqual({ commit });
    const first = receipt(dir);
    expect(JSON.parse(first.body)).toMatchObject({ baseCommit, previousCommit: null });
    expect(metadata(dir).previousCommit).toBe(commit);
    await expect(cli.submit(submission(dir), { env: env(), fetch, log })).resolves.toEqual({ commit });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(receipt(dir)).toEqual(first);
    put(dir, 'src/extra.ts', 'export const extra = 1;\n');
    git(dir, 'add', 'src/extra.ts');
    git(dir, 'commit', '-qm', 'Revision');
    await expect(cli.submit(submission(dir), { env: env(), fetch, log })).resolves.toEqual({ commit: second });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      baseCommit, previousCommit: commit, summary: 'Update the answer', rationale: 'Match the requested behavior',
      files: [{ path: 'src/extra.ts', content: 'export const extra = 1;\n' }, { path: 'src/main.ts', content: 'export const answer = 2;\n' }],
    });
    expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(first.key);
    expect(JSON.parse(readFileSync(join(dir, '.braid/submissions', `${first.key}.json`), 'utf8'))).toEqual(first);
    expect(statSync(join(dir, '.braid/submissions')).mode & 0o777).toBe(0o700);
    expect(receipt(dir)).toMatchObject({ status: 'complete', commit: second });
    expect(metadata(dir).previousCommit).toBe(second);
    expect(log.mock.calls.flat().join('\n')).toContain(`Submitted proposal ${second} for review, replacing ${commit}.`);
  });

  it('does not replay an older receipt after Braid reports a newer proposal', async () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'First result');
    await cli.submit(submission(dir), { env: env(), fetch: vi.fn().mockResolvedValue(Response.json({ commit })), log: vi.fn() });
    const newer = 'c'.repeat(40), latest = 'd'.repeat(40);
    await cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(baseCommit, newer)), log: vi.fn() });
    const fetch = vi.fn().mockResolvedValue(Response.json({ commit: latest }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).resolves.toEqual({ commit: latest });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ baseCommit, previousCommit: newer });
  });

  it('resends or replays a receipt saved by an earlier release without previousCommit', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const body = JSON.stringify({ baseCommit, summary: 'Update the answer', rationale: 'Match the requested behavior', files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });
    const saved = { url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', key: 'earlier-release-key-0123', body, status: 'pending' };
    put(dir, '.braid/submission.json', JSON.stringify(saved));
    const fetch = vi.fn().mockResolvedValue(Response.json({ commit }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).resolves.toEqual({ commit });
    expect(fetch.mock.calls[0][1]).toMatchObject({ body, headers: { 'Idempotency-Key': saved.key } });
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).resolves.toEqual({ commit });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metadata(dir).previousCommit).toBe(commit);
  });

  it('revises a proposal confirmed by an earlier release from its saved receipt', async () => {
    const { dir, baseCommit } = repository();
    const body = JSON.stringify({ baseCommit, summary: 'Update the answer', rationale: 'Match the requested behavior', files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });
    put(dir, '.braid/submission.json', JSON.stringify({ url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', key: 'earlier-release-key-0123', body, status: 'complete', commit }));
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    const latest = 'c'.repeat(40), fetch = vi.fn().mockResolvedValue(Response.json({ commit: latest }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).resolves.toEqual({ commit: latest });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ baseCommit, previousCommit: commit, files: [{ path: 'src/main.ts', content: 'export const answer = 3;\n' }] });
    expect(metadata(dir).previousCommit).toBe(latest);
  });

  it('treats a refused first attempt as rejected so a resumed revision can be sent', async () => {
    const { dir, baseCommit } = repository(['src/'], { submissionMode: 'commits', previousCommit: commit });
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Revision');
    const newer = 'c'.repeat(40), latest = 'd'.repeat(40), detail = 'Server detail that is not echoed';
    const refused = vi.fn().mockResolvedValue(Response.json({ error: detail }, { status: 409 }));
    const error = await cli.submit(submission(dir), { env: env(), fetch: refused, log: vi.fn() }).catch((error: Error) => error);
    expect(String(error)).toMatch(/rejected \(HTTP 409\).*run resume/);
    expect(String(error)).not.toContain(detail);
    expect(receipt(dir).status).toBe('rejected');
    await cli.resume({ dir }, { env: env(), fetch: vi.fn().mockResolvedValue(renewal(baseCommit, newer)), log: vi.fn() });
    const accepted = vi.fn().mockResolvedValue(Response.json({ commit: latest }));
    await cli.submit(submission(dir), { env: env(), fetch: accepted, log: vi.fn() });
    expect(JSON.parse(accepted.mock.calls[0][1].body).previousCommit).toBe(newer);
    expect(accepted.mock.calls[0][1].headers['Idempotency-Key']).not.toBe(refused.mock.calls[0][1].headers['Idempotency-Key']);
  });

  it('keeps an uncertain submission pending when its retry is refused', async () => {
    const { dir } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Result');
    await expect(cli.submit(submission(dir), { env: env(), fetch: lost(), log: vi.fn() })).rejects.toThrow(/uncertain/);
    const pending = receipt(dir);
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch: vi.fn().mockResolvedValue(Response.json({}, { status: 409 })), log: vi.fn() })).rejects.toThrow(/unconfirmed \(HTTP 409\)/);
    expect(receipt(dir)).toEqual(pending);
  });
});

describe('submission receipts and reported tests', () => {
  it('persists the exact body and key before sending and retries them after a lost response', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const log = vi.fn(), timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn(async (_url: string, request: RequestInit) => {
      const saved = receipt(dir);
      expect(saved.status).toBe('pending');
      expect(saved.body).toBe(request.body);
      expect(saved.key).toBe((request.headers as Record<string, string>)['Idempotency-Key']);
      throw new Error(`Network failure containing ${accessToken} and private request data`);
    });
    await expect(cli.submit(submission(dir), { env: env(), fetch, log })).rejects.toThrow(/outcome is uncertain/);
    const pending = receipt(dir);
    expect(statSync(join(dir, '.braid/submission.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.braid')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(pending.body)).toEqual({ baseCommit, previousCommit: null, summary: 'Update the answer', rationale: 'Match the requested behavior', files: [{ path: 'src/main.ts', content: 'export const answer = 2;\n' }] });
    expect(readFileSync(join(dir, '.braid/submission.json'), 'utf8')).not.toContain(accessToken);
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(log).not.toHaveBeenCalled();
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    await expect(cli.submit(submission(dir), { env: env(), fetch, log })).rejects.toThrow(/earlier submission/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const recovered = vi.fn().mockResolvedValue(Response.json({ commit }));
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch: recovered, log })).resolves.toEqual({ commit });
    expect(recovered.mock.calls[0][1].body).toBe(pending.body);
    expect(recovered.mock.calls[0][1].headers['Idempotency-Key']).toBe(pending.key);
    expect(recovered.mock.calls[0][0]).toBe(`${origin}/api/missions/mission-one/agents/coder/submit`);
    expect(recovered.mock.calls[0][1].headers).toMatchObject({ Authorization: `Bearer ${accessToken}`, 'X-Braid-Workspace': 'workspace-one' });
    await cli.submit({ dir, retry: true }, { env: env(), fetch: recovered, log });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('\n')).toContain('agent-reported and unverified');
    expect(receipt(dir)).toMatchObject({ status: 'complete', commit, key: pending.key });
  });

  it.each(['server-error', 'invalid-success'])('keeps %s outcomes uncertain and reuses the key for identical payloads', async kind => {
    const { dir } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const fetch = vi.fn()
      .mockResolvedValueOnce(kind === 'server-error' ? Response.json({ error: accessToken }, { status: 503 }) : Response.json({ commit: 'not-a-commit', token: accessToken }))
      .mockResolvedValueOnce(Response.json({ commit }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/unconfirmed|receipt/);
    await cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() });
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetch.mock.calls[1][1].headers['Idempotency-Key']);
  });

  it('keeps an earlier outcome uncertain when retry authorization has expired', async () => {
    const { dir } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValueOnce(Response.json({ error: 'Expired access' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ commit }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/uncertain/);
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/unconfirmed/);
    expect(receipt(dir).status).toBe('pending');
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/earlier submission/);
    expect(fetch).toHaveBeenCalledTimes(2);
    await cli.submit({ dir, retry: true }, { env: env(), fetch, log: vi.fn() });
    expect(new Set(fetch.mock.calls.map(call => call[1].headers['Idempotency-Key'])).size).toBe(1);
    expect(new Set(fetch.mock.calls.map(call => call[1].body)).size).toBe(1);
  });

  it('renews an expired task claim during submit and resends the same body and key', async () => {
    const { dir, baseCommit } = committedRepository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Result');
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Check out this lane' }, { status: 403 }))
      .mockResolvedValueOnce(renewal(baseCommit, null))
      .mockResolvedValueOnce(Response.json({ commit }));
    await expect(cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() })).resolves.toEqual({ commit });
    expect(fetch.mock.calls.map(call => call[0].split('/').at(-1))).toEqual(['submit', 'checkout', 'submit']);
    expect(fetch.mock.calls[2][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(fetch.mock.calls[2][1].headers['Idempotency-Key']).toBe(fetch.mock.calls[0][1].headers['Idempotency-Key']);
  });

  it('checks secrets in metadata and saved retries before sending anything', async () => {
    const { dir, baseCommit } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const fetch = vi.fn();
    await expect(cli.submit({ ...submission(dir), rationale: 'password = "highly-sensitive-password"' }, { env: env(), fetch })).rejects.toThrow(/secret/);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.braid/submission.json'))).toBe(false);
    put(dir, '.braid/submission.json', JSON.stringify({ url: origin, workspaceId: 'workspace-one', missionId: 'mission-one', agentId: 'coder', key: 'saved-key-0123456789', status: 'pending', body: JSON.stringify({ baseCommit, summary: 'A change', rationale: 'An explanation', files: [{ path: 'src/main.ts', content: 'const password = "highly-sensitive-password";' }] }) }));
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch })).rejects.toThrow(/secret/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers an interrupted process lock and refuses symlinked task metadata', async () => {
    const { dir } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    put(dir, '.braid/submission.lock', JSON.stringify({ pid: 2_147_483_647 }));
    const fetch = vi.fn().mockResolvedValue(Response.json({ commit }));
    await cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() });
    expect(existsSync(join(dir, '.braid/submission.lock'))).toBe(false);
    const task = join(dir, '.braid/task.json'), external = join(root, 'external-task.json');
    writeFileSync(external, readFileSync(task));
    unlinkSync(task);
    symlinkSync(external, task);
    await expect(cli.submit({ dir, retry: true }, { env: env(), fetch })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows corrections after a definite rejection and submits only explicitly reported tests', async () => {
    const { dir } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    const tests = join(root, 'tests.json');
    writeFileSync(tests, JSON.stringify([{ command: 'npm test', result: 'not-run', detail: 'Dependencies unavailable' }]));
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Invalid proposal' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ commit }));
    await expect(cli.submit({ ...submission(dir), tests, model: 'local-codex' }, { env: env(), fetch, log: vi.fn() })).rejects.toThrow(/rejected/);
    put(dir, 'src/main.ts', 'export const answer = 3;\n');
    await cli.submit({ ...submission(dir), tests, model: 'local-codex' }, { env: env(), fetch, log: vi.fn() });
    expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(fetch.mock.calls[0][1].headers['Idempotency-Key']);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ model: 'local-codex', tests: [{ command: 'npm test', result: 'not-run', detail: 'Dependencies unavailable' }] });
    expect(() => cli.validateTests(Array(11).fill({ command: 'npm test', result: 'passed' }))).toThrow(/at most 10/);
    expect(() => cli.validateTests([{ command: 'npm test', result: 'maybe' }])).toThrow(/result/);
    expect(() => cli.validateTests([{ command: 'x'.repeat(401), result: 'passed' }])).toThrow(/test command/);
    expect(() => cli.validateTests([{ command: 'npm test', result: 'passed', detail: 'x'.repeat(2001) }])).toThrow(/test detail/);
  });

  it('blocks concurrent submits and mismatched workspaces without another request', async () => {
    const { dir } = repository();
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    let complete!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
    const first = cli.submit(submission(dir), { env: env(), fetch, log: vi.fn() });
    await expect(cli.submit(submission(dir), { env: env(), fetch })).rejects.toThrow(/Another submit/);
    await expect(cli.update({ dir }, { env: env(), fetch })).rejects.toThrow(/Another submit or update/);
    expect(fetch).toHaveBeenCalledTimes(1);
    complete(Response.json({ commit }));
    await first;
    await expect(cli.submit(submission(dir), { env: { ...env(), BRAID_WORKSPACE_ID: 'different-workspace' }, fetch })).rejects.toThrow(/does not match/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('proof attached with --proof', { timeout: 30_000 }, () => {
  const cliPath = fileURLToPath(new URL('../../public/cli/braid.mjs', import.meta.url));
  const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  /** A check that runs a short Node.js script. */
  const node = (code: string) => `${sh(process.execPath)} -e ${sh(code)}`;
  const ok = node("console.log('ok')");
  const submitArgs = (dir: string) => ['change', 'submit', '--dir', dir, '--title', 'Change the answer', '--summary', 'Answer 2.', '--proof'];
  const leftovers: number[] = [];
  afterEach(() => { for (const pid of leftovers.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } });
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function until(condition: () => boolean, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async function freePort() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    return port;
  }

  /** A change checkout holding one committed change, with the given .braid/proof.json. */
  function changeCheckout(proof?: unknown) {
    const dir = join(root, 'work');
    mkdirSync(dir);
    git(dir, 'init', '--template=', '--initial-branch=main');
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'gc.auto', '0');
    put(dir, 'src/main.ts', 'export const answer = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Base');
    const base = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, '.braid'), { mode: 0o700 });
    writeFileSync(join(dir, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'workspace-one', base }), { mode: 0o600 });
    put(dir, '.git/info/exclude', '.braid/\n');
    put(dir, 'src/main.ts', 'export const answer = 2;\n');
    git(dir, 'commit', '-qam', 'Change the answer');
    if (proof !== undefined) put(dir, '.braid/proof.json', JSON.stringify(proof));
    return { dir, base };
  }

  /** Braid's change API. Requests to the preview's origin reach the real preview; nothing else answers. */
  function braid({ preview, unavailable = 0 }: { preview?: string; unavailable?: number } = {}) {
    const posts: { path: string; body: string; key: string | null }[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.origin === preview) return globalThis.fetch(input, init);
      if (url.origin !== origin) throw new TypeError('fetch failed');
      if (url.pathname === '/api/agent/session') return Response.json({ accessToken: 'braid_at_test.signature' });
      if (init.method === 'POST' && /^\/api\/changes(?:\/ch_3abcdefabcdef\/revisions)?$/.test(url.pathname)) {
        posts.push({ path: url.pathname, body: String(init.body), key: new Headers(init.headers).get('idempotency-key') });
        if (unavailable-- > 0) return new Response('Unavailable', { status: 503 });
        const body = JSON.parse(String(init.body));
        return Response.json({ id: 'ch_3abcdefabcdef', number: 42, title: body.title, status: 'open', revision: (body.previousRevision ?? 0) + 1 }, { status: 201 });
      }
      return Response.json({ error: 'Not found.' }, { status: 404 });
    });
    return { fetch, posts, evidence: () => JSON.parse(posts.at(-1)!.body).evidence };
  }

  /** An npx first on PATH that stands in for Playwright: it records its arguments and writes a PNG header the size of the viewport. */
  function fakePlaywright(mode: 'installed' | 'missing' | 'browser' = 'installed') {
    const bin = join(root, 'bin'), calls = join(root, 'npx-calls.jsonl');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), [
      `#!${process.execPath}`,
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
      `const mode = ${JSON.stringify(mode)};`,
      "if (mode === 'missing') { console.error('npm error npx canceled due to missing packages and no YES option: [\"playwright@1.64.0\"]'); process.exit(1); }",
      "if (args.includes('--version')) { console.log('Version 1.64.0'); process.exit(0); }",
      "if (mode === 'browser') { console.error(\"browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome\\nPlease run the following command to download new browsers: npx playwright install\"); process.exit(1); }",
      "const [width, height] = args.find(arg => arg.startsWith('--viewport-size=')).slice(16).split(',').map(Number);",
      'const png = Buffer.alloc(33);',
      "Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);",
      'png.writeUInt32BE(width, 16);',
      'png.writeUInt32BE(height, 20);',
      'writeFileSync(args.at(-1), png);',
    ].join('\n'), { mode: 0o755 });
    return {
      env: { ...env(), PATH: `${bin}${delimiter}${process.env.PATH}` },
      calls: (): string[][] => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    };
  }

  /** A preview that starts a helper in its own process group and records both process IDs; `silent` never answers. */
  function previewServer() {
    const script = join(root, 'preview.mjs'), pids = join(root, 'preview-pids.json');
    writeFileSync(script, [
      "import { createServer } from 'node:http';",
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'writeFileSync(process.env.PREVIEW_PIDS, JSON.stringify([process.pid, helper.pid]));',
      "if (process.argv[2] === 'silent') setInterval(() => {}, 1000);",
      "else createServer((request, response) => response.end('<h1>Preview</h1>')).listen(Number(process.argv[2]), '127.0.0.1');",
    ].join('\n'));
    const read = (): number[] => { try { return JSON.parse(readFileSync(pids, 'utf8')); } catch { return []; } };
    return {
      command: (port: number | 'silent') => `${sh(process.execPath)} ${sh(script)} ${port}`,
      env: { PREVIEW_PIDS: pids },
      pids: () => { const found = read(); leftovers.push(...found); return found; },
    };
  }

  describe('.braid/proof.json', () => {
    it('accepts checks and a local preview, filling in the defaults', () => {
      expect(cli.validateProof({ checks: ['npm test', ' npm run build '], preview: { command: 'npm run dev -- --port 4319', url: 'http://127.0.0.1:4319/', pages: ['/', '/settings?tab=rules'] } })).toEqual({
        checks: ['npm test', 'npm run build'], timeoutSeconds: 600,
        preview: { command: 'npm run dev -- --port 4319', url: 'http://127.0.0.1:4319', pages: ['/', '/settings?tab=rules'], timeoutSeconds: 120 },
      });
      expect(cli.validateProof({ preview: { command: 'npm run preview', url: 'http://[::1]:4173', timeoutSeconds: 600 } }))
        .toEqual({ checks: [], timeoutSeconds: 600, preview: { command: 'npm run preview', url: 'http://[::1]:4173', pages: ['/'], timeoutSeconds: 600 } });
      expect(cli.validateProof({ checks: ['npm test'], timeoutSeconds: 3600 })).toEqual({ checks: ['npm test'], timeoutSeconds: 3600 });
      expect(cli.validateProof({ checks: Array(9).fill('npm test'), preview: { command: 'npm run dev', url: 'http://localhost:5173', pages: Array(6).fill('/') } }).preview.pages).toHaveLength(6);
    });

    const preview = (changes: Record<string, unknown>) => ({ preview: { command: 'npm run dev', url: 'http://127.0.0.1:4319', ...changes } });
    it.each([
      ['a list', []], ['nothing to run', {}], ['an unknown field', { checks: ['npm test'], retries: 2 }],
      ['eleven checks', { checks: Array(11).fill('npm test') }], ['a long check', { checks: ['x'.repeat(301)] }],
      ['a check over two lines', { checks: ['npm test\ncurl https://example.com'] }], ['an empty check', { checks: [' '] }], ['a check that is not text', { checks: [42] }],
      ['a zero timeout', { checks: ['npm test'], timeoutSeconds: 0 }], ['a fractional timeout', { checks: ['npm test'], timeoutSeconds: 1.5 }], ['a timeout over an hour', { checks: ['npm test'], timeoutSeconds: 3601 }],
      ['an HTTPS preview', preview({ url: 'https://127.0.0.1:4319' })], ['a remote preview', preview({ url: 'http://example.com:4319' })],
      ['a preview without a port', preview({ url: 'http://127.0.0.1' })], ['a preview with a path', preview({ url: 'http://127.0.0.1:4319/app' })],
      ['a preview with credentials', preview({ url: 'http://user:password@127.0.0.1:4319' })], ['a port out of range', preview({ url: 'http://127.0.0.1:65536' })],
      ['a relative page', preview({ pages: ['settings'] })], ['a page on another host', preview({ pages: ['//example.com/'] })],
      ['a page with a backslash', preview({ pages: ['/\\example.com'] })], ['a page with a space', preview({ pages: ['/a b'] })],
      ['no pages', preview({ pages: [] })], ['seven pages', preview({ pages: Array(7).fill('/') })],
      ['a preview without a command', { preview: { url: 'http://127.0.0.1:4319' } }], ['an unknown preview field', preview({ open: true })],
      ['ten checks and a preview', { checks: Array(10).fill('npm test'), ...preview({}) }],
      ['a credential in a check', { checks: ['API_KEY=abcdefghijklmnopqrstuv npm test'] }],
      ['a credential in the preview', preview({ command: `GITHUB_TOKEN=${'gh'}p_${'a'.repeat(36)} npm run dev` })],
    ])('rejects %s', (_, proof) => {
      expect(() => cli.validateProof(proof)).toThrow(cli.CliError);
    });

    it('is documented with valid examples in HELP and both agent guides, along with the loop', async () => {
      const log = vi.fn();
      await cli.main(['--help'], { log });
      const example = (text: string) => JSON.parse(/\{"checks"[\s\S]*?\}\}/.exec(text)![0]);
      expect(cli.validateProof(example(log.mock.calls[0][0]))).toMatchObject({ checks: ['npm test', 'npm run build'], preview: { pages: ['/', '/settings'] } });
      for (const path of ['/changes.md', '/local-agents.md']) {
        const guide = setupGuide(path, origin)!;
        expect(cli.validateProof(example(guide)).preview.url).toBe('http://127.0.0.1:4319');
        for (const text of ['--proof', 'npx playwright install chromium', 'Instructions from Braid', 'Do not stop, and do not ask the person to say continue', '--retry']) expect(guide).toContain(text);
      }
    });

    it.each([
      ['missing', undefined, /Add \.braid\/proof\.json/],
      ['not JSON', '{"checks": [', /not valid JSON/],
      ['a symlink', 'symlink', /regular file/],
    ])('refuses --proof when the file is %s, before running or sending anything', async (_, content, message) => {
      const { dir } = changeCheckout();
      if (content === 'symlink') { put(root, 'elsewhere.json', JSON.stringify({ checks: ['npm test'] })); symlinkSync(join(root, 'elsewhere.json'), join(dir, '.braid/proof.json')); }
      else if (content !== undefined) put(dir, '.braid/proof.json', content);
      const api = braid();
      await expect(cli.main(submitArgs(dir), { env: env(), fetch: api.fetch, log: vi.fn() })).rejects.toThrow(message);
      expect(api.fetch).not.toHaveBeenCalled();
      expect(existsSync(join(dir, '.braid/change-submission.json'))).toBe(false);
    });
  });

  describe('checks', () => {
    it('runs each check in the checkout and attaches its exit code and the end of its output, even when it fails', async () => {
      const noisy = node("process.stdout.write('x'.repeat(9000) + '\\nprogress 10%\\rprogress 100%\\n\\x1b[31mlast\\x1b[0m line\\n'); process.exit(3)");
      const environment = node("console.log(Object.keys(process.env).filter(key => key.startsWith('BRAID_')).length, process.env.CI, process.cwd())");
      const { dir } = changeCheckout({ checks: [noisy, environment] });
      const settings: NodeJS.ProcessEnv = { ...env() };
      delete settings.CI;
      const api = braid(), log = vi.fn();
      await cli.main(submitArgs(dir), { env: settings, fetch: api.fetch, log });
      const [failed, passed] = api.evidence();
      expect(failed).toEqual({ kind: 'command', command: noisy, exitCode: 3, output: expect.any(String), durationMs: expect.any(Number) });
      expect(failed.output).toHaveLength(8000);
      expect(failed.output.endsWith('xxx\nprogress 100%\nlast line\n')).toBe(true);
      // Checks never see the Braid credentials, and run non-interactively.
      expect(passed).toEqual({ kind: 'command', command: environment, exitCode: 0, output: `0 true ${dir}\n`, durationMs: expect.any(Number) });
      expect([failed.durationMs, passed.durationMs].every(Number.isInteger)).toBe(true);
      expect(log.mock.calls.flat().join('\n')).toContain(`Proof: ${noisy} exited 3 after`);
    });

    it('stops a check at its timeout, with everything it started, and records exit 124', async () => {
      const script = join(root, 'slow.cjs'), helperFile = join(root, 'helper.pid');
      writeFileSync(script, [
        "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "require('node:fs').writeFileSync(process.env.HELPER_PID, String(helper.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n'));
      const slow = `${sh(process.execPath)} ${sh(script)}`;
      const { dir } = changeCheckout({ checks: [slow], timeoutSeconds: 1 });
      const api = braid();
      await cli.main(submitArgs(dir), { env: { ...env(), HELPER_PID: helperFile }, fetch: api.fetch, log: vi.fn() });
      const [evidence] = api.evidence();
      expect(evidence).toEqual({ kind: 'command', command: slow, exitCode: 124, output: 'Stopped after 1 s.', durationMs: expect.any(Number) });
      expect(evidence.durationMs).toBeLessThan(10_000);
      const helper = Number(readFileSync(helperFile, 'utf8'));
      leftovers.push(helper);
      await until(() => !running(helper));
    });

    it('refuses to upload output that looks like a credential', async () => {
      const { dir } = changeCheckout({ checks: [node("console.log('token ' + 'gh' + 'p_' + 'a'.repeat(36))")] });
      const api = braid();
      await expect(cli.main(submitArgs(dir), { env: env(), fetch: api.fetch, log: vi.fn() })).rejects.toThrow(/looks like it contains a credential, so nothing was submitted/);
      expect(api.fetch).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, '.braid')).sort()).toEqual(['change.json', 'proof.json']);
    });

    it('refuses proof from a check that edits tracked files', async () => {
      const { dir } = changeCheckout({ checks: [node("require('node:fs').writeFileSync('src/main.ts', 'export const answer = 3;\\n')")] });
      const api = braid();
      await expect(cli.main(submitArgs(dir), { env: env(), fetch: api.fetch, log: vi.fn() })).rejects.toThrow(/changed HEAD or tracked files/);
      expect(api.fetch).not.toHaveBeenCalled();
    });
  });

  describe('preview and screenshots', () => {
    it('screenshots each page at desktop and phone size, then stops the preview and everything it started', async () => {
      const port = await freePort(), server = previewServer(), playwright = fakePlaywright(), url = `http://127.0.0.1:${port}`;
      const { dir } = changeCheckout({ checks: [ok], preview: { command: server.command(port), url, pages: ['/', '/settings'], timeoutSeconds: 30 } });
      const api = braid({ preview: url }), log = vi.fn();
      await cli.main(submitArgs(dir), { env: { ...playwright.env, ...server.env }, fetch: api.fetch, log });
      const pids = server.pids();
      expect(pids).toHaveLength(2);
      await until(() => !pids.some(running));
      const calls = playwright.calls(), shot = (size: string, page: string) => ['--no-install', 'playwright', 'screenshot', `--viewport-size=${size}`, '--wait-for-timeout=1000', `${url}${page}`];
      expect(calls[0]).toEqual(['--no-install', 'playwright', '--version']);
      expect(calls.slice(1).map(args => args.slice(0, -1))).toEqual([shot('1280,800', '/'), shot('390,844', '/'), shot('1280,800', '/settings'), shot('390,844', '/settings')]);
      for (const args of calls.slice(1)) expect(existsSync(args.at(-1)!)).toBe(false);
      const evidence = api.evidence();
      expect(evidence[0]).toMatchObject({ kind: 'command', command: ok, exitCode: 0, output: 'ok\n' });
      expect(evidence.slice(1).map(({ data: _, ...item }: { data: string }) => item)).toEqual([
        { kind: 'screenshot', page: '/', viewport: 'desktop', width: 1280, height: 800, contentType: 'image/png' },
        { kind: 'screenshot', page: '/', viewport: 'mobile', width: 390, height: 844, contentType: 'image/png' },
        { kind: 'screenshot', page: '/settings', viewport: 'desktop', width: 1280, height: 800, contentType: 'image/png' },
        { kind: 'screenshot', page: '/settings', viewport: 'mobile', width: 390, height: 844, contentType: 'image/png' },
      ]);
      expect(cli.imageInfo(Buffer.from(evidence[2].data, 'base64'))).toEqual({ contentType: 'image/png', width: 390, height: 844 });
      expect(cli.validateEvidence(evidence)).toBe(evidence);
      expect(log.mock.calls.flat().join('\n')).toContain(`Proof: 4 screenshots of ${url}.`);
    });

    it.each(['missing', 'browser'] as const)('submits the checks without screenshots when Playwright is %s', async mode => {
      const port = await freePort(), server = previewServer(), playwright = fakePlaywright(mode), url = `http://127.0.0.1:${port}`;
      const { dir } = changeCheckout({ checks: [ok], preview: { command: server.command(port), url, timeoutSeconds: 30 } });
      const api = braid({ preview: url }), log = vi.fn();
      await cli.main(submitArgs(dir), { env: { ...playwright.env, ...server.env }, fetch: api.fetch, log });
      expect(api.evidence()).toEqual([{ kind: 'command', command: ok, exitCode: 0, output: 'ok\n', durationMs: expect.any(Number) }]);
      expect(log.mock.calls.flat().filter((line: string) => line.includes('npx playwright install chromium')))
        .toEqual(['Screenshots skipped: Playwright or its browser is not installed here. Enable them with: npx playwright install chromium']);
      expect(playwright.calls().map(args => args.slice(0, 3))).toEqual(mode === 'missing'
        ? [['--no-install', 'playwright', '--version'], ['--no-install', 'playwright-core', '--version']]
        : [['--no-install', 'playwright', '--version'], ['--no-install', 'playwright', 'screenshot']]);
      const pids = server.pids();
      expect(pids).toHaveLength(2);
      await until(() => !pids.some(running));
    });

    it('reports a preview that never answers as a failed command, still submits, and stops it', async () => {
      const port = await freePort(), server = previewServer(), playwright = fakePlaywright(), url = `http://127.0.0.1:${port}`;
      const { dir } = changeCheckout({ checks: [ok], preview: { command: server.command('silent'), url, timeoutSeconds: 1 } });
      const api = braid({ preview: url });
      await cli.main(submitArgs(dir), { env: { ...playwright.env, ...server.env }, fetch: api.fetch, log: vi.fn() });
      expect(api.evidence()[1]).toEqual({ kind: 'command', command: server.command('silent'), exitCode: 124, output: `${url} did not answer within 1 s.`, durationMs: expect.any(Number) });
      expect(playwright.calls()).toEqual([]);
      const pids = server.pids();
      expect(pids).toHaveLength(2);
      await until(() => !pids.some(running));
    });

    it('reports a preview that exits before answering with its output and exit code', async () => {
      const port = await freePort(), url = `http://127.0.0.1:${port}`, crash = node("console.log('Port in use'); process.exit(2)");
      const { dir } = changeCheckout({ preview: { command: crash, url } });
      const api = braid({ preview: url });
      await cli.main(submitArgs(dir), { env: env(), fetch: api.fetch, log: vi.fn() });
      expect(api.evidence()).toEqual([{ kind: 'command', command: crash, exitCode: 2, output: `Port in use\nIt exited with code 2 before ${url} answered.`, durationMs: expect.any(Number) }]);
    });

    it('refuses to screenshot a server that was answering before the preview started', async () => {
      const busy = createServer((request, response) => response.end('Another checkout')).listen(0, '127.0.0.1');
      await once(busy, 'listening');
      try {
        const url = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`, server = previewServer();
        const { dir } = changeCheckout({ checks: [ok], preview: { command: server.command('silent'), url } });
        const api = braid({ preview: url });
        await expect(cli.main(submitArgs(dir), { env: { ...env(), ...server.env }, fetch: api.fetch, log: vi.fn() })).rejects.toThrow(`Something already answers at ${url}.`);
        expect(api.posts).toEqual([]);
        expect(server.pids()).toEqual([]);
      } finally { busy.closeAllConnections(); busy.close(); }
    });

    it('stops the preview and everything it started when the CLI is interrupted, and submits nothing', async () => {
      const port = await freePort(), server = previewServer(), signals = new EventEmitter(), url = `http://127.0.0.1:${port}`;
      const { dir } = changeCheckout({ preview: { command: server.command('silent'), url, timeoutSeconds: 60 } });
      const api = braid({ preview: url });
      const submitting = cli.main(submitArgs(dir), { env: { ...env(), ...server.env }, fetch: api.fetch, log: vi.fn(), signals });
      submitting.catch(() => undefined);
      await until(() => server.pids().length === 2);
      const pids = server.pids();
      signals.emit('SIGINT');
      await expect(submitting).rejects.toThrow('Stopped by SIGINT. The checks and preview were stopped and nothing was submitted.');
      await until(() => !pids.some(running));
      expect(api.posts).toEqual([]);
      expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => signals.listenerCount(signal))).toEqual([0, 0, 0]);
      expect(readdirSync(join(dir, '.braid')).sort()).toEqual(['change.json', 'proof.json']);
    });
  });

  describe('evidence', () => {
    it('checks evidence against the limits Braid accepts', () => {
      const png = Buffer.alloc(33);
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
      png.writeUInt32BE(1280, 16);
      png.writeUInt32BE(800, 20);
      expect(cli.imageInfo(png)).toEqual({ contentType: 'image/png', width: 1280, height: 800 });
      // A JPEG's size is in its start-of-frame segment, after any others.
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x4c, 0x01, 0x86, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
      expect(cli.imageInfo(jpeg)).toEqual({ contentType: 'image/jpeg', width: 390, height: 844 });
      expect(cli.imageInfo(Buffer.from('<html>Not an image</html>'))).toBeNull();
      const screenshot = { kind: 'screenshot', page: '/', viewport: 'desktop', width: 1280, height: 800, contentType: 'image/png', data: png.toString('base64') };
      const command = { kind: 'command', command: 'npm test', exitCode: 1, output: 'x'.repeat(8000), durationMs: 1200 };
      const { durationMs: _, ...untimed } = command;
      const valid = [...Array(12).fill(screenshot), ...Array(10).fill(command)];
      expect(cli.validateEvidence(valid)).toBe(valid);
      expect(cli.validateEvidence([{ ...screenshot, page: 'https://preview.example/settings', contentType: 'image/webp' }, untimed])).toHaveLength(2);
      for (const evidence of [
        [...valid, screenshot], [...valid, command],
        [{ ...command, output: 'x'.repeat(8001) }], [{ ...command, command: 'x'.repeat(301) }], [{ ...command, command: 'npm test\nnpm run build' }], [{ ...command, command: ' ' }],
        [{ ...command, exitCode: 1.5 }], [{ ...command, exitCode: '1' }], [{ ...command, durationMs: -1 }], [{ ...command, at: '2026-10-08T00:00:00.000Z' }],
        [{ ...screenshot, page: 'settings' }], [{ ...screenshot, page: '//preview.example/' }], [{ ...screenshot, viewport: 'tablet' }], [{ ...screenshot, width: 0 }],
        [{ ...screenshot, contentType: 'image/gif' }], [{ ...screenshot, data: Buffer.alloc(1_500_001).toString('base64') }], [{ ...screenshot, data: '' }], [{ ...screenshot, data: 'not base64!' }],
        [{ kind: 'log', output: 'x' }], 'npm test passed',
      ]) expect(() => cli.validateEvidence(evidence)).toThrow(cli.CliError);
      expect(() => cli.validateEvidence([{ ...command, output: `token ${accessToken}` }], [accessToken])).toThrow(/secret/);
    });

    it('resends a change and its proof unchanged with --retry, without running the checks again', async () => {
      const runs = join(root, 'runs.txt'), check = node("require('node:fs').appendFileSync(process.env.RUNS, 'run\\n'); console.log('ok')");
      const { dir } = changeCheckout({ checks: [check] });
      const api = braid({ unavailable: 1 }), options = { env: { ...env(), RUNS: runs }, fetch: api.fetch, log: vi.fn() };
      await expect(cli.main(submitArgs(dir), options)).rejects.toThrow(/unconfirmed/);
      await cli.main(['change', 'submit', '--dir', dir, '--retry'], options);
      expect(api.posts).toHaveLength(2);
      expect(api.posts[1]).toEqual(api.posts[0]);
      expect(JSON.parse(api.posts[1].body).evidence).toEqual([{ kind: 'command', command: check, exitCode: 0, output: 'ok\n', durationMs: expect.any(Number) }]);
      expect(readFileSync(runs, 'utf8')).toBe('run\n');
    });

    it('resends a task result and its proof unchanged after an unconfirmed submission', async () => {
      const { dir } = committedRepository(), runs = join(root, 'runs.txt'), check = node("require('node:fs').appendFileSync(process.env.RUNS, 'run\\n'); console.log('ok')");
      put(dir, 'src/main.ts', 'export const answer = 2;\n');
      git(dir, 'commit', '-qam', 'Result');
      put(dir, '.braid/proof.json', JSON.stringify({ checks: [check] }));
      const settings = { ...env(), RUNS: runs }, log = vi.fn();
      await expect(cli.submit({ ...submission(dir), proof: true }, { env: settings, fetch: lost(), log })).rejects.toThrow(/uncertain/);
      const pending = receipt(dir);
      expect(JSON.parse(pending.body).evidence).toEqual([{ kind: 'command', command: check, exitCode: 0, output: 'ok\n', durationMs: expect.any(Number) }]);
      // New proof never replaces a submission whose outcome is unknown.
      await expect(cli.submit({ ...submission(dir), proof: true }, { env: settings, fetch: vi.fn() })).rejects.toThrow(/--retry to resend it with its saved proof/);
      const recovered = vi.fn().mockResolvedValue(Response.json({ commit }));
      await expect(cli.main(['submit', '--dir', dir, '--retry'], { env: settings, fetch: recovered, log })).resolves.toEqual({ commit });
      expect(recovered.mock.calls[0][1]).toMatchObject({ body: pending.body, headers: { 'Idempotency-Key': pending.key } });
      expect(readFileSync(runs, 'utf8')).toBe('run\n');
      expect(log.mock.calls.flat().join('\n')).toContain(`Next, wait until it merges or needs changes:\n  node ${cliPath} wait --dir ${dir}`);
    });

    it('revises a change with fresh proof, reusing its description when --title and --summary are left out', async () => {
      const { dir } = changeCheckout({ checks: [ok] });
      const api = braid(), log = vi.fn(), options = { env: env(), fetch: api.fetch, log };
      await expect(cli.main(['change', 'submit', '--dir', dir, '--summary', 'Answer 2.', '--proof'], options)).rejects.toThrow(/needs --title and --summary/);
      await cli.main(['change', 'submit', '--dir', dir, '--title', 'Change the answer', '--summary', 'Answer 2.', '--intent', 'Match the spec.', '--proof'], options);
      expect(log.mock.calls.at(-1)![0]).toContain(`Next, wait until it merges or needs changes:\n  node ${cliPath} change wait --dir ${dir}`);
      put(dir, 'src/main.ts', 'export const answer = 3;\n');
      git(dir, 'commit', '-qam', 'Fix what came back');
      await cli.main(['change', 'submit', '--dir', dir, '--proof'], options);
      expect(api.posts.map(post => post.path)).toEqual(['/api/changes', '/api/changes/ch_3abcdefabcdef/revisions']);
      expect(JSON.parse(api.posts[1].body)).toMatchObject({
        title: 'Change the answer', summary: 'Answer 2.', intent: 'Match the spec.', previousRevision: 1,
        files: [{ path: 'src/main.ts', content: 'export const answer = 3;\n' }], evidence: [{ kind: 'command', command: ok, exitCode: 0 }],
      });
    });
  });

  describe('waiting for what comes back', () => {
    const at = '2026-10-08T12:00:00.000Z';
    const sentBack = {
      id: 'ch_3abcdefabcdef', number: 42, title: 'Tighten the save button', status: 'revise', revision: 2, next: 'Fix the failing check and the broken instruction.',
      conflicts: [], overlaps: [], checks: [], events: [],
      guards: [{ kind: 'instructions', path: 'src/App.tsx', detail: 'Adds "—" against "No em dashes in UI copy"' }],
      reviews: [{ id: 'review-1', revision: 2, reviewer: 'reviewer', kind: 'agent', verdict: 'revise', summary: 'Handle the empty list.', createdAt: at, findings: [{ path: 'src/App.tsx', line: 12, severity: 'warning', message: 'An empty list renders nothing.' }] }],
      evidence: [
        { kind: 'command', revision: 1, command: 'npm run lint', exitCode: 1, output: 'An earlier failure', source: 'agent', at },
        { kind: 'command', revision: 2, command: 'npm run build', exitCode: 0, output: 'Built', source: 'agent', at },
        { kind: 'command', revision: 2, command: 'npm test', exitCode: 1, output: `${'noise\n'.repeat(100)}FAIL src/App.test.tsx\nExpected "Save", received "Save — now"\n\x1b[31m1 failed\x1b[0m\n`, source: 'agent', at },
        { kind: 'screenshot', revision: 2, page: '/', viewport: 'desktop', image: 'image-1', width: 1280, height: 800, source: 'agent', at },
      ],
    };
    const api = (change: object) => vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/agent/session') return Response.json({ accessToken: 'braid_at_test.signature' });
      if (url.pathname === '/api/changes' && url.searchParams.get('task') === 'mission-one') return Response.json({ items: [{ id: 'ch_3abcdefabcdef', number: 42 }], nextCursor: null });
      if (url.pathname === '/api/changes/ch_3abcdefabcdef') return Response.json(change);
      return Response.json({ error: 'Not found.' }, { status: 404 });
    });
    const submitted = (dir: string, base: string, revision: number) => writeFileSync(join(dir, '.braid/change.json'), JSON.stringify({ origin, workspaceId: 'workspace-one', base, changeId: 'ch_3abcdefabcdef', number: 42, revision }), { mode: 0o600 });

    it('names the failing command with its output, broken instructions and reviews, then the exact command to resubmit', async () => {
      const { dir, base } = changeCheckout({ checks: ['npm test'] });
      submitted(dir, base, 2);
      const log = vi.fn();
      await expect(cli.main(['change', 'wait', '--dir', dir, '--timeout', '60'], { env: env(), fetch: api(sentBack), log, sleep: vi.fn() })).resolves.toMatchObject({ status: 'revise' });
      const output: string = log.mock.calls.at(-1)![0], lines = output.split('\n');
      expect(output).toContain('Failed: npm test (exit 1)\n');
      expect(output).toContain('  FAIL src/App.test.tsx\n  Expected "Save", received "Save — now"\n  1 failed\n');
      expect(lines.filter(line => line === '  noise')).toHaveLength(37);
      expect(output).toContain('Instruction broken in src/App.tsx: Adds "—" against "No em dashes in UI copy"');
      expect(output).toContain('Review (reviewer): revise — Handle the empty list.\n  src/App.tsx:12 An empty list renders nothing.');
      for (const hidden of ['An earlier failure', 'npm run build', '\x1b']) expect(output).not.toContain(hidden);
      expect(lines.slice(-2)).toEqual(['Fix exactly what is listed above, commit, then resubmit:', `  node ${cliPath} change submit --dir ${dir} --proof`]);
    });

    it('sends conflicts through update first for a task, and stops when a person must decide', async () => {
      const { dir } = repository(), log = vi.fn();
      const conflicted = { ...sentBack, guards: [], reviews: [], evidence: [], conflicts: [{ path: 'src/main.ts', kind: 'content', regions: [{ baseStart: 0, oursStart: 0, theirsStart: 0, base: [], ours: [], theirs: [] }] }] };
      await cli.main(['wait', '--dir', dir, '--timeout', '60'], { env: env(), fetch: api(conflicted), log, sleep: vi.fn() });
      expect(log.mock.calls.at(-1)![0]).toContain('Conflict (content) in src/main.ts at line 1');
      expect(log.mock.calls.at(-1)![0].split('\n').slice(-3)).toEqual([
        'Fetch main, merge it and resolve the conflicts, fix anything else listed, commit, then resubmit:',
        `  node ${cliPath} update --dir ${dir}`, `  node ${cliPath} submit --dir ${dir}`,
      ]);
      await cli.main(['wait', '--dir', dir, '--timeout', '60'], { env: env(), fetch: api({ ...conflicted, conflicts: [], status: 'attention', next: 'A person approves risky changes.' }), log, sleep: vi.fn() });
      expect(log.mock.calls.at(-1)![0].split('\n').at(-1)).toBe(`A person must decide. Ask the owner to open pull request #42 in this repository at ${origin}.`);
    });

    it('tells the agent to keep waiting when the change is still moving at the deadline', async () => {
      const { dir, base } = changeCheckout();
      submitted(dir, base, 1);
      let now = 0;
      const log = vi.fn();
      await cli.main(['change', 'wait', '--dir', dir, '--timeout', '1'], { env: env(), fetch: api({ ...sentBack, guards: [], status: 'queued', revision: 1, next: 'Queued to merge.' }), log, now: () => now, sleep: async (ms: number) => { now += ms; } });
      expect(log.mock.calls.at(-1)![0].split('\n').slice(-2)).toEqual(['Next, wait until it merges or needs changes:', `  node ${cliPath} change wait --dir ${dir}`]);
    });
  });
});

it('reuses a saved account connection for each selected repository', () => {
  const environment = { BRAID_CONFIG_HOME: join(root, 'config') };
  cli.saveCredentials(origin, { accessToken, workspaceId: '*', expiresAt: new Date(Date.now() + 60_000).toISOString() }, environment);
  expect(cli.loadCredentials(origin, environment, { workspaceId: 'workspace-one' })).toEqual({ accessToken, workspaceId: 'workspace-one' });
  expect(cli.loadCredentials(origin, environment, { workspaceId: 'workspace-two' })).toEqual({ accessToken, workspaceId: 'workspace-two' });
});
