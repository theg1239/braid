import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatNote, NOTES_REF } from '../../shared/provenance';
import type { Provenance } from '../../shared/types';
import { recordedExample } from '../changes/demo';
import { publicPathAllowed, agentPathAllowed } from '../http/agent-auth';
import { publicResponse } from '../http/public-view';
import { HISTORY_SCAN_LIMIT, historyRequest, recordedHistory, repositoryHistory } from './history';
import { startGitServer } from '../test/git-server';
import { Workspace } from '../workspace/workspace';
import { storageFixture } from '../test/storage';
import { seedWorkspace } from '../workspace/seed';
import type { BraidEnv } from '../env';

let git: Awaited<ReturnType<typeof startGitServer>>;
let root: string, head: string, deletion: string, sparse: string, modeChange: string;
const commits: string[] = [];
const query = (values: Record<string, string> = {}) => historyRequest(new URLSearchParams(values), 'main');

beforeAll(async () => {
  git = await startGitServer();
  root = git.commitTree({ 'README.md': '# Relay\n', 'src/delivery.ts': 'export const retries = 0;\n', 'src/old.ts': 'old\n' }, undefined, 'Start Relay', { name: 'Maya Chen', email: 'maya@example.test' });
  head = root;
  commits.push(root);
  for (let i = 1; i <= 65; i++) {
    head = git.commitTree({ 'src/delivery.ts': `export const retries = ${i};\n` }, head, `Limit retries to ${i}\n\nPreserve the commit message.`, { name: 'Maya Chen', email: '12+maya-chen@users.noreply.github.com' });
    commits.push(head);
  }
  git.native(['update-ref', 'refs/heads/main', head]);
  deletion = git.commitTree({ 'src/old.ts': null, 'src/new.ts': 'old\n' }, root, 'Rename the old module');
  git.native(['update-ref', 'refs/heads/feature/rename', deletion]);
  sparse = root;
  for (let i = 0; i < HISTORY_SCAN_LIMIT + 5; i++) sparse = git.commitTree({ 'README.md': `# Relay ${i}\n` }, sparse, `Update documentation ${i}`);
  git.native(['update-ref', 'refs/heads/docs', sparse]);
  const tree = git.native(['rev-parse', `${root}:src`]).trim();
  const entry = git.native(['ls-tree', tree]).replace('100644 blob', '100755 blob');
  const changed = git.native(['mktree'], entry).trim();
  const rootTree = git.native(['ls-tree', `${root}^{tree}`]).replace(tree, changed);
  modeChange = git.native(['commit-tree', git.native(['mktree'], rootTree).trim(), '-p', root], 'Make delivery executable\n').trim();
  const note = formatNote({ v: 1, agent: { name: 'Legacy name', model: 'claude-opus-5-5' }, owner: { name: 'Maya Chen', github: 'maya-chen' }, change: { id: 'ch_0123456789abc', number: 7, revision: 1 } });
  const notes = git.commitTree({
    [`${head.slice(0, 2)}/${head.slice(2)}`]: note,
    [root]: formatNote({ v: 1, owner: { name: 'Maya Chen' } }),
    [`${deletion.slice(0, 2)}/${deletion.slice(2, 4)}/${deletion.slice(4)}`]: note,
    [commits[64]]: '{broken',
  });
  git.native(['update-ref', NOTES_REF, notes]);
}, 60_000);
afterAll(async () => { await git?.close(); });

