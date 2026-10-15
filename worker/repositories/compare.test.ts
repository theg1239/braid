import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareRepository, COMPARE_LIMITS, repositoryBranches, repositoryDiff } from './compare';
import { startGitServer } from '../test/git-server';
import { parse, repositoryCompareQuery, repositoryDiffQuery } from '../schemas';
import { formatNote } from '../../shared/provenance';
import { publicPathAllowed, agentPathAllowed } from '../http/agent-auth';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from '../workspace/seed';
import type { BraidEnv } from '../env';

let git: Awaited<ReturnType<typeof startGitServer>>;
let root: string, main: string, feature: string, next: string;
beforeAll(async () => {
  git = await startGitServer();
  root = git.commitTree({ 'README.md': 'Relay\n', 'src/a.ts': 'export const a = 1;\n', 'gone.txt': 'old\n' }, undefined, 'Start Relay');
  main = git.commitTree({ 'only-main.txt': 'main\n' }, root, 'Main only');
  feature = git.commitTree({ 'src/a.ts': 'export const a = 2;\n', 'new.txt': 'one\ntwo\n', 'gone.txt': null }, root, 'Add retries', { name: 'Maya Chen', email: '123+maya-chen@users.noreply.github.com' });
  next = git.commitTree({ 'new.txt': 'one\ntwo\nthree\n' }, feature, 'Finish retries');
  git.native(['update-ref', 'refs/heads/main', main]);
  git.native(['update-ref', 'refs/heads/feature/retries', next]);
  git.native(['update-ref', 'refs/heads/archive', root]);
  git.native(['update-ref', 'refs/notes/braid', git.commitTree({}, undefined, 'Empty notes')]);
});
afterAll(async () => { await git.close(); });

const merge = (parents: string[], message: string) => git.native(['commit-tree', git.native(['rev-parse', `${parents[0]}^{tree}`]).trim(), ...[...new Set(parents)].flatMap(parent => ['-p', parent])], `${message}\n`).trim();

it('lists the default branch first with real tip subjects, hashes, authors and times', async () => {
  const result = await repositoryBranches(git.repository, { branch: 'main', branches: ['feature/retries', 'archive', 'main'] });
  expect(result.branches.map(branch => branch.name)).toEqual(['main', 'archive', 'feature/retries']);
  expect(result.branches[0].tip).toMatchObject({ hash: main, title: 'Main only', author: { kind: 'human', name: 'Test' }, time: expect.stringMatching(/^\d{4}-/) });
  expect(JSON.stringify(result)).not.toContain('test@example.test');
});

it('compares from the merge base and excludes files and commits found only on base', async () => {
  const result = await compareRepository(git.repository, 'main', 'feature/retries');
  expect(result).toMatchObject({ base: main, head: next, mergeBase: root, status: 'ready', filesTruncated: false, commitsTruncated: false });
  expect(result.commits.map(commit => commit.hash).sort()).toEqual([feature, next].sort());
  expect(result.files.map(file => [file.path, file.additions, file.deletions, file.added, file.deleted])).toEqual([
    ['gone.txt', 0, 1, false, true], ['new.txt', 3, 0, true, false], ['src/a.ts', 1, 1, false, false],
  ]);
  expect(await repositoryDiff(git.repository, result.mergeBase!, result.head, 'src/a.ts')).toMatchObject({ before: 'export const a = 1;\n', after: 'export const a = 2;\n', binary: false });
  expect(await repositoryDiff(git.repository, root, next, 'gone.txt')).toMatchObject({ before: 'old\n', after: null });
  expect(await repositoryDiff(git.repository, root, next, 'new.txt')).toMatchObject({ before: null, after: 'one\ntwo\nthree\n' });
});

it('walks second parents and removes head commits already merged into base', async () => {
  const combined = merge([main, feature], 'Merge feature');
  const result = await compareRepository(git.repository, combined, next);
  expect(result.mergeBase).toBe(feature);
  expect(result.commits.map(commit => commit.hash)).toEqual([next]);
  expect(result.files.map(file => file.path)).toEqual(['new.txt']);
  const behind = await compareRepository(git.repository, next, feature);
  expect(behind).toMatchObject({ status: 'ready', mergeBase: feature, files: [], commits: [] });
});

