import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileBlame } from '../../shared/types';
import * as v from 'valibot';
import { repositoryStats } from '../src/schemas';
import { saveCredentials } from '../src/config';
import { cleanup, repository } from './helpers';

const project = join(import.meta.dirname, '..', '..');
const bundle = join(project, 'cli', 'dist', 'braid.mjs');

describe('the published command', () => {
  beforeAll(() => { execFileSync('npm', ['run', 'build:cli'], { cwd: project, stdio: 'pipe' }); }, 60_000);
  afterAll(cleanup);

  it('serves the full CLI byte-for-byte without replacing the task CLI', () => {
    const served = join(project, 'public/cli/braid-git.mjs');
    expect(readFileSync(served)).toEqual(readFileSync(bundle));
    const help = execFileSync(process.execPath, [served, '--help'], { encoding: 'utf8' });
    for (const command of ['blame', 'log', 'agent', 'stats']) expect(help).toContain(command);
    expect(readFileSync(join(project, 'public/cli/braid.mjs'), 'utf8')).toContain('change start');
  });

  it('is one executable file that runs on Node alone', () => {
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(() => accessSync(bundle, constants.X_OK)).not.toThrow();
    expect(readFileSync(bundle, 'utf8')).not.toMatch(/from ["'](?!node:)[^"']+["']/);
    expect(execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' })).toBe(`${JSON.parse(readFileSync(join(project, 'cli', 'package.json'), 'utf8')).version}\n`);
  });

  it('blames a file as JSON in any Git repository', () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'one\n' }, 'First', { author: { name: 'Alice', email: 'alice@example.com' } });
    repo.commit({ 'a.txt': 'one\ntwo\n' }, 'Second\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>');
    const blame = JSON.parse(execFileSync(process.execPath, [bundle, 'blame', 'a.txt', '--json'], { cwd: repo.root, env: repo.env, encoding: 'utf8' })) as FileBlame;
    expect(blame).toMatchObject({ path: 'a.txt', ref: 'HEAD', lines: 2 });
    expect(blame.ranges.map(range => [range.start, range.provenance.kind, range.provenance.agent?.name ?? range.provenance.owner?.name])).toEqual([[1, 'human', 'Alice'], [2, 'agent', 'Claude Opus 5.5']]);
  });

  it('counts HEAD with stats in an unconnected clone using the typed JSON shape', () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'one\n' }, 'First');
    repo.commit({ 'a.txt': 'one\ntwo\n', 'package-lock.json': '{}\n' }, 'Claude\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>');
    const output = execFileSync(process.execPath, [bundle, 'stats', '--json'], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
    const stats = v.parse(repositoryStats, JSON.parse(output));
    expect(stats).toMatchObject({ files: 1, lines: 2, skipped: { binary: 0, generated: 1, large: 0 } });
    expect(stats.rows.map(row => [row.name, row.lines, row.share])).toEqual([['Claude Opus 5 for @theg1239', 1, 0.5], ['people', 1, 0.5]]);
  });

  it('records the run of an agent that commits under braid agent run, and leaves its message as written', () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'one\n' }, 'First');
    execFileSync(process.execPath, [bundle, 'init', '--url', 'https://braid.example', '--workspace', 'ws_1'], { cwd: repo.root, env: repo.env });
    expect(existsSync(join(repo.root, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
    repo.git(['add', '.braid/config.json']);
    // braid is not on PATH here, so agent run puts a launcher for this bundle there for the hook.
    execFileSync(process.execPath, [bundle, 'agent', 'run', '--model', 'gpt-6.1-sol', '--tool', 'codex/1.8.0', '--', 'git', 'commit', '-q', '-m', 'Link Braid'], { cwd: repo.root, env: repo.env, stdio: 'pipe' });
    expect(repo.git(['log', '-1', '--format=%B'])).toBe('Link Braid');
    const note = JSON.parse(repo.git(['notes', '--ref=refs/notes/braid', 'show', 'HEAD']));
    expect(note).toEqual({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: expect.stringMatching(/^s_[0-9a-z]{26}$/) } });
    const log = execFileSync(process.execPath, [bundle, 'log', '--json', '-n', '1'], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
    expect(JSON.parse(log)[0]).toMatchObject({ kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', session: note.agent.session }, owner: { github: 'theg1239' }, confidence: 'trailers' });
  });

  it('signs Git in to the braid remote through the credential helper init configures', () => {
    const repo = repository(), token = `braid_agent_${'e'.repeat(64)}`;
    repo.commit({ 'a.txt': 'one\n' }, 'First');
    saveCredentials(repo.env, { origin: 'https://braid.example', accessToken: token, workspaceId: 'ws_1', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    execFileSync(process.execPath, [bundle, 'init', '--url', 'https://braid.example', '--workspace', 'ws_1'], { cwd: repo.root, env: repo.env });
    const bin = join(repo.home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'braid'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)} "$@"\n`, { mode: 0o755 });
    const filled = execFileSync('git', ['credential', 'fill'], { cwd: repo.root, env: { ...repo.env, PATH: `${bin}:${repo.env.PATH}` }, input: 'protocol=https\nhost=braid.example\npath=git/ws_1.git\n\n', encoding: 'utf8' });
    expect(filled).toBe(`protocol=https\nhost=braid.example\npath=git/ws_1.git\nusername=x\npassword=${token}\n`);
  });
});