describe('repository history against Git', () => {
  it('pages all commits once, with 30 rows and a pinned head while the branch moves', async () => {
    const first = await repositoryHistory(git.repository, query());
    expect(first.items).toHaveLength(30);
    expect(first.items[0]).toMatchObject({ hash: head, title: 'Limit retries to 65' });
    const advanced = git.commitTree({ 'later.txt': 'new\n' }, head, 'Land while reading');
    git.native(['update-ref', 'refs/heads/main', advanced]);
    try {
      const second = await repositoryHistory(git.repository, query({ cursor: first.nextCursor! }));
      const third = await repositoryHistory(git.repository, query({ cursor: second.nextCursor! }));
      expect(second.ref).toBe(head);
      expect(third.nextCursor).toBeNull();
      expect([...first.items, ...second.items, ...third.items].map(item => item.hash)).toEqual([...commits].reverse());
    } finally { git.native(['update-ref', 'refs/heads/main', head]); }
  });

  it('reads fan-out and flat notes, model names and owners, and falls back to the Git author for malformed notes', async () => {
    const page = await repositoryHistory(git.repository, query());
    expect(page.items[0]).toMatchObject({ author: { kind: 'agent', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', owner: { name: 'Maya Chen', github: 'maya-chen' } }, pullRequest: 7 });
    expect(page.items[1]).toMatchObject({ author: { kind: 'human', name: 'Maya Chen' } });
    expect(page.items[1].pullRequest).toBeUndefined();
    const nested = await repositoryHistory(git.repository, query({ ref: 'feature/rename' }));
    expect(nested.items.map(item => item.hash)).toEqual([deletion, root]);
    expect(nested.items[0].author.model).toBe('claude-opus-5-5');
    expect(nested.items[1].author).toMatchObject({ kind: 'human', name: 'Maya Chen' });
    expect(JSON.stringify(page)).not.toContain('users.noreply.github.com');
  });

  it('names a person whose Git name is an email address without showing the address', async () => {
    const named = git.commitTree({ 'email.txt': 'named\n' }, root, 'Named by address', { name: 'maya@example.test', email: 'maya@example.test' });
    const [item] = (await repositoryHistory(git.repository, query({ ref: named }))).items;
    expect(item.author).toMatchObject({ kind: 'human', name: 'maya', owner: { name: 'maya' } });
    expect(JSON.stringify(item)).not.toContain('@example.test');
  });

  it('uses one indexed provenance lookup for the page and trusts the landing record over the note', async () => {
    const known = vi.fn(async (ids: string[]): Promise<Provenance[]> => ids.map(commit => ({ commit, at: '2026-10-12T12:00:00Z', subject: 'Recorded title', kind: 'agent', agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' }, owner: { name: 'Ishaan', github: 'theg1239' }, change: { id: 'ch_0123456789abc', number: 99 }, confidence: 'braid' })));
    const repo = { ...git.repository, log: vi.fn(git.repository.log) };
    const page = await repositoryHistory(repo, query(), known);
    expect(known).toHaveBeenCalledTimes(1);
    expect(known.mock.calls[0][0]).toHaveLength(30);
    expect(page.items[0]).toMatchObject({ title: 'Limit retries to 65', author: { name: 'GPT-6.1 Sol', owner: { github: 'theg1239' } }, pullRequest: 99 });
    expect(repo.log).toHaveBeenCalledTimes(1);
  });

  it('filters files and directories, includes creation and deletion, and excludes unchanged paths', async () => {
    const repo = { ...git.repository, readBlob: vi.fn(git.repository.readBlob) };
    expect((await repositoryHistory(repo, query({ path: 'README.md' }))).items.map(item => item.hash)).toEqual([root]);
    expect((await repositoryHistory(repo, query({ path: 'src' }))).items).toHaveLength(30);
    expect((await repositoryHistory(repo, query({ ref: 'feature/rename', path: 'src/old.ts' }))).items.map(item => item.hash)).toEqual([deletion, root]);
    expect((await repositoryHistory(repo, query({ ref: 'feature/rename', path: 'src/new.ts' }))).items.map(item => item.hash)).toEqual([deletion]);
    expect((await repositoryHistory(repo, query({ path: 'missing.ts' })))).toMatchObject({ items: [], nextCursor: null });
    expect(repo.readBlob.mock.calls.every(([hash]) => ![root, head].includes(hash))).toBe(true);
  });

  it('includes mode-only changes and does not follow the second parent of a merge', async () => {
    expect((await repositoryHistory(git.repository, query({ ref: modeChange, path: 'src/delivery.ts' }))).items.map(item => item.hash)).toEqual([modeChange, root]);
    const merge = git.native(['commit-tree', git.native(['rev-parse', `${head}^{tree}`]).trim(), '-p', head, '-p', deletion], 'Merge the feature\n').trim();
    const page = await repositoryHistory(git.repository, query({ ref: merge, path: 'src/old.ts' }));
    expect(page.items.map(item => item.hash)).toEqual([root]);
  });

  it('bounds a sparse path scan and resumes without skipping its older matches', async () => {
    const repo = { ...git.repository, log: vi.fn(git.repository.log), readTree: vi.fn(git.repository.readTree) };
    const first = await repositoryHistory(repo, query({ ref: 'docs', path: 'src/delivery.ts' }));
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(repo.log).toHaveBeenCalledWith({ ref: 'docs', limit: HISTORY_SCAN_LIMIT + 1 });
    expect(repo.readTree.mock.calls.length).toBeLessThanOrEqual(HISTORY_SCAN_LIMIT + 2);
    const second = await repositoryHistory(repo, query({ ref: 'docs', path: 'src/delivery.ts', cursor: first.nextCursor! }));
    expect(second.items.map(item => item.hash)).toEqual([root]);
    expect(second.nextCursor).toBeNull();
    expect(repo.log.mock.calls[1][0].offset).toBeUndefined();
  });

  it('rejects malformed cursors, unsafe paths and cursors reused with a different path or branch', async () => {
    for (const cursor of ['bad', btoa('{}'), 'x'.repeat(24_001)]) expect(() => query({ cursor })).toThrow();
    for (const path of ['../README.md', '.git/config', 'src//delivery.ts', 'a\\b', 'a\0b']) expect(() => query({ path })).toThrow('path');
    const page = await repositoryHistory(git.repository, query());
    expect(() => query({ path: 'README.md', cursor: page.nextCursor! })).toThrow('another branch or path');
    expect(() => query({ ref: 'docs', cursor: page.nextCursor! })).toThrow('another branch or path');
    await expect(repositoryHistory(git.repository, query({ ref: 'missing' }))).rejects.toThrow('Repository revision not found');
  });

  it('continues a maximum-length Unicode path without exceeding the cursor limit', async () => {
    const input = { ref: 'docs', path: '界'.repeat(4096) };
    const first = await repositoryHistory(git.repository, query(input));
    expect(first.nextCursor!.length).toBeLessThan(24_000);
    const second = await repositoryHistory(git.repository, query({ ...input, cursor: first.nextCursor! }));
    expect(second).toMatchObject({ path: input.path, items: [], nextCursor: null });
  });

  it('ends at shallow history when its parent is unavailable', async () => {
    const tip = (await git.repository.readCommit(head))!;
    const repo = { ...git.repository, log: vi.fn(async ({ ref }: { ref?: string }) => ref === NOTES_REF ? [] : [tip]), readCommit: vi.fn(async () => null) };
    expect(await repositoryHistory(repo, query({ path: 'src/delivery.ts' }))).toMatchObject({ items: [{ hash: head }], nextCursor: null });
    expect(repo.readCommit).toHaveBeenCalledTimes(1);
  });

  it('serves the live Workspace endpoint with cached landing provenance and validates queries before reading Git', async () => {
    const store = storageFixture();
    const provenance = vi.fn(async () => []);
    const repo = { ...git.repository, [Symbol.dispose]: vi.fn() };
    const get = vi.fn(async () => repo);
    const env = { ARTIFACTS: { get }, TRUNKS: { getByName: () => ({ provenance, notesHead: async () => git.native(['rev-parse', NOTES_REF]).trim() }) } } as unknown as BraidEnv;
    const seed = seedWorkspace('live', { mode: 'live', canWrite: false, artifacts: true, ai: false, authenticated: true, storage: 'durable-object', model: 'test', namespace: 'test' });
    seed.project = { ...seed.project, id: 'project', head, branch: 'main' };
    await store.storage.put('workspace', seed);
    const workspace = new Workspace(store.ctx, env);
    await store.ready();
    const request = (params = '') => workspace.fetch(new Request(`https://braid.test/api/repository/commits${params}`, { headers: { 'x-braid-mode': 'live', 'x-braid-repository': 'test', 'x-braid-public': 'true' } }));
    try {
      expect((await request('?path=../README.md')).status).toBe(400);
      expect(get).not.toHaveBeenCalled();
      const response = await request('?path=src/delivery.ts');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ref: head, path: 'src/delivery.ts', items: expect.arrayContaining([expect.objectContaining({ hash: head, pullRequest: 7 })]) });
      expect(provenance).toHaveBeenCalledWith('test', expect.any(Array), true);
      expect(repo[Symbol.dispose]).toHaveBeenCalledOnce();
    } finally { store.db.close(); }
  });
});

describe('recorded history and public reads', () => {
  it('shows the recording’s landings and only pull requests that changed a filtered path', async () => {
    const example = await recordedExample(), state = { decisions: {}, changes: [], since: Date.parse('2026-10-12T12:00:00Z') };
    const page = recordedHistory(example, state, query());
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      const change = example.change(String(item.pullRequest), state);
      expect(item).toMatchObject({ hash: change.landedCommit, title: change.title, author: change.author, at: change.landedAt });
    }
    const filtered = recordedHistory(example, state, query({ path: 'src' }));
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every(item => example.change(String(item.pullRequest), state).files.some(file => file.path.startsWith('src/')))).toBe(true);
    expect(recordedHistory(example, state, query({ path: 'not-present' })).items).toEqual([]);
    const pinned = recordedHistory(example, state, query({ ref: page.items[1].hash, path: 'not-present' }));
    expect(pinned).toMatchObject({ ref: page.items[1].hash, items: [] });
    const all = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const older = recordedHistory(example, state, query({ cursor }));
      all.push(...older.items);
      cursor = older.nextCursor;
    }
    expect(new Set(all.map(item => item.hash)).size).toBe(all.length);
    expect(all.length).toBe(example.changes({ statuses: ['landed'], limit: 1000 }, state).items.length);
  });

  it('allows read-only history while redacting private emails from its metadata and subject', async () => {
    const path = '/api/repository/commits';
    expect(publicPathAllowed(path, 'GET')).toBe(true);
    expect(publicPathAllowed(path, 'HEAD')).toBe(true);
    expect(publicPathAllowed(path, 'POST')).toBe(false);
    expect(agentPathAllowed(path, 'GET', 'read')).toBe(true);
    const response = await publicResponse(Response.json({ items: [{ title: 'Document support@example.test', author: { name: 'Maya', owner: { name: 'Maya', email: 'maya@example.test' } } }] }), path);
    expect(await response.json()).toEqual({ items: [{ title: 'Document [private email]', author: { name: 'Maya', owner: { name: 'Maya' } } }] });
  });
});