it('matches Git for merge bases and reachable commits across a graph of merges', async () => {
  const graph = [root, main, feature, next];
  for (let i = 0; i < 18; i++) graph.push(merge([graph.at(-1)!, graph[(i * 7 + 1) % graph.length]], `Merge ${i}`));
  for (const [a, b] of [[5, 11], [8, 16], [14, 9], [1, 19], [2, 20]]) {
    const result = await compareRepository(git.repository, graph[a], graph[b]);
    expect(result.mergeBase).toBe(git.native(['merge-base', graph[a], graph[b]]).trim());
    expect(result.commits.map(commit => commit.hash).sort()).toEqual(git.native(['rev-list', graph[b], `^${graph[a]}`]).trim().split('\n').filter(Boolean).sort());
  }
});

it('reports criss-cross histories without choosing an arbitrary merge base', async () => {
  const a = merge([main, feature], 'Merge left'), b = merge([feature, main], 'Merge right');
  expect((await compareRepository(git.repository, a, b)).status).toBe('multiple-bases');
});

it('handles identical tips, unrelated histories, and unknown refs', async () => {
  expect(await compareRepository(git.repository, 'main', main)).toMatchObject({ status: 'identical', mergeBase: main, files: [], commits: [] });
  const other = git.commitTree({ 'other.txt': 'other\n' }, undefined, 'Unrelated');
  expect(await compareRepository(git.repository, main, other)).toMatchObject({ status: 'unrelated', mergeBase: null, files: [] });
  await expect(compareRepository(git.repository, 'missing-branch', main)).rejects.toMatchObject({ status: 404 });
  await expect(repositoryDiff(git.repository, root, next, 'missing.txt')).rejects.toMatchObject({ status: 404 });
});

it('does not read below known shared ancestry, including missing shallow parents', async () => {
  const readCommit = vi.fn(git.repository.readCommit);
  const reader = { ...git.repository, readCommit: vi.fn(async (hash: string) => hash === root ? null : readCommit(hash)) };
  expect(await compareRepository(reader, feature, next)).toMatchObject({ status: 'ready', mergeBase: feature });
  expect(readCommit.mock.calls.map(call => call[0])).not.toContain(root);
  expect(await compareRepository(reader, main, next)).toMatchObject({ status: 'limited', mergeBase: null, files: [], commits: [] });
});

it('bounds history reads and caps the displayed commits', async () => {
  let head = root;
  for (let i = 0; i < COMPARE_LIMITS.commits + 4; i++) head = git.commitTree({}, head, `Step ${i}`);
  const result = await compareRepository(git.repository, root, head);
  expect(result.status).toBe('ready');
  expect(result.commits).toHaveLength(COMPARE_LIMITS.commits);
  expect(result.commitsTruncated).toBe(true);
  const readCommit = vi.fn(git.repository.readCommit);
  const oldLimit = COMPARE_LIMITS.walk;
  try {
    COMPARE_LIMITS.walk = 6;
    expect(await compareRepository({ ...git.repository, readCommit }, main, head)).toMatchObject({ status: 'limited', files: [], commits: [] });
    expect(readCommit.mock.calls.length).toBeLessThanOrEqual(8);
  } finally { COMPARE_LIMITS.walk = oldLimit; }
}, 20_000);

it('keeps diffs pinned if head moves while someone is reading', async () => {
  git.native(['update-ref', 'refs/heads/moving', feature]);
  const result = await compareRepository(git.repository, 'main', 'moving');
  git.native(['update-ref', 'refs/heads/moving', next]);
  expect(await repositoryDiff(git.repository, result.mergeBase!, result.head, 'new.txt')).toMatchObject({ after: 'one\ntwo\n' });
});

