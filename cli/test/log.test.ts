import { afterEach, describe, expect, it } from 'vitest';
import type { Provenance } from '../../shared/types';
import { braid, cleanup, repository } from './helpers';

afterEach(cleanup);

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const copilot = { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' };

/** Five commits a day apart: Alice's own, Bob's Claude, Alice's GPT with a Braid note, a Copilot bot's, and Ishaan's Claude. */
function history() {
  const repo = repository();
  const day = (n: number) => `2026-09-0${n}T12:00:00Z`;
  repo.commit({ 'a.txt': '1\n' }, 'Alice by hand', { author: alice, at: day(1) });
  repo.commit({ 'a.txt': '2\n' }, 'Bob with Claude\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>', { author: bob, at: day(2) });
  const gpt = repo.commit({ 'a.txt': '3\n' }, 'Alice with GPT\n\nCo-authored-by: GPT-6.1 Sol <gpt-6.1-sol@agents.braid.local>', { author: alice, at: day(3) });
  repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', session: 's_9' } }), gpt]);
  repo.commit({ 'a.txt': '4\n' }, 'Copilot fix', { author: copilot, at: day(4) });
  repo.commit({ 'a.txt': '5\n' }, 'Ishaan with Claude\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>', { at: day(5) });
  return repo;
}

const subjects = async (repo: ReturnType<typeof repository>, ...args: string[]) => {
  const result = await braid(['log', '--json', ...args], { cwd: repo.root, env: repo.env });
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.stdout) as Provenance[]).map(provenance => provenance.subject);
};

describe('braid log', () => {
  it('lists recent commits with who made them, newest first', async () => {
    const repo = history();
    const result = await braid(['log', '-n', '3'], { cwd: repo.root, env: repo.env, now: () => Date.parse('2026-09-06T12:00:00Z') });
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^[0-9a-f]{8}\s+1d\s+Claude Opus 5\.5\s+@theg1239\s+Ishaan with Claude$/),
      expect.stringMatching(/^[0-9a-f]{8}\s+2d\s+Copilot\s+Copilot fix$/),
      expect.stringMatching(/^[0-9a-f]{8}\s+3d\s+GPT-6\.1 Sol\s+Alice\s+Alice with GPT$/),
    ]);
  });

  it('filters by agent, model, owner and date, and stops at the limit', async () => {
    const repo = history();
    expect(await subjects(repo, '--agent', 'claude')).toEqual(['Ishaan with Claude', 'Bob with Claude']);
    expect(await subjects(repo, '--agent', 'claude-opus-5-5')).toEqual(['Ishaan with Claude']);
    expect(await subjects(repo, '--model', 'gpt-6.1-sol')).toEqual(['Alice with GPT']);
    expect(await subjects(repo, '--model', 'Claude Opus 4.7')).toEqual(['Bob with Claude']);
    expect(await subjects(repo, '--model', 'opus')).toEqual(['Ishaan with Claude', 'Bob with Claude']);
    expect(await subjects(repo, '--owner', 'alice')).toEqual(['Alice with GPT', 'Alice by hand']);
    expect(await subjects(repo, '--owner', '@theg1239')).toEqual(['Ishaan with Claude']);
    expect(await subjects(repo, '--since', '2026-09-03T00:00:00Z')).toEqual(['Ishaan with Claude', 'Copilot fix', 'Alice with GPT']);
    expect(await subjects(repo, '--agent', 'claude', '-n', '1')).toEqual(['Ishaan with Claude']);
    expect(await subjects(repo, '--agent', 'devin')).toEqual([]);
  });

  it('clips a long subject so each row fits the terminal', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': '1\n' }, 'x'.repeat(300));
    const [row] = (await braid(['log'], { cwd: repo.root, env: repo.env })).stdout.trimEnd().split('\n');
    expect([...row]).toHaveLength(120);
    expect(row.endsWith('x…')).toBe(true);
  });

  it('carries the note on the commit into the provenance', async () => {
    const repo = history();
    const result = await braid(['log', '--json', '--model', 'gpt'], { cwd: repo.root, env: repo.env });
    expect((JSON.parse(result.stdout) as Provenance[])[0]).toMatchObject({ kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', session: 's_9' }, owner: { name: 'Alice' }, confidence: 'trailers' });
  });
});
