import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CommitFacts } from '../../shared/provenance';
import { fail, type BraidContext } from './context';
import { redact } from './secrets';
import { plain } from './terminal';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
export const ZERO = /^0+$/;
export const REGULAR = new Set(['100644', '100755']);

interface Run { cwd?: string; input?: string | Buffer; env?: Record<string, string | undefined>; secret?: boolean; secrets?: readonly string[] }
export const gitEnv = (env: Record<string, string | undefined>) => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

export function gitTry(context: BraidContext, args: readonly string[], { cwd = context.cwd, input, env = context.env, secret = false, secrets = [] }: Run = {}) {
  const result = spawnSync('git', args, { cwd, input, maxBuffer: 512 * 1024 * 1024, timeout: 300_000, env: gitEnv(env) });
  if (result.error) fail((result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed or not on PATH.' : 'Git could not run.');
  return { status: result.status ?? 1, stdout: result.stdout, stderr: secret ? '' : redact(plain(result.stderr.toString('utf8')), secrets).trim(), withheld: secret };
}

export function gitFailed(command: string, said: string, status: number): never {
  return fail(`git ${command} failed: ${said.trim().split('\n')[0].replace(/^(?:fatal|error): /, '') || `exit ${status}`}`);
}
function succeeded(args: readonly string[], result: ReturnType<typeof gitTry>) {
  if (result.status === 0) return result.stdout;
  return result.withheld ? fail('Git could not complete the operation. Its output is withheld because it involved a Braid token.') : gitFailed(args[0], result.stderr, result.status);
}

export const git = (context: BraidContext, args: readonly string[], options?: Run) => succeeded(args, gitTry(context, args, options));
export const gitText = (context: BraidContext, args: readonly string[], options?: Run) => git(context, args, options).toString('utf8').trim();

export async function gitAsync(context: BraidContext, args: readonly string[], cwd: string): Promise<Buffer> {
  const child = spawn('git', args, { cwd, env: gitEnv(context.env), timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const status = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)); });
  return status === 0 ? Buffer.concat(output) : gitFailed(args[0], redact(plain(Buffer.concat(errors).toString('utf8'))), status);
}

export function findRoot(context: BraidContext) {
  const result = gitTry(context, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? realpathSync(result.stdout.toString('utf8').trim()) : undefined;
}
export const repositoryRoot = (context: BraidContext) => findRoot(context) ?? fail('Run braid inside a Git repository.');

export function gitPath(context: BraidContext, root: string, name: string) {
  const path = gitText(context, ['rev-parse', '--git-path', name], { cwd: root });
  return isAbsolute(path) ? path : resolve(root, path);
}

export function currentBranch(context: BraidContext, root: string) {
  const result = gitTry(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
  return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
}

export function resolveCommit(context: BraidContext, root: string, revision: string) {
  const result = gitTry(context, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], { cwd: root });
  return result.status === 0 ? result.stdout.toString('utf8').trim() : fail(`${revision} is not a commit in this repository.`);
}

export const isAncestor = (context: BraidContext, root: string, ancestor: string, commit = 'HEAD') =>
  gitTry(context, ['merge-base', '--is-ancestor', ancestor, commit], { cwd: root }).status === 0;
export const hasCommit = (context: BraidContext, root: string, commit: string) =>
  gitTry(context, ['cat-file', '-e', `${commit}^{commit}`], { cwd: root }).status === 0;

const LOG_FORMAT = ['-z', '--format=%H%n%aN%n%aE%n%aI%n%B'];

function parseCommit(record: string): CommitFacts & { time: number } {
  const [id, name, email, at] = record.split('\n', 4);
  const message = record.split('\n').slice(4).join('\n').replace(/\n+$/, '');
  return { id, at, author: { name, email }, message, time: Date.parse(at) };
}

export function readCommits(context: BraidContext, root: string, ids: readonly string[], since?: string) {
  const wanted = ids.filter(id => !ZERO.test(id));
  if (!wanted.length) return new Map<string, CommitFacts & { time: number }>();
  const threshold = since ? /^--max-age=(-?\d+)$/.exec(gitText(context, ['rev-parse', `--since=${since}`], { cwd: root }))?.[1] ?? fail('Git did not understand the --since date.') : undefined;
  const output = git(context, ['log', '--no-walk=unsorted', '--stdin', ...LOG_FORMAT, ...(threshold ? [`--since=@${Number(threshold) + 1}`] : [])], { cwd: root, input: `${wanted.join('\n')}\n` }).toString('utf8');
  return new Map(output.split('\0').filter(Boolean).map(record => { const facts = parseCommit(record); return [facts.id, facts]; }));
}

export function noteIndex(context: BraidContext, root: string, ref: string) {
  const result = gitTry(context, ['notes', `--ref=${ref}`, 'list'], { cwd: root });
  const index = new Map<string, string>();
  if (result.status !== 0) return index;
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const [note, commit] = line.split(' ');
    if (note && commit) index.set(commit, note);
  }
  return index;
}

