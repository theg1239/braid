import { run } from '@stricli/core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from '../src/app';
import type { BraidContext } from '../src/context';

/** A scratch directory removed by `cleanup`. */
const scratch: string[] = [];
export function temporary(prefix = 'braid-test-') {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(folder);
  return folder;
}
export const cleanup = () => { for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true }); };

/** An environment that ignores this machine's Git, GitHub CLI and Braid configuration. */
export function environment(home: string, { PATH = githubCli(home, null), ...extra }: Record<string, string> = {}): Record<string, string> {
  return {
    PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    BRAID_CONFIG_HOME: join(home, 'config'), LANG: 'C', TZ: 'UTC', ...extra,
  };
}

/** A GitHub CLI first on PATH that prints `token` for `gh auth token`, or answers as a signed-out gh does when it is null. */
export function githubCli(home: string, token: string | null) {
  const bin = join(home, token ? 'fake-gh' : 'fake-gh-signed-out');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), token ? `#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 1\nprintf '%s\\n' ${JSON.stringify(token)}\n` : '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ''}`;
}

interface Person { name: string; email: string }
/** A Git repository with a helper to commit as anyone, at any date. */
export function repository(person: Person = { name: 'Ishaan', email: '12345+theg1239@users.noreply.github.com' }) {
  const home = temporary(), root = join(home, 'repo'), env = environment(home);
  const git = (args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
  git(['config', 'user.name', person.name]);
  git(['config', 'user.email', person.email]);
  let clock = Date.parse('2026-09-01T12:00:00Z');
  /** Writes files and commits them; `author` and `at` default to the configured person and a clock that moves an hour per commit. */
  const commit = (files: Record<string, string>, message: string, { author = person, at, extra = {} }: { author?: Person; at?: string; extra?: Record<string, string> } = {}) => {
    for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    git(['add', '--all', '--', ...Object.keys(files)]);
    const date = at ?? new Date(clock += 3_600_000).toISOString();
    git(['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...extra });
    return git(['rev-parse', 'HEAD']);
  };
  return { home, root, env, git, commit };
}

/** A recorded HTTP request. */
export interface Sent { method: string; path: string; headers: Record<string, string>; body: unknown }
type Route = (request: Sent) => Response | Promise<Response>;
/** A fetch that answers from `routes`, keyed `METHOD /path` (query included), and records every request. */
export function server(routes: Record<string, Route | Route[]>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Sent = { method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    sent.push(request);
    const route = routes[`${request.method} ${request.path}`] ?? routes[`${request.method} ${url.pathname}`];
    const handler = Array.isArray(route) ? route.length > 1 ? route.shift() : route[0] : route;
    return handler ? handler(request) : Response.json({ error: `No route for ${request.method} ${request.path}` }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });

/** An access token as Braid signs them; only its payload is read. */
const accessToken = (user = { id: 'github:1', name: 'Ishaan', email: 'ishaan@example.com' }) =>
  `braid_at_${Buffer.from(JSON.stringify({ v: 1, user, scope: 'work', exp: Date.now() + 300_000 })).toString('base64url')}.signature`;
export const session = (workspaceId = 'ws_1', agent = { id: 'agent-1', name: 'Braid CLI' }) =>
  () => json({ accessToken: accessToken(), tokenType: 'Bearer', expiresAt: new Date(Date.now() + 300_000).toISOString(), agent, workspaceId });

interface Options { cwd: string; env: Record<string, string>; fetch?: typeof globalThis.fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; self?: string[]; input?: string }

/** A context like main.ts builds, with output captured and no network unless `fetch` is given. */
export function testContext(options: Options) {
  const output = { stdout: '', stderr: '' };
  const context: BraidContext = {
    process: { stdout: { write: (text: string) => { output.stdout += text; } }, stderr: { write: (text: string) => { output.stderr += text; } }, env: options.env, exitCode: undefined },
    env: options.env, cwd: options.cwd,
    fetch: options.fetch ?? ((async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch),
    now: options.now ?? Date.now, sleep: options.sleep ?? (async () => {}),
    signals: { on: () => process, off: () => process } as unknown as BraidContext['signals'],
    parentPid: 0, self: options.self ?? ['braid'], script: '', input: async () => options.input ?? '',
  };
  return { context, output };
}

/** Runs braid in-process and returns what it printed and its exit code. */
export async function braid(args: string[], options: Options) {
  const { context, output } = testContext(options);
  await run(app, args, context);
  return { ...output, exitCode: Number(context.process.exitCode ?? 0) };
}

/**
 * A stand-in for Git on PATH: clones, fetches and pushes to the HTTPS remotes in `remotes` are served from the local
 * repositories they map to, recording each call and the password Git's askpass helper gave; every other Git command
 * runs the real Git. A push that succeeds says `say` back, as Braid would.
 */
export function fakeGit(home: string, remotes: Record<string, string>, say = '') {
  const bin = join(home, 'fake-git'), log = join(home, 'fake-git.log'), handler = join(bin, 'remote.cjs');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in https://*) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(handler)} "$@";; esac; done\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  writeFileSync(handler, `const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const remotes = ${JSON.stringify(remotes)}, args = process.argv.slice(2);
const at = args.findIndex(arg => Object.hasOwn(remotes, arg));
if (!['clone', 'fetch', 'push', 'ls-remote'].some(command => args.includes(command))) process.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' }).status ?? 1);
const password = process.env.GIT_ASKPASS ? spawnSync(process.env.GIT_ASKPASS, ["Password for 'https://example':"], { encoding: 'utf8' }).stdout.trim() : '';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, password }) + '\\n');
if (at < 0) process.exit(128);
args[at] = remotes[args[at]];
const result = spawnSync(${JSON.stringify(real)}, ['-c', 'protocol.file.allow=always', ...args], { stdio: 'inherit' });
if (result.status === 0 && args.includes('push') && ${JSON.stringify(say)}) process.stderr.write('remote: ' + ${JSON.stringify(say)} + '\\n');
process.exit(result.status ?? 1);
`);
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; password: string }) : [],
  };
}
