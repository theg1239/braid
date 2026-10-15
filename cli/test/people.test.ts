import { afterEach, describe, expect, it } from 'vitest';
import { personLabel, personLogins } from '../src/present';
import type { RepositoryStats } from '../src/schemas';
import { braid, cleanup, repository } from './helpers';

afterEach(cleanup);

const local = { name: 'alex-dev', email: 'local@example.test' };
const mapped = { name: 'Alex Rivera', email: '42+alex-dev@users.noreply.github.com' };
const copilot = '\n\nCo-authored-by: Copilot <copilot@github.com>';

async function command(repo: ReturnType<typeof repository>, args: string[]) {
  const result = await braid(args, { cwd: repo.root, env: repo.env });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return result.stdout;
}

async function ownerRows(repo: ReturnType<typeof repository>, ...args: string[]) {
  const result = JSON.parse(await command(repo, ['stats', '--by', 'owner', '--json', ...args])) as RepositoryStats;
  return result.rows.map(row => [row.name, row.lines]);
}

describe('people throughout a clone’s history', () => {
  it.each(['author', 'co-author'] as const)('uses a mapped %s login for the person and their agent owners', async source => {
    const repo = repository(local);
    repo.commit({ 'file.ts': 'human\n' }, 'By hand');
    repo.commit({ 'file.ts': 'human\nassisted\n' }, `Assisted${copilot}`);
    if (source === 'author') {
      repo.commit({ 'file.ts': 'human\nassisted\nmapped\n' }, 'Mapped', { author: mapped });
    } else {
      repo.commit({ 'file.ts': 'human\nassisted\nmapped\n' }, 'Mapped\n\nCo-authored-by: Alex Rivera <alex-dev@users.noreply.github.com>', {
        author: { name: 'cursoragent', email: 'cursoragent@cursor.com' },
      });
    }

    const blame = await command(repo, ['blame', 'file.ts']);
    expect(blame).toMatch(/^1\s+@alex-dev\s+\S+\s+human$/m);
    expect(blame).toMatch(/^2\s+Copilot\s+@alex-dev\s+\S+\s+assisted$/m);
    expect(blame).toMatch(source === 'author' ? /^3\s+@alex-dev\s+\S+\s+mapped$/m : /^3\s+Cursor\s+@alex-dev\s+\S+\s+mapped$/m);
    const log = await command(repo, ['log']);
    expect(log).toMatch(/\s@alex-dev\s+By hand$/m);
    expect(log).toMatch(/\sCopilot\s+@alex-dev\s+Assisted$/m);
    expect(log).toMatch(source === 'author' ? /\s@alex-dev\s+Mapped$/m : /\sCursor\s+@alex-dev\s+Mapped$/m);
    expect(await ownerRows(repo)).toEqual(source === 'author' ? [['people', 2], ['@alex-dev', 1]] : [['@alex-dev', 2], ['people', 1]]);
    expect(await command(repo, ['stats'])).toContain('Copilot for @alex-dev');
    expect(await command(repo, ['stats', '--by', 'owner'])).toContain('@alex-dev');
  });

  it('keeps a full Git name even when it is also a mapped person’s display name', async () => {
    const repo = repository(mapped);
    repo.commit({ 'file.ts': 'mapped\n' }, `Mapped${copilot}`);
    const other = { name: mapped.name, email: 'another@example.test' };
    repo.commit({ 'file.ts': 'mapped\nhuman\n' }, 'By hand', { author: other });
    repo.commit({ 'file.ts': 'mapped\nhuman\nassisted\n' }, `Assisted${copilot}`, { author: other });

    const blame = await command(repo, ['blame', 'file.ts']);
    expect(blame).toMatch(/^2\s+Alex Rivera\s+\S+\s+human$/m);
    expect(blame).toMatch(/^3\s+Copilot\s+Alex Rivera\s+\S+\s+assisted$/m);
    const log = await command(repo, ['log']);
    expect(log).toMatch(/\sAlex Rivera\s+By hand$/m);
    expect(log).toMatch(/\sCopilot\s+Alex Rivera\s+Assisted$/m);
    expect(await ownerRows(repo)).toEqual([['@alex-dev', 1], ['Alex Rivera', 1], ['people', 1]]);
    expect(await command(repo, ['stats'])).toContain('Copilot for Alex Rivera');
  });

  it('does not merge similar names, case variants or another person’s display name', async () => {
    const repo = repository({ name: 'alexdev', email: mapped.email });
    repo.commit({ 'file.ts': 'mapped\n' }, `Mapped${copilot}`);
    let content = 'mapped\n';
    const names = ['alexdev', 'Alexdev', 'Alex-dev', 'alex-dev2', 'alex_dev'];
    for (const name of names) {
      content += `${name}\n`;
      repo.commit({ 'file.ts': content }, `${name}${copilot}`, { author: { name, email: 'another@example.test' } });
    }
    const blame = await command(repo, ['blame', 'file.ts']), log = await command(repo, ['log']);
    for (const name of names) {
      expect(blame).toMatch(new RegExp(`Copilot\\s+${name}\\s+\\S+\\s+${name}$`, 'm'));
      expect(log).toMatch(new RegExp(`Copilot\\s+${name}\\s+${name}$`, 'm'));
    }
    const expected = ['@alex-dev', ...names].map(name => [name, 1]);
    const owners = await ownerRows(repo);
    expect(owners).toHaveLength(expected.length);
    expect(owners).toEqual(expect.arrayContaining(expected));
    const stats = JSON.parse(await command(repo, ['stats', '--json'])) as RepositoryStats;
    expect(stats.rows).toHaveLength(expected.length);
    expect(stats.rows.map(row => row.name)).toEqual(expect.arrayContaining(['@alex-dev', ...names].map(name => `Copilot for ${name}`)));
  });

  it('learns from co-authors outside the selected file, date range and log limit', async () => {
    const repo = repository({ name: 'Another Person', email: 'another@example.test' });
    // A human co-author is evidence even when provenance names only the primary author.
    repo.commit({ 'other.ts': 'old\n' }, `Earlier\n\nCo-authored-by: ${mapped.name} <${mapped.email}>`, { at: '2026-09-01T12:00:00Z' });
    repo.commit({ 'file.ts': 'human\n', 'other.ts': 'replacement\n' }, 'By hand', { author: local, at: '2026-09-02T12:00:00Z' });
    repo.commit({ 'file.ts': 'human\nassisted\n' }, `Assisted${copilot}`, { author: local, at: '2026-09-03T12:00:00Z' });
    expect(await command(repo, ['blame', 'file.ts'])).toMatch(/^1\s+@alex-dev\s+\S+\s+human$/m);
    expect(await command(repo, ['log', '-n', '1'])).toMatch(/Copilot\s+@alex-dev\s+Assisted$/m);
    expect(await command(repo, ['log', '--since', '2026-09-02T00:00:00Z'])).toMatch(/@alex-dev\s+By hand$/m);
    expect(await ownerRows(repo, 'file.ts', '--since', '2026-09-02T00:00:00Z')).toEqual([['@alex-dev', 1], ['people', 1]]);
  });

  it('keeps evidence within the requested revision and does not reuse another repository’s logins', async () => {
    const repo = repository(local);
    const before = repo.commit({ 'file.ts': 'human\n' }, 'Before');
    repo.commit({ 'other.ts': 'evidence\n' }, 'Later', { author: mapped });
    expect(await command(repo, ['blame', 'file.ts'])).toMatch(/^1\s+@alex-dev\s/m);
    expect(await command(repo, ['blame', 'file.ts', '--rev', before])).toMatch(/^1\s+alex-dev\s/m);
    const unrelated = repository(local);
    unrelated.commit({ 'file.ts': 'human\n' }, 'Unrelated');
    expect(await command(unrelated, ['blame', 'file.ts'])).toMatch(/^1\s+alex-dev\s/m);
  });

  it('does not learn logins from quoted co-author examples', async () => {
    const repo = repository(local);
    repo.commit({ 'file.ts': 'human\n' }, `Explain a credit\n\n\`\`\`text\nCo-authored-by: ${mapped.name} <${mapped.email}>\n\`\`\``);
    expect(await command(repo, ['blame', 'file.ts'])).toMatch(/^1\s+alex-dev\s/m);
  });

  it('only promotes exact names with GitHub login syntax and redacts email-shaped names', () => {
    const logins = personLogins([mapped]);
    expect(personLabel(local, logins)).toBe('@alex-dev');
    expect(personLabel({ name: 'Alex-dev' }, logins)).toBe('Alex-dev');
    for (const name of ['Alex Rivera', 'alex_dev', 'alex--dev', '-alex', 'alex-', 'álëx', 'a'.repeat(40)]) {
      expect(personLabel({ name }, new Set([...logins, name]))).toBe(name);
    }
    expect(personLabel({ name: 'private@example.test' }, logins)).toBe('[private email]');
  });
});
