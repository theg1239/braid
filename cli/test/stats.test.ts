import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryStats, type RepositoryStats } from '../src/schemas';
import { blameFile } from '../src/commands/blame';
import { braid, cleanup, repository, testContext } from './helpers';
import { count } from '../src/terminal';

afterEach(cleanup);
const alice = { name: 'Alice', email: '1+alice@users.noreply.github.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const bot = { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' };

/** Surviving lines from people, two owners of Claude, a bot and a note that overrides the co-author. */
function history() {
  const repo = repository();
  repo.commit({ 'app.ts': 'human\n' }, 'Start', { author: alice, at: '2026-09-01T12:00:00Z' });
  repo.commit({ 'app.ts': 'human\nclaude-bob\nclaude-bob-2\n' }, 'Bob with Claude\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>', { author: bob, at: '2026-09-02T12:00:00Z' });
  repo.commit({ 'app.ts': 'human\nclaude-bob\nclaude-bob-2\nclaude-alice\n' }, 'Alice with Claude\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>', { author: alice, at: '2026-09-03T12:00:00Z' });
  repo.commit({ 'app.ts': 'human\nclaude-bob\nclaude-bob-2\nclaude-alice\nbot\n' }, 'Bot', { author: bot, at: '2026-09-04T12:00:00Z' });
  const noted = repo.commit({ 'app.ts': 'human\nclaude-bob\nclaude-bob-2\nclaude-alice\nbot\nnoted\n' }, 'A plain message\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>', { at: '2026-09-05T12:00:00Z' });
  repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'invented-name', model: 'gpt-6.1-sol', tool: 'codex/1.8.0' }, owner: { name: 'Alice', github: 'alice' } }), noted]);
  repo.commit({ 'lib/other.ts': 'other-human\n' }, 'Another person', { author: bob, at: '2026-09-06T12:00:00Z' });
  return repo;
}

async function stats(repo: ReturnType<typeof repository>, ...args: string[]) {
  const result = await braid(['stats', '--json', ...args], { cwd: repo.root, env: repo.env });
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  return v.parse(repositoryStats, JSON.parse(result.stdout));
}