it('distinguishes empty files, binary files, oversized text and mode changes', async () => {
  const changed = git.commitTree({ 'empty.txt': '', 'binary.dat': 'a\0b', 'large.txt': 'a'.repeat(COMPARE_LIMITS.text + 1) }, root, 'Files');
  const result = await compareRepository(git.repository, root, changed);
  expect(result.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'empty.txt', additions: 0, added: true, binary: false }),
    expect.objectContaining({ path: 'binary.dat', binary: true, tooLarge: false }),
    expect.objectContaining({ path: 'large.txt', binary: false, tooLarge: true }),
  ]));
  expect(await repositoryDiff(git.repository, root, changed, 'empty.txt')).toMatchObject({ before: null, after: '' });
  expect(await repositoryDiff(git.repository, root, changed, 'binary.dat')).toMatchObject({ binary: true });
  expect(await repositoryDiff(git.repository, root, changed, 'large.txt')).toMatchObject({ tooLarge: true });
  const blob = git.native(['rev-parse', `${root}:README.md`]).trim();
  const tree = git.native(['mktree'], `100755 blob ${blob}\tREADME.md\n`).trim();
  const executable = git.native(['commit-tree', tree, '-p', root], 'Executable\n').trim();
  expect((await compareRepository(git.repository, root, executable)).files).toContainEqual(expect.objectContaining({ path: 'README.md', additions: 0, deletions: 0, beforeMode: '100644', afterMode: '100755' }));
});

it('compares symlink targets, gitlinks and a file replaced by a directory', async () => {
  const blob = git.native(['hash-object', '-w', '--stdin'], 'README.md').trim();
  const tree = git.native(['mktree'], `120000 blob ${blob}\tlink\n160000 commit ${feature}\tmodule\n`).trim();
  const special = git.native(['commit-tree', tree, '-p', root], 'Links\n').trim();
  expect(await repositoryDiff(git.repository, root, special, 'link')).toMatchObject({ before: null, after: 'README.md' });
  expect(await repositoryDiff(git.repository, root, special, 'module')).toMatchObject({ after: `Subproject commit ${feature}\n` });
  const directory = git.commitTree({ 'gone.txt': null, 'gone.txt/child': 'new\n' }, root, 'Directory');
  expect((await compareRepository(git.repository, root, directory)).files.map(file => [file.path, file.added, file.deleted])).toEqual([
    ['gone.txt', false, true], ['gone.txt/child', true, false],
  ]);
});

it('bounds large changed-file lists and reports the partial result', async () => {
  const files = Object.fromEntries(Array.from({ length: COMPARE_LIMITS.files + 2 }, (_, i) => [`many/file-${String(i).padStart(4, '0')}`, 'line\n']));
  const changed = git.commitTree(files, root, 'Many files');
  const result = await compareRepository(git.repository, root, changed);
  expect(result.files).toHaveLength(COMPARE_LIMITS.files);
  expect(result.filesTruncated).toBe(true);
}, 20_000);

it('uses Braid notes and known provenance for the model, owner and simulated label', async () => {
  const notes = git.commitTree({ [`${feature.slice(0, 2)}/${feature.slice(2)}`]: formatNote({ v: 1, agent: { name: 'Claude', model: 'claude-opus-5-5' }, owner: { name: 'Maya Chen', github: 'maya-chen' } }) }, undefined, 'Notes');
  git.native(['update-ref', 'refs/notes/braid', notes]);
  const result = await compareRepository(git.repository, root, feature);
  expect(result.commits[0].author).toMatchObject({ kind: 'agent', name: 'Claude Opus 5.5', owner: { name: 'Maya Chen', github: 'maya-chen' } });
  const known = vi.fn(async () => [{ commit: feature, at: '2026-10-12T12:00:00Z', subject: 'Add retries', kind: 'agent' as const, agent: { id: 'sim:one', name: 'Simulated' }, confidence: 'braid' as const }]);
  expect((await compareRepository(git.repository, root, feature, known)).commits[0].author.kind).toBe('simulated');
  expect(known).toHaveBeenCalledWith([feature]);
});

