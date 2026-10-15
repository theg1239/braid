import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommitDetail } from '../../shared/history';
import { recordedExample } from '../changes/demo';
import { commitDiffRequest, commitRequest, recordedCommit, recordedCommitDiff } from './commit';
import type { BraidEnv } from '../env';
import { COMMIT_PREFIX_LIMIT, commitFromPrefix, resolveRepositoryCommit } from './history';
import { seedWorkspace } from '../workspace/seed';
import { startGitServer } from '../test/git-server';
import { storageFixture } from '../test/storage';
import { Workspace } from '../workspace/workspace';

const metadata = (hash: string, parents: string[] = []): ArtifactsCommitMetadata => ({ hash, parents, treeHash: 'a'.repeat(40), message: 'Commit', author: { name: 'Maya', email: 'maya@example.test' }, committer: { name: 'Maya', email: 'maya@example.test' }, authoredAt: 1, committedAt: 1 });
const hashAt = (index: number) => index.toString(16).padStart(8, '0') + 'a'.repeat(32);

describe('abbreviated commit boundaries and resolution', () => {
  it.each([7, 8, 20, 39, 40])('accepts and normalizes %i hex characters in both queries', length => {
    const sha = 'ABCDEF01'.repeat(5).slice(0, length);
    expect(commitRequest(new URLSearchParams({ sha }))).toEqual({ sha: sha.toLowerCase() });
    expect(commitDiffRequest(new URLSearchParams({ sha, path: 'src/main.ts' }))).toEqual({ sha: sha.toLowerCase(), path: 'src/main.ts' });
  });

  it.each(['', 'abcdef', 'a'.repeat(41), 'main', 'abcdeg1', 'abcdef1~1', ' abcdef1'])('rejects %j in both queries', sha => {
    for (const read of [commitRequest, commitDiffRequest]) expect(() => read(new URLSearchParams({ sha, path: 'src/main.ts' }))).toThrow();
  });

  it('uses the default branch, then immutable parent cursors, up to 2,000 commits', async () => {
    const commits = Array.from({ length: COMMIT_PREFIX_LIMIT + 1 }, (_, index) => metadata(hashAt(index), [hashAt(index + 1)]));
    const log = vi.fn(async ({ ref, limit }: { ref?: string; limit?: number }) => {
      const start = ref === 'trunk' ? 0 : commits.findIndex(commit => commit.hash === ref);
      return start < 0 ? [] : commits.slice(start, start + limit!);
    });
    expect(await resolveRepositoryCommit({ log }, hashAt(1_999).slice(0, 8), 'trunk')).toBe(hashAt(1_999));
    expect(log.mock.calls).toEqual([[{ ref: 'trunk', limit: 1_000 }], [{ ref: hashAt(1_000), limit: 1_000 }]]);
    log.mockClear();
    await expect(resolveRepositoryCommit({ log }, hashAt(2_000).slice(0, 8), 'trunk')).rejects.toMatchObject({ status: 404 });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('checks later pages for ambiguity instead of returning the first match', async () => {
    const first = 'abcdef1' + 'a'.repeat(33), second = 'abcdef1' + 'b'.repeat(33);
    const log = vi.fn().mockResolvedValueOnce([metadata(first, [second])]).mockResolvedValueOnce([metadata(second)]);
    await expect(resolveRepositoryCommit({ log }, 'abcdef1', 'main')).rejects.toMatchObject({ status: 409, message: 'Commit hash is ambiguous. Use a longer hash.' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(commitFromPrefix(first.slice(0, 8), [first, first, second])).toBe(first);
  });

  it('does not walk history for a full hash and reports unknown prefixes as 404', async () => {
    const log = vi.fn(async () => []);
    expect(await resolveRepositoryCommit({ log }, hashAt(1), 'main')).toBe(hashAt(1));
    expect(log).not.toHaveBeenCalled();
    await expect(resolveRepositoryCommit({ log }, 'abcdef1', 'main')).rejects.toMatchObject({ status: 404 });
  });

  it('resolves other branch tips and second-parent history, and checks ambiguity across branches', async () => {
    const root = metadata(hashAt(1)), side = metadata('abcdef1' + 'a'.repeat(33), [root.hash]);
    const feature = metadata(hashAt(2), [root.hash, side.hash]);
    const log = vi.fn(async ({ ref }: { ref?: string }) => ref === 'main' ? [root] : ref === 'feature' ? [feature, root] : ref === side.hash ? [side, root] : []);
    expect(await resolveRepositoryCommit({ log }, side.hash.slice(0, 7), 'main', ['main', 'feature'])).toBe(side.hash);
    expect(log.mock.calls.map(([query]) => query.ref)).toEqual(['main', 'feature', side.hash]);
    const collision = metadata('abcdef1' + 'b'.repeat(33));
    await expect(resolveRepositoryCommit({ log: async ({ ref } = {}) => ref === 'main' ? [side] : [collision] }, 'abcdef1', 'main', ['feature'])).rejects.toMatchObject({ status: 409 });
  });
});

describe('abbreviated commits through Workspace', () => {
  let git: Awaited<ReturnType<typeof startGitServer>>;
  let root: string, head: string;
  beforeAll(async () => {
    git = await startGitServer();
    root = git.commitTree({ 'README.md': '# Imported repository\n' });
    head = git.commitTree({ 'README.md': '# Imported repository\nA change.\n' }, root);
    git.native(['update-ref', 'refs/heads/trunk', head]);
  });
  afterAll(async () => { await git?.close(); });

  async function fixture(mode: 'live' | 'demo', log = git.repository.log) {
    const store = storageFixture();
    if (mode === 'live') {
      const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
      seed.project = { ...seed.project, id: 'imported', head, branch: 'trunk' };
      await store.storage.put('workspace', seed);
    }
    const env = { ARTIFACTS: { get: async () => ({ ...git.repository, log, [Symbol.dispose]() {} }) }, TRUNKS: { getByName: () => ({ provenance: async () => [] }) } } as unknown as BraidEnv;
    const workspace = new Workspace(store.ctx, env);
    await store.ready();
    const request = (suffix: string) => workspace.fetch(new Request(`https://braid.test/api/repository/commit${suffix}`, { headers: { 'x-braid-mode': mode, 'x-braid-repository': 'test', 'x-braid-public': 'true' } }));
    return { request, close: () => store.db.close() };
  }

  it('resolves live prefixes before reading metadata or a diff, including older commits', async () => {
    const test = await fixture('live');
    try {
      for (const hash of [root, head]) {
        const response = await test.request(`?sha=${hash.slice(0, 7).toUpperCase()}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ hash });
      }
      const response = await test.request(`/diff?sha=${head.slice(0, 7)}&path=README.md`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ before: '# Imported repository\n', after: '# Imported repository\nA change.\n' });
      for (const suffix of ['', '/diff']) expect((await test.request(`${suffix}?sha=0000000&path=README.md`)).status).toBe(404);
    } finally { test.close(); }
  });

  it('returns 409 for ambiguous prefixes on both live endpoints', async () => {
    const log = vi.fn(async () => [metadata('abcdef1' + 'a'.repeat(33)), metadata('abcdef1' + 'b'.repeat(33))]);
    const test = await fixture('live', log);
    try {
      for (const suffix of ['', '/diff']) {
        const response = await test.request(`${suffix}?sha=abcdef1&path=README.md`);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'Commit hash is ambiguous. Use a longer hash.' });
      }
    } finally { test.close(); }
  });

  it('opens a recorded short commit link and its diff with canonical hashes', async () => {
    const test = await fixture('demo');
    try {
      const hash = (await recordedExample()).change('23').landedCommit!, prefix = hash.slice(0, 7);
      const response = await test.request(`?sha=${prefix}`);
      expect(response.status).toBe(200);
      const detail = await response.json() as CommitDetail;
      expect(detail.hash).toBe(hash);
      expect((await test.request(`/diff?sha=${prefix}&path=${encodeURIComponent(detail.files[0].path)}`)).status).toBe(200);
      for (const suffix of ['', '/diff']) expect((await test.request(`${suffix}?sha=0000000&path=README.md`)).status).toBe(404);
    } finally { test.close(); }
  });

  it('rejects ambiguous recorded prefixes in both detail and diff without inventing a landing', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [], since: Date.now() };
    const page = example.changes({ statuses: ['landed'], limit: 1000 }, state);
    const collision = Object.create(example) as typeof example;
    collision.changes = () => ({ ...page, items: page.items.slice(0, 2).map((change, index) => ({ ...change, landedCommit: 'abcdef1' + String(index).repeat(33) })) });
    expect(() => recordedCommit(collision, state, 'abcdef1')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => recordedCommitDiff(collision, state, 'abcdef1', 'README.md')).toThrow(expect.objectContaining({ status: 409 }));
  });
});