export function readNotes(context: BraidContext, root: string, ref: string, ids: Iterable<string>, index = noteIndex(context, root, ref)) {
  const wanted = [...new Set(ids)].flatMap(commit => { const note = index.get(commit); return note ? [[commit, note] as const] : []; });
  const notes = new Map<string, string>();
  if (!wanted.length) return notes;
  const output = git(context, ['cat-file', '--batch'], { cwd: root, input: `${wanted.map(([, note]) => note).join('\n')}\n` });
  let offset = 0;
  for (const [commit] of wanted) {
    const end = output.indexOf(0x0a, offset);
    const header = /^([0-9a-f]+) blob (\d+)$/.exec(output.subarray(offset, end).toString('utf8'));
    if (!header) break;
    const size = Number(header[2]);
    notes.set(commit, output.subarray(end + 1, end + 1 + size).toString('utf8'));
    offset = end + 1 + size + 1;
  }
  return notes;
}

export async function* streamCommits(context: BraidContext, root: string, args: readonly string[]): AsyncGenerator<CommitFacts & { time: number }> {
  const child = spawn('git', ['log', ...LOG_FORMAT, ...args], { cwd: root, env: gitEnv(context.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const closed = new Promise<number>(done => child.once('close', code => done(code ?? 1)));
  let pending = Buffer.alloc(0), finished = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = Buffer.concat([pending, chunk]);
      for (let end = pending.indexOf(0); end >= 0; end = pending.indexOf(0)) {
        const record = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        if (record) yield parseCommit(record);
      }
    }
    if (pending.length) yield parseCommit(pending.toString('utf8'));
    finished = true;
  } finally {
    if (!finished) child.kill();
  }
  const status = await closed;
  if (status !== 0) gitFailed('log', redact(plain(errors)), status);
}

function parseBlame(output: string) {
  const lines: { commit: string; text: string }[] = [];
  let current: { commit: string; line: number } | undefined;
  for (const row of output.split('\n')) {
    if (!current) {
      const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(row);
      if (header) current = { commit: header[1], line: Number(header[2]) };
    } else if (row.startsWith('\t')) {
      lines[current.line - 1] = { commit: current.commit, text: row.slice(1).replace(/\r$/, '') };
      current = undefined;
    }
  }
  return lines;
}

export function blame(context: BraidContext, root: string, path: string, commit?: string) {
  return parseBlame(git(context, ['blame', '--porcelain', ...(commit ? [commit] : []), '--', path], { cwd: root }).toString('utf8'));
}

const HARDENED = ['-c', `core.hooksPath=${NULL_DEVICE}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
const ASKPASS = '#!/usr/bin/env node\nconst prompt = process.argv[2] || "";\nif (prompt.startsWith("Username")) process.stdout.write("x\\n");\nelse if (prompt.startsWith("Password")) process.stdout.write(process.env.BRAID_GIT_TOKEN + "\\n");\nelse process.exitCode = 1;\n';

/** Git that runs none of the repository's hooks or configuration. A token reaches it only through a temporary askpass helper, never in arguments or a credential store. */
export function strictGit(context: BraidContext, args: readonly string[], { cwd = context.cwd, token, quiet = !!token }: { cwd?: string; token?: string; quiet?: boolean } = {}) {
  const env: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(context.env).filter(([key]) => !/^(?:GIT_|BRAID_)/i.test(key))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' };
  const run = (extra: Record<string, string> = {}) => gitTry(context, [...HARDENED, ...args], { cwd, env: { ...env, ...extra }, secret: quiet, secrets: token ? [token] : [] });
  if (!token) return run();
  const folder = mkdtempSync(join(tmpdir(), 'braid-askpass-'));
  try {
    chmodSync(folder, 0o700);
    const helper = join(folder, 'askpass.cjs');
    writeFileSync(helper, ASKPASS, { mode: 0o700, flag: 'wx' });
    return run({ GIT_ASKPASS: helper, BRAID_GIT_TOKEN: token });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

export const strict = (context: BraidContext, args: readonly string[], options?: Parameters<typeof strictGit>[2]) => succeeded(args, strictGit(context, args, options));

export function httpsRemote(value: string) {
  if (!URL.canParse(value) || /[\x00-\x20\x7f\\]/.test(value)) fail('Braid returned a Git remote that is not plain HTTPS.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Braid returned a Git remote that is not plain HTTPS.');
  return url.href;
}

export function fetchCommit(context: BraidContext, root: string, remote: string, commit: string, token: string) {
  if (hasCommit(context, root, commit)) return;
  strict(context, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--', httpsRemote(remote), commit], { cwd: root, token });
  if (!hasCommit(context, root, commit)) fail(`Braid's trunk commit ${commit} could not be fetched.`);
}
