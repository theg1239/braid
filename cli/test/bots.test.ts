import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { provenance, provenanceList, repositoryStats } from '../src/schemas';
import { braid, cleanup, repository } from './helpers';

afterEach(cleanup);
const makeHistory = () => {
  const repo = repository();
  repo.commit({ 'app.ts': 'human\n' }, 'Start');
  repo.commit({ 'app.ts': 'human\nagent\n' }, 'Fix\n\nCo-authored-by: Codex <codex@openai.com>');
  repo.commit({ 'deps.txt': 'one\ntwo\n' }, 'Bump dependencies\n\nCo-authored-by: Example Owner <101+example-owner@users.noreply.github.com>',
    { author: { name: 'dependabot[bot]', email: '101+dependabot[bot]@users.noreply.github.com' } });
  return repo;
};

describe('bot attribution in the CLI', () => {
  it.each([undefined, 'model', 'owner', 'tool'])('keeps bots out of agent totals when grouped by %s', async by => {
    const repo = makeHistory();
    const result = await braid(['stats', '--json', ...(by ? ['--by', by] : [])], { cwd: repo.root, env: repo.env });
    expect(result.exitCode).toBe(0);
    const parsed = v.parse(repositoryStats, JSON.parse(result.stdout));
    expect(parsed.lines).toBe(4);
    expect(parsed.rows.filter(row => row.kind === 'agent').reduce((sum, row) => sum + row.lines, 0)).toBe(1);
    expect(parsed.rows.filter(row => row.kind === 'bot')).toEqual([{ kind: 'bot', name: 'Dependabot', tool: 'dependabot[bot]', lines: 2, share: 0.5 }]);
    expect(parsed.rows.reduce((sum, row) => sum + row.share, 0)).toBe(1);
  });

  it('prints a bot row by name with no owner and a neutral attribution heading', async () => {
    const repo = makeHistory();
    const result = await braid(['stats'], { cwd: repo.root, env: repo.env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Author\s+Lines\s+%/);
    expect(result.stdout).toMatch(/Dependabot\s+2\s+50\.0%/);
    expect(result.stdout).not.toContain('Dependabot for');
    const blame = await braid(['blame', 'deps.txt'], { cwd: repo.root, env: repo.env });
    expect(blame.exitCode).toBe(0);
    expect(blame.stdout).toContain('Dependabot');
    expect(blame.stdout).not.toContain('@example-owner');
    const agents = await braid(['agent', 'list', '--json'], { cwd: repo.root, env: repo.env });
    expect(agents.exitCode).toBe(0);
    expect(JSON.parse(agents.stdout).local.map((row: { name: string }) => row.name)).toEqual(['Codex']);
  });

  it.each(['human', 'agent', 'bot'])('round-trips %s provenance and stats through the closed schemas', kind => {
    const row = { commit: 'a'.repeat(40), at: '2026-10-13T00:00:00Z', subject: 'Bump dependencies', kind,
      ...(kind !== 'human' ? { agent: { name: 'Dependabot', tool: 'dependabot[bot]' } } : {}), confidence: 'inferred' };
    expect(v.parse(provenance, JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(v.parse(provenanceList, JSON.parse(JSON.stringify([row])))).toEqual([row]);
    const stats = { repository: 'repo', head: row.commit, files: 1, lines: 1, rows: [{ kind, name: 'Dependabot', lines: 1, share: 1 }], skipped: { binary: 0, generated: 0, large: 0 } };
    expect(v.parse(repositoryStats, JSON.parse(JSON.stringify(stats)))).toEqual(stats);
    expect(v.safeParse(provenance, { ...row, kind: 'unknown' }).success).toBe(false);
  });
});