describe('braid stats', () => {
  it('names one file and one line in the singular, and groups thousands', () => {
    expect([count(1, 'file'), count(2, 'file'), count(111_068, 'line')]).toEqual(['1 file', '2 files', '111,068 lines']);
  });
  it('uses the same attribution as blame, grouping people and ranking model/owner pairs by surviving lines', async () => {
    const repo = history(), result = await stats(repo);
    expect(result).toMatchObject({ repository: 'repo', head: repo.git(['rev-parse', 'HEAD']), files: 2, lines: 7, skipped: { binary: 0, generated: 0, large: 0 } });
    expect(result.rows.map(row => [row.kind, row.name, row.lines])).toEqual([
      ['agent', 'Claude Opus 5 for Bob', 2], ['human', 'people', 2],
      ['agent', 'Claude Opus 5 for @alice', 1], ['agent', 'Copilot', 1], ['agent', 'GPT-6.1 Sol for @alice', 1],
    ]);
    expect(result.rows.find(row => row.model === 'GPT-6.1 Sol')).toMatchObject({ owner: '@alice', tool: 'codex' });
    expect(result.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
    const blame = blameFile(testContext({ cwd: repo.root, env: repo.env }).context, repo.root, 'app.ts', 'HEAD').blame;
    expect(blame.ranges.map(range => range.provenance.agent?.name ?? 'people')).toEqual(['people', 'Claude Opus 5', 'Claude Opus 5', 'Copilot', 'GPT-6.1 Sol']);
  });

  it.each(['model', 'owner', 'tool'] as const)('regroups by %s', async by => {
    const repo = history(), result = await stats(repo, '--by', by);
    const expected = {
      model: [['Claude Opus 5', 3], ['people', 2], ['Copilot', 1], ['GPT-6.1 Sol', 1]],
      owner: [['@alice', 2], ['Bob', 2], ['people', 2], ['unknown owner', 1]],
      tool: [['claude-code', 3], ['people', 2], ['codex', 1], ['github-copilot', 1]],
    };
    expect(result.rows.map(row => [row.name, row.lines])).toEqual(expected[by]);
    expect(result.lines).toBe(7);
  });

  it('counts only surviving lines from commits newer than --since, using the committer date', async () => {
    const repo = history();
    repo.commit({ 'old-author.txt': 'new commit\n' }, 'Committed recently', { at: '2020-01-01T12:00:00Z', extra: { GIT_COMMITTER_DATE: '2026-09-07T12:00:00Z' } });
    const result = await stats(repo, '--since', '2026-09-03T23:59:59Z');
    expect(result).toMatchObject({ files: 3, lines: 4 });
    expect(result.rows.map(row => [row.name, row.lines])).toEqual([['people', 2], ['Copilot', 1], ['GPT-6.1 Sol for @alice', 1]]);
    expect((await stats(repo, '--since', '2026-09-05T12:00:00Z')).rows).toEqual([{ kind: 'human', name: 'people', lines: 2, share: 1 }]);
    expect((await stats(repo, '--since', '2030-01-01')).rows).toEqual([]);
  });

  it('reports exclusive binary, generated and large skips, including HEAD attributes and the exact cap', async () => {
    const repo = repository();
    repo.commit({
      '.gitattributes': 'marked.txt linguist-generated\nfalse.txt linguist-generated=false\nunset.txt -linguist-generated\nopaque.txt -diff\n',
      'nested/.gitattributes': '*.txt linguist-generated=true\n',
      'nested/generated.txt': 'generated\n', 'marked.txt': 'generated\n', 'opaque.txt': 'text without diff\n',
      'false.txt': 'text\n', 'unset.txt': 'text\n',
      'package-lock.json': '{}\n', 'pnpm-lock.yaml': 'lock\n', 'yarn.lock': 'lock\n', 'Cargo.lock': 'lock\n',
      'app.min.js': 'generated\n', 'dist/a.txt': 'generated\n', 'nested/build/a.txt': 'generated\n', 'vendor/a.txt': 'generated\n',
      'binary.dat': 'image\0data\n', 'large.txt': 'x\n'.repeat(20_001), 'cap.txt': 'x\n'.repeat(20_000),
      'empty.txt': '', 'unterminated.txt': 'one\ntwo',
    }, 'Files');
    // Local edits and staged additions must not alter HEAD classification or totals.
    writeFileSync(join(repo.root, '.gitattributes'), '*.txt -diff\n');
    repo.git(['add', '.gitattributes']);
    const result = await stats(repo);
    expect(result.skipped).toEqual({ binary: 1, generated: 11, large: 1 });
    expect(result).toMatchObject({ files: 7, lines: 20_009 });
  });

  it('uses HEAD despite dirty files, staged deletions/additions, and untracked files', async () => {
    const repo = repository();
    repo.commit({ 'a.txt': 'one\n', 'deleted.txt': 'two\n' }, 'First');
    appendFileSync(join(repo.root, 'a.txt'), 'local\n');
    repo.git(['rm', 'deleted.txt']);
    writeFileSync(join(repo.root, 'staged.txt'), 'staged\n');
    repo.git(['add', 'staged.txt']);
    writeFileSync(join(repo.root, 'untracked.txt'), 'untracked\n');
    expect(await stats(repo)).toMatchObject({ files: 2, lines: 2 });
  });

  it('reads HEAD attributes on older Git without changing its working tree or real index', async () => {
    const repo = repository();
    repo.commit({ '.gitattributes': 'generated.txt linguist-generated\n', 'generated.txt': 'skip\n', 'kept.txt': 'keep\n' }, 'Files');
    writeFileSync(join(repo.root, '.gitattributes'), '*.txt -diff\n');
    repo.git(['add', '.gitattributes']);
    const before = readFileSync(join(repo.root, '.git', 'index'));
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(repo.home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'check-attr' && args.some(arg => arg.startsWith('--source='))) { process.stderr.write("error: unknown option 'source'\\n"); process.exit(129); }
const result = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const output = await braid(['stats', '--json'], { cwd: repo.root, env: { ...repo.env, PATH: `${bin}:${repo.env.PATH}` } });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ files: 2, lines: 2, skipped: { binary: 0, generated: 1, large: 0 } });
    expect(readFileSync(join(repo.root, '.git', 'index'))).toEqual(before);
    expect(readFileSync(join(repo.root, '.gitattributes'), 'utf8')).toBe('*.txt -diff\n');
  });

  it('selects multiple paths once and resolves them from a subdirectory', async () => {
    const repo = history();
    expect(await stats(repo, 'app.ts', 'lib', 'app.ts')).toMatchObject({ files: 2, lines: 7 });
    const output = await braid(['stats', 'other.ts', '--json'], { cwd: join(repo.root, 'lib'), env: repo.env });
    expect(v.parse(repositoryStats, JSON.parse(output.stdout))).toMatchObject({ files: 1, lines: 1 });
    const all = await braid(['stats', '--json'], { cwd: join(repo.root, 'lib'), env: repo.env });
    expect(JSON.parse(all.stdout)).toMatchObject({ files: 2, lines: 7 });
  });

  it('handles unusual path names and skips symlinks without following them', async () => {
    const repo = repository();
    repo.commit({ 'a\nb\t.txt': 'one\n', '-option.txt': 'two\n' }, 'Paths');
    symlinkSync('/etc/passwd', join(repo.root, 'link'));
    repo.git(['add', 'link']); repo.git(['commit', '-qm', 'Link']);
    expect(await stats(repo)).toMatchObject({ files: 2, lines: 2, skipped: { binary: 1, generated: 0, large: 0 } });
  });

  it('reads both flat and fan-out notes, ignores malformed notes, and normalizes model ids for grouping', async () => {
    const repo = repository();
    const first = repo.commit({ 'one.txt': 'one\n' }, 'Claude\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>');
    const second = repo.commit({ 'two.txt': 'two\n' }, 'Note only');
    repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', 'not JSON', first]);
    // git notes already covers the normal layout; move a valid note to an explicit fan-out tree.
    repo.git(['notes', '--ref=refs/notes/braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'ignored', model: 'claude-opus-5', tool: 'claude-code/3' } }), second]);
    const listing = repo.git(['notes', '--ref=refs/notes/braid', 'list']).split('\n').map(line => line.split(' '));
    const directory = join(repo.home, 'notes-index');
    const extra = { GIT_INDEX_FILE: directory };
    repo.git(['read-tree', '--empty'], extra);
    for (const [blob, commit] of listing) repo.git(['update-index', '--add', '--cacheinfo', '100644', blob, commit === second ? `${commit.slice(0, 2)}/${commit.slice(2)}` : commit], extra);
    const tree = repo.git(['write-tree'], extra), parent = repo.git(['rev-parse', 'refs/notes/braid']);
    const commit = repo.git(['commit-tree', tree, '-p', parent, '-m', 'Fan-out']);
    repo.git(['update-ref', 'refs/notes/braid', commit]);
    expect((await stats(repo, '--by', 'model')).rows).toEqual([{ kind: 'agent', name: 'Claude Opus 5', model: 'Claude Opus 5', lines: 2, share: 1 }]);
  });

  it('prints only the compact table and skips, and rejects invalid grouping or a missing repository', async () => {
    const repo = history();
    const result = await braid(['stats'], { cwd: repo.root, env: repo.env });
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(7);
    expect(result.stdout).toMatch(/^repo · 7 lines · 2 files\nAuthor\s+Lines\s+%\n/);
    expect(result.stdout).toContain('Claude Opus 5 for Bob');
    expect(result.stdout).not.toContain('\x1b[');
    expect((await braid(['stats', '--by', 'person'], { cwd: repo.root, env: repo.env })).exitCode).not.toBe(0);
    expect((await braid(['stats'], { cwd: repo.home, env: repo.env })).stderr).toContain('Run braid inside a Git repository.');
  });

  it('defines the JSON shape with Valibot, rejecting invalid counts and shares', () => {
    const output: RepositoryStats = { repository: 'repo', head: 'a'.repeat(40), files: 0, lines: 0, rows: [], skipped: { binary: 0, generated: 0, large: 0 } };
    expect(v.safeParse(repositoryStats, output).success).toBe(true);
    expect(v.safeParse(repositoryStats, { ...output, files: -1 }).success).toBe(false);
    expect(v.safeParse(repositoryStats, { ...output, rows: [{ kind: 'agent', name: 'Claude', lines: 1, share: 2 }] }).success).toBe(false);
    expect(v.safeParse(repositoryStats, { ...output, head: 'main' }).success).toBe(false);
  });
});

describe('owners across addresses', () => {
  it('counts a person who commits from a no-reply and another address as one owner', async () => {
    const { groupStats } = await import('../src/stats');
    const claude = { name: 'Claude Opus 5', model: 'Claude Opus 5', tool: 'claude-code' };
    const made = (commit: string, owner: { name: string; github?: string }) => ({ commit, at: '2026-09-01T12:00:00Z', subject: commit, kind: 'agent' as const, agent: claude, owner, confidence: 'inferred' as const });
    const known = new Map([['a', made('a', { name: 'Alice', github: 'alice' })], ['b', made('b', { name: 'alice' })]]);
    const rows = groupStats(new Map([['a', 3], ['b', 2]]), known);
    expect(rows.map(row => [row.name, row.lines])).toEqual([['Claude Opus 5 for @alice', 5]]);
  });
});
