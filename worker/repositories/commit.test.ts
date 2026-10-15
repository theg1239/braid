import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatNote, NOTES_REF } from '../../shared/provenance';
import type { CommitDetail, CommitDiff } from '../../shared/history';
import type { Provenance } from '../../shared/types';
import { agentPathAllowed, publicPathAllowed } from '../http/agent-auth';
import { recordedExample } from '../changes/demo';
import { COMMIT_LIMITS, commitDiffRequest, commitRequest, recordedCommit, recordedCommitDiff, repositoryCommit, repositoryCommitDiff } from './commit';
import type { BraidEnv } from '../env';
import { seedWorkspace } from '../workspace/seed';
import { startGitServer } from '../test/git-server';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';

let git: Awaited<ReturnType<typeof startGitServer>>;
let root: string, head: string, binary: string, large: string, mode: string, many: string;
const message = 'Limit retries\n\nStop after three attempts.\n\nCo-authored-by: Dev <dev@example.test>';
beforeAll(async () => {
  git = await startGitServer();
  root = git.commitTree({ 'README.md': '# Relay\n', 'src/retry.ts': 'const retries = 0;\n', 'old.txt': 'one\ntwo\n' }, undefined, 'Initial commit');
  head = git.commitTree({ 'src/retry.ts': 'const retries = 3;\n', 'old.txt': null, 'new.txt': 'hello\nworld', 'empty.txt': '' }, root, message, { name: 'Maya Chen', email: '12+maya-chen@users.noreply.github.com' });
  git.native(['update-ref', 'refs/heads/main', head]);
  binary = git.commitTree({ 'image.bin': '\0\u0001binary' }, root, 'Add image');
  large = git.commitTree({ 'large.txt': '界'.repeat(Math.ceil(COMMIT_LIMITS.text / 3)) }, root, 'Add large file');
  const tree = git.native(['ls-tree', `${root}^{tree}`]).replace('100644 blob', '100755 blob');
  mode = git.native(['commit-tree', git.native(['mktree'], tree).trim(), '-p', root], 'Make readme executable\n').trim();
  const blob = git.native(['hash-object', '-w', '--stdin'], 'new\n').trim();
  const manyTree = git.native(['mktree'], Array.from({ length: COMMIT_LIMITS.files + 1 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(4, '0')}\n`).join('')).trim();
  many = git.native(['commit-tree', manyTree], 'Many files\n').trim();
  const notes = git.commitTree({ [`${head.slice(0, 2)}/${head.slice(2)}`]: formatNote({ v: 1, agent: { name: 'Legacy agent', model: 'claude-opus-5-5', tool: 'claude-code' }, owner: { name: 'Maya Chen', github: 'maya-chen' }, change: { id: 'ch_123456789abcd', number: 42, revision: 1 } }) });
  git.native(['update-ref', NOTES_REF, notes]);
}, 30_000);
afterAll(async () => { await git?.close(); });

describe('commit detail against real Git', () => {
  it('preserves the full message, uses committer time, and resolves the note’s agent and pull request', async () => {
    const result = await repositoryCommit(git.repository, head), metadata = (await git.repository.readCommit(head))!;
    expect(result).toMatchObject({ hash: head, title: 'Limit retries', message, at: new Date(metadata.committedAt * 1000).toISOString(), parents: [root], pullRequest: 42,
      author: { name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: { name: 'Maya Chen', github: 'maya-chen' } }, filesTruncated: false, parentUnavailable: false });
    expect(JSON.stringify(result.author)).not.toContain('users.noreply.github.com');
    expect(result).not.toHaveProperty('committer');
  });

  it('uses Braid’s landing provenance ahead of imported notes without reading notes again', async () => {
    const known = vi.fn(async (): Promise<Provenance[]> => [{ commit: head, at: '2026-10-12T00:00:00Z', subject: 'Ignored subject', kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' }, owner: { name: 'Ishaan', github: 'theg1239' }, confidence: 'braid', change: { id: 'ch_123456789abcd', number: 88 } }]);
    const repo = { ...git.repository, log: vi.fn(git.repository.log) };
    expect(await repositoryCommit(repo, head, known)).toMatchObject({ title: 'Limit retries', pullRequest: 88, author: { name: 'GPT-6.1 Sol', owner: { github: 'theg1239' } } });
    expect(known).toHaveBeenCalledExactlyOnceWith([head]);
    expect(repo.log).not.toHaveBeenCalled();
  });

  it('lists additions, modifications, deletions and empty files, leaving contents to the diff endpoint', async () => {
    const result = await repositoryCommit(git.repository, head);
    expect(result.files).toMatchObject([
      { path: 'empty.txt', status: 'added', additions: 0, deletions: 0 },
      { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
      { path: 'old.txt', status: 'deleted', additions: 0, deletions: 2 },
      { path: 'src/retry.ts', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(result.files.every(file => !('before' in file) && !('after' in file))).toBe(true);
    expect(await repositoryCommitDiff(git.repository, head, 'src/retry.ts')).toEqual({ path: 'src/retry.ts', before: 'const retries = 0;\n', after: 'const retries = 3;\n', binary: false, tooLarge: false });
    expect(await repositoryCommitDiff(git.repository, head, 'old.txt')).toMatchObject({ before: 'one\ntwo\n', after: null });
    expect(await repositoryCommitDiff(git.repository, head, 'new.txt')).toMatchObject({ before: null, after: 'hello\nworld' });
    expect(await repositoryCommitDiff(git.repository, head, 'empty.txt')).toMatchObject({ before: null, after: '' });
  });

  it('compares an initial commit to an empty tree', async () => {
    const result = await repositoryCommit(git.repository, root);
    expect(result.parents).toEqual([]);
    expect(result.files).toHaveLength(3);
    expect(result.files.every(file => file.status === 'added' && file.deletions === 0)).toBe(true);
    expect(await repositoryCommitDiff(git.repository, root, 'README.md')).toMatchObject({ before: null, after: '# Relay\n' });
  });

  it('includes a source-free wrapping bound for additions, deletions and both sides of edits', async () => {
    const prose = '# Notes\n\t界 ' + 'A long paragraph with several words. '.repeat(100);
    const sha = git.commitTree({ 'README.md': prose }, root, 'Document delivery decisions');
    const result = await repositoryCommit(git.repository, sha);
    // The tab and wide character each take two columns; line endings take none.
    expect(result.files[0].textColumns).toBe(prose.replace(/\n/g, '').length + 2 + '# Relay'.length);
    expect(result.files[0]).not.toHaveProperty('before');
    expect(result.files[0]).not.toHaveProperty('after');
    const changed = (await repositoryCommit(git.repository, head)).files;
    expect(changed.find(file => file.path === 'new.txt')?.textColumns).toBe(10);
    expect(changed.find(file => file.path === 'old.txt')?.textColumns).toBe(6);
    expect(changed.find(file => file.path === 'empty.txt')?.textColumns).toBe(0);
    expect((await repositoryCommit(git.repository, binary)).files[0].textColumns).toBeUndefined();
  });

  it('compares merges against the first parent, exposing both parent links', async () => {
    const side = git.commitTree({ 'side-only.txt': 'side\n' }, root, 'Side branch');
    const merge = git.native(['commit-tree', git.native(['rev-parse', `${head}^{tree}`]).trim(), '-p', root, '-p', side], 'Merge side branch\n').trim();
    const result = await repositoryCommit(git.repository, merge);
    expect(result.parents).toEqual([root, side]);
    expect(result.files.map(file => file.path)).toEqual(['empty.txt', 'new.txt', 'old.txt', 'src/retry.ts']);
    expect(await repositoryCommitDiff(git.repository, merge, 'src/retry.ts')).toMatchObject({ before: 'const retries = 0;\n', after: 'const retries = 3;\n' });
  });

  it('includes mode-only changes and does not invent text edits', async () => {
    expect((await repositoryCommit(git.repository, mode)).files).toMatchObject([{ path: 'README.md', status: 'modified', additions: 0, deletions: 0, beforeMode: '100644', afterMode: '100755' }]);
    expect(await repositoryCommitDiff(git.repository, mode, 'README.md')).toMatchObject({ before: '# Relay\n', after: '# Relay\n' });
  });

  it('represents file/directory replacements without losing either path', async () => {
    const renamed = git.commitTree({ 'old.txt': null, 'old.txt/child': 'nested\n' }, root, 'Replace file with directory');
    expect((await repositoryCommit(git.repository, renamed)).files).toMatchObject([{ path: 'old.txt', status: 'deleted' }, { path: 'old.txt/child', status: 'added' }]);
    expect(await repositoryCommitDiff(git.repository, renamed, 'old.txt')).toMatchObject({ before: 'one\ntwo\n', after: null });
  });

  it('does not turn a missing shallow parent into an all-added diff', async () => {
    const repo = { ...git.repository, readCommit: async (sha: string) => sha === root ? null : git.repository.readCommit(sha) };
    expect(await repositoryCommit(repo, head)).toMatchObject({ parents: [root], parentUnavailable: true, files: [] });
    await expect(repositoryCommitDiff(repo, head, 'src/retry.ts')).rejects.toThrow('parent commit is unavailable');
  });

  it('bounds text bytes and omits both sides of binary and oversized diffs', async () => {
    expect((await repositoryCommit(git.repository, binary)).files).toMatchObject([{ path: 'image.bin', binary: true, additions: null, deletions: null }]);
    expect(await repositoryCommitDiff(git.repository, binary, 'image.bin')).toMatchObject({ before: null, after: null, binary: true });
    expect((await repositoryCommit(git.repository, large)).files).toMatchObject([{ path: 'large.txt', tooLarge: true, additions: null, deletions: null }]);
    expect(await repositoryCommitDiff(git.repository, large, 'large.txt')).toMatchObject({ before: null, after: null, tooLarge: true });
  });

  it('bounds file lists but allows omitted files to be fetched individually', async () => {
    const result = await repositoryCommit(git.repository, many);
    expect(result.files).toHaveLength(COMMIT_LIMITS.files);
    expect(result.filesTruncated).toBe(true);
    expect(await repositoryCommitDiff(git.repository, many, 'f0300')).toMatchObject({ after: 'new\n' });
  });

  it('stops aggregate blob reads without misrepresenting unknown line counts as zero', async () => {
    const files = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, `${i}\n${'x'.repeat(399_997)}`]));
    const sha = git.commitTree(files, undefined, 'Large commit');
    const repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    const result = await repositoryCommit(repo, sha);
    expect(result.files.at(-1)).toMatchObject({ additions: null, deletions: null, tooLarge: false });
    expect(repo.readBlob.mock.calls.length).toBeLessThanOrEqual(21);
    expect(await repositoryCommitDiff(git.repository, sha, 'f20.txt')).toMatchObject({ before: null, after: files['f20.txt'], tooLarge: false });
  });

  it('returns empty commits and rejects absent commits, unchanged files and unknown files', async () => {
    const empty = git.commitTree({}, head, 'Empty commit');
    expect((await repositoryCommit(git.repository, empty)).files).toEqual([]);
    await expect(repositoryCommit(git.repository, '0'.repeat(40))).rejects.toThrow('Commit not found');
    await expect(repositoryCommitDiff(git.repository, head, 'README.md')).rejects.toThrow('does not change');
    await expect(repositoryCommitDiff(git.repository, head, 'missing')).rejects.toThrow('does not change');
  });

  it('validates full hashes and paths before reading Git, through both Workspace endpoints', async () => {
    const store = storageFixture(), provenance = vi.fn(async () => []), dispose = vi.fn();
    const get = vi.fn(async () => ({ ...git.repository, [Symbol.dispose]: dispose }));
    const env = { ARTIFACTS: { get }, TRUNKS: { getByName: () => ({ provenance, notesHead: async () => git.native(['rev-parse', NOTES_REF]).trim() }) } } as unknown as BraidEnv;
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
    seed.project = { ...seed.project, id: 'project', head, branch: 'main' };
    await store.storage.put('workspace', seed);
    const workspace = new Workspace(store.ctx, env);
    await store.ready();
    const request = (path: string) => workspace.fetch(new Request(`https://braid.test/api/repository/commit${path}`, { headers: { 'x-braid-mode': 'live', 'x-braid-repository': 'test', 'x-braid-public': 'true' } }));
    try {
      expect((await request('?sha=main')).status).toBe(400);
      expect((await request(`/diff?sha=${head}&path=../README.md`)).status).toBe(400);
      expect(get).not.toHaveBeenCalled();
      const response = await request(`?sha=${head}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ hash: head, pullRequest: 42, parents: [root] });
      const diff = await request(`/diff?sha=${head}&path=src/retry.ts`);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({ before: 'const retries = 0;\n', after: 'const retries = 3;\n' });
      expect(provenance).toHaveBeenCalledWith('test', [head], true);
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { store.db.close(); }
  });
});

describe('commit query boundaries, public reads and recorded landings', () => {
  it('rejects malformed hashes and unsafe or empty diff paths', () => {
    for (const sha of ['', 'main', 'abc123', 'a'.repeat(41), '../main', 'a'.repeat(39) + 'g']) expect(() => commitRequest(new URLSearchParams({ sha }))).toThrow();
    for (const path of ['', '../secret', '.git/config', 'a\\b', 'a//b', 'a\0b']) expect(() => commitDiffRequest(new URLSearchParams({ sha: head, path }))).toThrow();
    expect(commitDiffRequest(new URLSearchParams({ sha: head, path: 'docs/日本語 #1.md' }))).toEqual({ sha: head, path: 'docs/日本語 #1.md' });
  });

  it('permits public GET/HEAD and agent reads but never writes', () => {
    for (const path of ['/api/repository/commit', '/api/repository/commit/diff']) {
      expect(publicPathAllowed(path, 'GET')).toBe(true);
      expect(publicPathAllowed(path, 'HEAD')).toBe(true);
      expect(publicPathAllowed(path, 'POST')).toBe(false);
      expect(agentPathAllowed(path, 'GET', 'read')).toBe(true);
      expect(agentPathAllowed(path, 'POST', 'work')).toBe(false);
    }
  });

  it('redacts public metadata, preserves diff contents, and charges both endpoints to the expensive-read budget', async () => {
    const f = await publicRepository();
    try {
      const read = vi.fn(async (request: Request) => Response.json(new URL(request.url).pathname.endsWith('/diff')
        ? { path: 'owner@example.test.txt', before: 'Contact owner@example.test', after: 'Changed' }
        : { hash: head, author: { name: 'owner@example.test', owner: { name: 'Maya', email: 'owner@example.test' } } }));
      f.env.WORKSPACES = { ...f.env.WORKSPACES, get: () => ({ fetch: read }) } as unknown as BraidEnv['WORKSPACES'];
      const detail = `/api/repository/commit?sha=${head}`, diff = `/api/repository/commit/diff?sha=${head}&path=README.md`;
      expect(await (await f.anonymous(detail)).json()).toMatchObject({ author: { name: '[private email]', owner: { name: 'Maya' } } });
      expect(await (await f.anonymous(diff)).json()).toEqual({ path: 'owner@example.test.txt', before: 'Contact owner@example.test', after: 'Changed' });
      for (let i = 2; i < 60; i++) expect((await f.anonymous(i % 2 ? detail : diff)).status).toBe(200);
      for (const path of [detail, diff]) {
        const response = await f.anonymous(path);
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('60');
      }
      expect(read).toHaveBeenCalledTimes(60);
    } finally { await f.close(); }
  });

  it('opens every recorded landing and uses its recorded diffs, author and parent', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [], since: Date.now() };
    const landings = example.changes({ statuses: ['landed'], limit: 1000 }, state).items;
    for (const summary of landings) {
      const change = example.change(summary.id, state), detail = recordedCommit(example, state, summary.landedCommit!);
      expect(detail).toMatchObject({ hash: summary.landedCommit, author: change.author, pullRequest: change.number, parents: [change.landedParent ?? change.baseCommit] });
      for (const file of detail.files) {
        const diff = example.diff(change.id, file.path, {}, state);
        expect(recordedCommitDiff(example, state, detail.hash, file.path)).toMatchObject({ before: diff.before, after: diff.after });
      }
    }
    expect(landings.length).toBeGreaterThan(30);
    expect(() => recordedCommit(example, state, '0'.repeat(40))).toThrow('not found');
  });

  it('serves recorded commits and diffs through Workspace without Artifacts', async () => {
    const store = storageFixture(), workspace = new Workspace(store.ctx, {} as BraidEnv);
    await store.ready();
    const request = (path: string) => workspace.fetch(new Request(`https://braid.test${path}`, { headers: { 'x-braid-mode': 'demo' } }));
    try {
      const history = await (await request('/api/repository/commits')).json() as { items: { hash: string }[] };
      const response = await request(`/api/repository/commit?sha=${history.items[0].hash}`);
      expect(response.status).toBe(200);
      const detail = await response.json() as CommitDetail;
      const diffResponse = await request(`/api/repository/commit/diff?sha=${detail.hash}&path=${encodeURIComponent(detail.files[0].path)}`);
      expect(diffResponse.status).toBe(200);
      expect((await diffResponse.json() as CommitDiff).after).not.toBeNull();
    } finally { store.db.close(); }
  });
});