describe('comparison boundaries', () => {
  it('accepts slash refs and rejects missing refs, revision expressions and invalid paths', () => {
    expect(parse(repositoryCompareQuery, { base: 'main', head: 'feature/retries' })).toEqual({ base: 'main', head: 'feature/retries' });
    for (const head of ['', 'main\n', 'main..other', 'HEAD~1', 'branch@{1}']) expect(() => parse(repositoryCompareQuery, { base: 'main', head })).toThrow();
    expect(() => parse(repositoryCompareQuery, { head: 'main' })).toThrow();
    for (const path of ['../secret', '.git/config', 'a//b', '']) expect(() => parse(repositoryDiffQuery, { base: root, head: next, path })).toThrow();
    expect(() => parse(repositoryDiffQuery, { base: 'main', head: next, path: 'README.md' })).toThrow();
  });
  it('allows public and agent reads without allowing writes', () => {
    for (const path of ['/api/repository/branches', '/api/repository/compare', '/api/repository/compare/diff']) {
      expect(publicPathAllowed(path, 'GET')).toBe(true);
      expect(publicPathAllowed(path, 'POST')).toBe(false);
      expect(agentPathAllowed(path, 'GET', 'read')).toBe(true);
      expect(agentPathAllowed(path, 'POST', 'work')).toBe(false);
    }
  });

  it('serves branch, compare and pinned diff endpoints from the workspace', async () => {
    const fixture = storageFixture();
    const capabilities = { mode: 'live' as const, artifacts: true, ai: false, storage: 'durable-object' as const, authenticated: true, model: 'test', namespace: 'test', canWrite: true };
    const seed = seedWorkspace('live', capabilities);
    seed.project = { id: 'repo', name: 'Relay', description: '', stack: [], branch: 'main', head: main, branches: ['main', 'feature/retries'] };
    await fixture.storage.put('workspace', seed);
    // Artifacts accepts branch names and complete OIDs; Git's test adapter also accepts prefixes.
    const log: ArtifactsRepo['log'] = (query = {}) => /^[a-f0-9]{7,39}$/i.test(query.ref ?? '') ? Promise.resolve([]) : git.repository.log(query);
    const env = { ARTIFACTS: { get: async () => ({ ...git.repository, log, [Symbol.dispose]() {} }) }, AI_MODEL: 'test', ARTIFACTS_NAMESPACE: 'test' } as unknown as BraidEnv;
    try {
      const workspace = new Workspace(fixture.ctx, env);
      await fixture.ready();
      const get = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': 'live' } }));
      expect(await (await get('/api/repository/branches')).json()).toMatchObject({ defaultBranch: 'main', branches: [{ name: 'main' }, { name: 'feature/retries' }] });
      expect(await (await get('/api/repository/compare?base=main&head=feature%2Fretries')).json()).toMatchObject({ status: 'ready', mergeBase: root, head: next });
      for (const head of [next, next.slice(0, 7).toUpperCase()]) {
        const response = await get(`/api/repository/compare?base=${feature.slice(0, 7)}&head=${head}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'ready', base: feature, head: next, mergeBase: feature, files: [{ path: 'new.txt' }] });
      }
      expect(await (await get(`/api/repository/compare/diff?base=${root}&head=${next}&path=src%2Fa.ts`)).json()).toMatchObject({ before: 'export const a = 1;\n', after: 'export const a = 2;\n' });
      for (const path of ['/api/repository/compare?head=main', '/api/repository/compare?base=main&head=', `/api/repository/compare/diff?base=${root}&head=${next}&path=..%2Fsecret`]) expect((await get(path)).status).toBe(400);
    } finally { fixture.db.close(); }
  });

  it('serves the recorded branches and Identical without touching live Artifacts', async () => {
    const fixture = storageFixture(), getRepo = vi.fn();
    try {
      const workspace = new Workspace(fixture.ctx, { ARTIFACTS: { get: getRepo }, AI_MODEL: 'test', ARTIFACTS_NAMESPACE: 'test' } as unknown as BraidEnv);
      await fixture.ready();
      const get = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`));
      expect(await (await get('/api/repository/branches')).json()).toMatchObject({ defaultBranch: 'main', branches: [
        { name: 'main', tip: { title: expect.any(String), author: { kind: 'agent' } } },
        { name: 'refund-rounding', tip: { title: 'Round refund amounts in the ledger', author: { kind: 'agent' } } },
      ] });
      expect(await (await get('/api/repository/compare?base=main&head=main')).json()).toMatchObject({ status: 'identical', commits: [], files: [] });
      expect((await get('/api/repository/compare?base=main&head=missing')).status).toBe(404);
      expect(getRepo).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });
});
