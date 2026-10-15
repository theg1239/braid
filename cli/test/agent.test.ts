import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromCommand, fromEnvironment, newSession, resolveRun } from '../src/identity';
import { braid, cleanup, environment, repository, temporary } from './helpers';

afterEach(cleanup);

describe('tool detection', () => {
  it('reads the tool and model from a command line', () => {
    expect(fromCommand(['claude', '--model', 'claude-opus-5-5[1m]', '-p', 'hi'])).toEqual({ tool: 'claude-code', model: 'claude-opus-5-5' });
    expect(fromCommand(['/usr/local/bin/node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'exec', '-m', 'gpt-6.1-sol'])).toEqual({ tool: 'codex', model: 'gpt-6.1-sol' });
    expect(fromCommand(['cursor-agent', '--model=sonnet-5'])).toEqual({ tool: 'cursor', model: 'sonnet-5' });
    expect(fromCommand(['gemini'])).toEqual({ tool: 'gemini' });
    expect(fromCommand(['opencode', 'run'])).toEqual({ tool: 'opencode' });
    expect(fromCommand(['node', 'build.js', '--model', 'x'])).toEqual({});
  });

  it('reads what coding tools leave in the environment', () => {
    expect(fromEnvironment({ AI_AGENT: 'claude-code_2-1-291_agent' })).toEqual({ tool: 'claude-code/2.1.291' });
    expect(fromEnvironment({ CLAUDECODE: '1', CLAUDE_CODE_EXECPATH: '/Users/me/.local/share/claude/versions/2.1.291', CLAUDE_CODE_SESSION_ID: 'd6645806-bcab-4d45-916e-7addc0ce6aba' })).toEqual({ tool: 'claude-code/2.1.291', session: 'd6645806-bcab-4d45-916e-7addc0ce6aba' });
    expect(fromEnvironment({})).toEqual({});
  });

  it('trusts the nearest tool over what an enclosing tool left in the environment', () => {
    const claude = { CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-291_agent', CLAUDE_CODE_SESSION_ID: 'd6645806-bcab-4d45-916e-7addc0ce6aba' };
    expect(resolveRun({}, claude, { tool: 'claude-code', model: 'claude-opus-5-5' })).toEqual({ tool: 'claude-code/2.1.291', model: 'claude-opus-5-5', session: 'd6645806-bcab-4d45-916e-7addc0ce6aba' });
    expect(resolveRun({}, claude, { tool: 'codex', model: 'gpt-6.1-sol' })).toEqual({ tool: 'codex', model: 'gpt-6.1-sol' });
    expect(resolveRun({ model: 'gpt-6' }, { ...claude, BRAID_TOOL: 'my tool', BRAID_SESSION: 's_1', BRAID_PARENT_SESSION: 'not valid!' }, {})).toEqual({ tool: 'claude-code/2.1.291', model: 'gpt-6', session: 's_1' });
  });

  it('makes session ids that sort by when they began', () => {
    const early = newSession(Date.parse('2026-10-08T12:00:00Z')), late = newSession(Date.parse('2026-10-08T12:00:01Z'));
    expect(early).toMatch(/^s_[0-9a-z]{26}$/);
    expect(early < late).toBe(true);
    expect(newSession(0)).not.toBe(newSession(0));
  });
});

describe('braid agent run', () => {
  it('runs the command with the run in its environment and exits as it does', async () => {
    const home = temporary(), out = join(home, 'env.json');
    const env = environment(home, { BRAID_SESSION: 's_orchestrator', BRAID_AGENT: 'atlas' });
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); process.exit(3)`;
    const result = await braid(['agent', 'run', '--model', 'claude-opus-5-5', '--tool', 'claude-code/2.1.291', '--', process.execPath, '-e', script], { cwd: home, env, now: () => Date.parse('2026-10-08T12:00:00Z') });
    expect(result.exitCode).toBe(3);
    const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
    expect(seen).toMatchObject({ BRAID_MODEL: 'claude-opus-5-5', BRAID_TOOL: 'claude-code/2.1.291', BRAID_PARENT_SESSION: 's_orchestrator' });
    expect(seen.BRAID_SESSION).toMatch(/^s_[0-9a-z]{26}$/);
    expect(seen.BRAID_SESSION).not.toBe('s_orchestrator');
    expect(seen.BRAID_AGENT).toBeUndefined();
  });

  it('detects the tool and model from the command itself', async () => {
    const home = temporary(), out = join(home, 'env.json');
    const result = await braid(['agent', 'run', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`, 'claude', '--model', 'ignored'], { cwd: home, env: environment(home) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).not.toHaveProperty('BRAID_TOOL');
    expect((await braid(['agent', 'run', '--', 'definitely-not-a-command-braid'], { cwd: home, env: environment(home) })).stderr).toContain('definitely-not-a-command-braid was not found on PATH.');
  });

  it('says why activity is off when the repository link is damaged', async () => {
    const repo = repository();
    mkdirSync(join(repo.root, '.braid'));
    writeFileSync(join(repo.root, '.braid', 'config.json'), '{ "url": ');
    const result = await braid(['agent', 'run', '--', process.execPath, '-e', ''], { cwd: repo.root, env: repo.env });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('activity disconnected · .braid/config.json is not valid');
  });

  it('lists the agents in recent commits by model and owner', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': '1\n' }, 'By hand');
    repo.commit({ 'a.txt': '2\n' }, 'One\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>');
    const noted = repo.commit({ 'a.txt': '3\n' }, 'Two\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>');
    repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.1.291', session: 's_1' } }), noted]);
    const result = await braid(['agent', 'list', '--json'], { cwd: repo.root, env: repo.env });
    expect(JSON.parse(result.stdout)).toEqual({ local: [{ name: 'Claude Opus 5.5', owner: '@theg1239', models: ['claude-opus-5-5'], tools: ['claude-code/2.1.291'], sessions: 1, commits: 2, last: expect.any(String) }], braid: null });
    expect(existsSync(join(repo.root, '.braid'))).toBe(false);
  });
});
