import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startGitServer } from '../test/git-server';
import { storageFixture } from '../test/storage';
import { changeHarness } from '../test/changes-harness';
import type { BraidEnv } from '../env';
import type { FileBlame } from '../../shared/types';
import { historyBlame, BLAME_REQUEST_MS, BLAME_SEED_VERSION } from './history-blame';
import { Trunk } from './trunk';

type Git = Awaited<ReturnType<typeof startGitServer>>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const owners = (blame: FileBlame) => blame.ranges.flatMap(range => Array<string>(range.lines).fill(range.provenance.commit));
const nativeBlame = (git: Git, head: string, path: string) => git.native(['blame', '--first-parent', '--line-porcelain', head, '--', path])
  .split('\n').flatMap(line => /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line)?.[1] ?? []);
async function fixture() {
  const git = await startGitServer();
  cleanup.push(git.close);
  return git;
}
function trunkFixture(git: Git) {
  const store = storageFixture();
  const capabilities: { disposed: boolean }[] = [];
  const env = {
    ARTIFACTS: { get: vi.fn(async () => {
      const capability = { disposed: false }; capabilities.push(capability);
      return {
        ...git.repository,
        readBlob: async (hash: string) => { const result = await git.repository.readBlob(hash); expect(capability.disposed).toBe(false); return result; },
        [Symbol.dispose]() { capability.disposed = true; },
      };
    }) },
    WORKSPACES: { getByName: () => ({ repository: async () => ({ id: 'repo', branch: 'main', remote: git.remote }) }) },
  } as unknown as BraidEnv;
  cleanup.push(async () => { await store.settled(); store.db.close(); });
  const trunk = new Trunk(store.ctx, env);
  const read = async () => ok(await trunk.blame('repo', 'src/file.ts'));
  const seed = () => JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key = 'blame-seed:src/file.ts'").get()!.value as string);
  return { trunk, store, capabilities, read, seed, env };
}

describe('first-parent history blame on real Git objects', () => {
  it('matches Git through insertions, edits, deletions and unchanged commits', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\nfour\n' });
    const changed = git.commitTree({ 'src/file.ts': 'one\nTWO\ninserted\nthree\nfour\n' }, root);
    const unrelated = git.commitTree({ 'README.md': 'An unrelated commit\n' }, changed);
    const head = git.commitTree({ 'src/file.ts': 'one\nTWO\ninserted\nfour!\n' }, unrelated);
    const result = await historyBlame(git.repository, git.repository, head, 'src/file.ts');
    expect(result.lines).toEqual([root, changed, changed, head]);
    expect(result.lines).toEqual(nativeBlame(git, head, 'src/file.ts'));
    expect(result.note).toBeUndefined();
    expect(result.changes).toBe(2);
  });

  it('follows an edited whole-file rename, without attributing a copy to its surviving source', async () => {
    const git = await fixture();
    const text = 'first original line\nsecond original line\nthird original line\nfourth original line\n';
    const root = git.commitTree({ 'old/file.ts': text });
    const renamed = git.commitTree({ 'old/file.ts': null, 'src/file.ts': text.replace('second original', 'second edited') }, root);
    const head = git.commitTree({ 'copy.ts': text.replace('second original', 'second edited') }, renamed);
    const result = await historyBlame(git.repository, git.repository, head, 'src/file.ts');
    expect(result.lines).toEqual([root, renamed, root, root]);
    expect(result.lines).toEqual(nativeBlame(git, head, 'src/file.ts'));
    expect((await historyBlame(git.repository, git.repository, head, 'copy.ts')).lines).toEqual(nativeBlame(git, head, 'copy.ts'));
  });

  it('keeps Git’s final-newline semantics and handles an empty file', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo', 'empty.ts': '' });
    const head = git.commitTree({ 'src/file.ts': 'one\ntwo\n' }, root);
    expect((await historyBlame(git.repository, git.repository, head, 'src/file.ts')).lines).toEqual(nativeBlame(git, head, 'src/file.ts'));
    expect(await historyBlame(git.repository, git.repository, head, 'empty.ts')).toMatchObject({ lines: [], commits: [] });
  });

  it('bounds object reads and keeps the uncertain lines honest', async () => {
    const git = await fixture();
    let head = git.commitTree({ 'src/file.ts': 'old\nkept\n' });
    for (let i = 0; i < 12; i++) head = git.commitTree({ 'src/file.ts': `edit ${i}\nkept\n` }, head);
    const tree = vi.spyOn(git.repository, 'readTree'), blob = vi.spyOn(git.repository, 'readBlob');
    const result = await historyBlame(git.repository, git.repository, head, 'src/file.ts', { reads: 30 });
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every(Boolean)).toBe(true);
    expect(result.note).toContain('history limit reached');
    expect(tree.mock.calls.length + blob.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it('reads independent historical blobs concurrently, at most eight at a time', async () => {
    const git = await fixture();
    let head = git.commitTree({ 'src/file.ts': 'old\nkept\n' });
    for (let i = 0; i < 12; i++) head = git.commitTree({ 'src/file.ts': `edit ${i}\nkept\n` }, head);
    const original = git.repository.readBlob;
    let active = 0, peak = 0;
    vi.spyOn(git.repository, 'readBlob').mockImplementation(async hash => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await original(hash); }
      finally { active--; }
    });
    expect((await historyBlame(git.repository, git.repository, head, 'src/file.ts')).lines).toEqual(nativeBlame(git, head, 'src/file.ts'));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
  });

  it('attributes a merge to the first-parent integration, not its second-parent author', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo\n' });
    const main = git.commitTree({ 'README.md': 'main\n' }, root);
    const branch = git.commitTree({ 'src/file.ts': 'one\nbranch\n' }, root);
    const composed = git.commitTree({ 'src/file.ts': 'one\nbranch\n' }, main);
    const tree = git.native(['rev-parse', `${composed}^{tree}`]).trim();
    const merge = git.native(['commit-tree', tree, '-p', main, '-p', branch], 'Merge the branch\n').trim();
    const result = await historyBlame(git.repository, git.repository, merge, 'src/file.ts');
    expect(result.lines).toEqual([root, merge]);
    expect(result.lines).toEqual(nativeBlame(git, merge, 'src/file.ts'));
  });

  it('keeps known recent lines at a real shallow boundary and notes the older ones', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' });
    const boundary = git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root);
    const head = git.commitTree({ 'src/file.ts': 'one\nTWO\nTHREE\n' }, boundary);
    const rawBoundary = (await git.repository.readCommit(boundary))!;
    writeFileSync(join(git.root, 'repo.git', 'shallow'), boundary + '\n');
    expect(git.native(['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    // Artifacts decodes the raw commit (which still names its parent), and the copy lacks that parent.
    const source = {
      log: async (options: { ref?: string; limit?: number }) => (await git.repository.log(options)).filter(commit => commit.hash !== root).map(commit => commit.hash === boundary ? rawBoundary : commit),
      readCommit: async (hash: string) => hash === root ? null : hash === boundary ? rawBoundary : git.repository.readCommit(hash),
    };
    const result = await historyBlame(source, git.repository, head, 'src/file.ts');
    expect(result.lines).toEqual([boundary, boundary, head]);
    expect(result.note).toBe(`Earlier lines are attributed to ${boundary.slice(0, 7)} (earlier history unavailable).`);
  });

  it('bounds changing commits rather than charging unrelated commits to that limit', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'zero\none\ntwo\nthree\nfour\n' });
    const revisions = [root];
    const lines = ['zero', 'one', 'two', 'three', 'four'];
    let head = root;
    for (let i = 1; i <= 4; i++) {
      lines[i] = `edited ${i}`;
      head = git.commitTree({ 'src/file.ts': lines.join('\n') + '\n' }, head);
      revisions.push(head);
      for (let j = 0; j < 3; j++) head = git.commitTree({ 'README.md': `${i} ${j}\n` }, head);
    }
    const result = await historyBlame(git.repository, git.repository, head, 'src/file.ts', { changes: 2 });
    expect(result.changes).toBe(2);
    expect(result.lines).toEqual([revisions[2], revisions[2], revisions[2], revisions[3], revisions[4]]);
    expect(result.note).toContain('last 2 file changes searched');
    const bounded = await historyBlame(git.repository, git.repository, head, 'src/file.ts', { commits: 2 });
    expect(bounded.note).toContain('history limit reached');
  });

  it('finishes when all surviving lines are attributed and does not walk another page', async () => {
    const git = await fixture();
    let head = git.commitTree({ 'src/file.ts': 'old\n' });
    for (let i = 0; i < 36; i++) head = git.commitTree({ 'README.md': `${i}\n` }, head);
    head = git.commitTree({ 'src/file.ts': 'entirely new\n' }, head);
    const log = vi.spyOn(git.repository, 'log');
    const result = await historyBlame(git.repository, git.repository, head, 'src/file.ts');
    expect(result.lines).toEqual([head]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(result.note).toBeUndefined();
  });
});

describe('persisted history seeds', () => {
  it('reads each contributing commit’s note, co-author and bot author', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' });
    const coauthor = git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root, 'Assisted\n\nCo-authored-by: Claude Opus 4.7 <noreply@anthropic.com>');
    const bot = git.commitTree({ 'src/file.ts': 'one\nTWO\nTHREE\n' }, coauthor, 'Bot edit', { name: 'copilot-swe-agent[bot]', email: 'copilot-swe-agent[bot]@users.noreply.github.com' });
    git.native(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', tool: 'codex/1.8.0', session: 'imported' }, owner: { name: 'Ishaan' } }), root]);
    git.native(['update-ref', 'refs/heads/main', bot]);
    const { read, seed } = trunkFixture(git);
    const result = await read();
    expect(owners(result)).toEqual([root, coauthor, bot]);
    expect(result.ranges.map(range => range.provenance.confidence)).toEqual(['trailers', 'inferred', 'inferred']);
    expect(result.ranges[0].provenance.agent).toMatchObject({ model: 'gpt-6.1-sol', session: 'imported' });
    expect(result.ranges[1].provenance.agent?.name).toBe('Claude Opus 4.7');
    expect(result.ranges[2].provenance.kind).toBe('agent');
    expect(seed()).toMatchObject({ version: BLAME_SEED_VERSION, final: true });
  });

  it('returns a nonfinal coarse view within budget, then persists background work for member and public reads', async () => {
    const git = await fixture();
    const root = git.commitTree({ 'src/file.ts': 'one\ntwo\n' });
    const head = git.commitTree({ 'src/file.ts': 'one\nTWO\n' }, root);
    git.native(['update-ref', 'refs/heads/main', head]);
    const oldBlob = git.native(['rev-parse', `${root}:src/file.ts`]).trim();
    const original = git.repository.readBlob;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(git.repository, 'readBlob').mockImplementation(async hash => { if (hash === oldBlob) { entered(); await waiting; } return original(hash); });
    const { read, seed, store, trunk, capabilities } = trunkFixture(git);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = read();
      await reading;
      await vi.advanceTimersByTimeAsync(BLAME_REQUEST_MS);
      const coarse = await pending;
      expect(coarse.ranges).toHaveLength(1);
      expect(coarse.note).toContain('while history loads');
      expect(seed().final).toBe(false);
      expect(capabilities.map(capability => capability.disposed)).toEqual([true, false]);
      expect(ok(await trunk.blame('repo', 'src/file.ts', undefined, true))).toEqual(coarse);
      release();
      await store.settled();
      expect(capabilities.every(capability => capability.disposed)).toBe(true);
      expect(seed().final).toBe(true);
      const log = vi.spyOn(git.repository, 'log');
      const result = await read();
      expect(owners(result)).toEqual([root, head]);
      expect(result.note).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
      expect(ok(await trunk.blame('repo', 'src/file.ts', undefined, true))).toEqual(result);
    } finally { release(); await store.settled(); }
  });

  it('recomputes a legacy coarse map once while preserving actual landed attribution and fleet counts', async () => {
    const h = await changeHarness();
    cleanup.push(h.close);
    const root = h.git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' });
    const outside = h.git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root);
    h.git.native(['update-ref', 'refs/heads/main', outside]);
    await h.trunk.configure(h.repository, { enabled: true, actor: 'owner' });
    const submitted = ok(await h.submit({ kind: 'agent', id: 'agent:test', name: 'Agent', model: 'gpt-6.1-sol', owner: { id: 'user:owner', name: 'Owner' } },
      { title: 'Add fourth line', summary: 'Adds a line.', baseCommit: outside, files: [{ path: 'src/file.ts', content: 'one\nTWO\nthree\nfour\n' }] }));
    await h.settle();
    const landed = ok(await h.shard(parseInt(submitted.id[3], 16)).get(submitted.id));
    expect(landed.status).toBe('landed');
    const original = ok(await h.trunk.blame(h.repository, 'src/file.ts'));
    const counts = await h.trunk.agentLines(h.repository);
    const sql = (h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const imported = sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', outside).one().id;
    const witness = sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', landed.landedCommit!).one().id;
    // The schema and representation written by the previous lastChange seed, followed by a real landing.
    sql.exec('UPDATE blame SET ranges = ?, base = NULL, note = ? WHERE path = ?', JSON.stringify([[1, 3, imported], [4, 1, witness]]),
      `Lines older than Braid's records are attributed to ${outside.slice(0, 7)}, the last commit that changed this file.`, 'src/file.ts');
    sql.exec("DELETE FROM meta WHERE key = 'blame-seed:src/file.ts'");
    sql.exec('UPDATE commits SET alive = 0 WHERE id != ?', witness);
    sql.exec('UPDATE commits SET alive = 3 WHERE id = ?', imported);
    const log = vi.spyOn(h.git.repository, 'log');
    const publicBefore = ok(await h.trunk.blame(h.repository, 'src/file.ts', undefined, true));
    expect(publicBefore.note).toContain("Lines older than Braid's records");
    expect(log).not.toHaveBeenCalled();
    const result = ok(await h.trunk.blame(h.repository, 'src/file.ts'));
    expect(result).toEqual(original);
    expect(await h.trunk.agentLines(h.repository)).toEqual(counts);
    const calls = log.mock.calls.length;
    expect(ok(await h.trunk.blame(h.repository, 'src/file.ts'))).toEqual(result);
    expect(log).toHaveBeenCalledTimes(calls);
  });

  it('tells a legacy coarse map by its missing seed version, never by the wording of its note', async () => {
    const h = await changeHarness();
    cleanup.push(h.close);
    const root = h.git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' });
    const head = h.git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root);
    h.git.native(['update-ref', 'refs/heads/main', head]);
    const original = ok(await h.trunk.blame(h.repository, 'src/file.ts'));
    expect(owners(original)).toEqual([root, head, root]);
    const sql = (h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const row = sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', head).one().id;
    const coarse = (note: string) => sql.exec('UPDATE blame SET ranges = ?, base = NULL, note = ? WHERE path = ?', JSON.stringify([[1, 3, row]]), note, 'src/file.ts');
    // A map the current seed wrote keeps its note, whatever the note says.
    coarse(`Lines older than Braid's records are attributed to ${head.slice(0, 7)}, the last commit that changed this file.`);
    expect(owners(ok(await h.trunk.blame(h.repository, 'src/file.ts')))).toEqual([head, head, head]);
    // A noted map without a seed version is a legacy one, whatever its note says.
    sql.exec("DELETE FROM meta WHERE key = 'blame-seed:src/file.ts'");
    coarse(`Older lines are attributed to ${head.slice(0, 7)}.`);
    expect(ok(await h.trunk.blame(h.repository, 'src/file.ts'))).toEqual(original);
  });

  it('does not wait for slow provenance notes before returning its temporary view', async () => {
    const git = await fixture();
    const head = git.commitTree({ 'src/file.ts': 'one\ntwo\n' });
    git.native(['update-ref', 'refs/heads/main', head]);
    git.native(['notes', '--ref=braid', 'add', '-m', JSON.stringify({ v: 1, agent: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' } }), head]);
    const original = git.repository.log;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(git.repository, 'log').mockImplementation(async options => {
      if (options.ref === 'refs/notes/braid') { entered(); await waiting; }
      return original(options);
    });
    const { read, store, seed } = trunkFixture(git);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = read();
      await reading;
      await vi.advanceTimersByTimeAsync(BLAME_REQUEST_MS);
      expect((await pending).note).toContain('while history loads');
      expect(seed().final).toBe(false);
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM commits').get()!.count).toBe(0);
      release();
      await store.settled();
      const result = await read();
      expect(result.note).toBeUndefined();
      expect(result.ranges[0].provenance).toMatchObject({ confidence: 'trailers', agent: { model: 'gpt-6.1-sol' } });
    } finally { release(); await store.settled(); }
  });

  it('measures a cold 500-line file across 50 changing commits and a stored second view', async () => {
    const git = await fixture();
    const lines = Array.from({ length: 500 }, (_, i) => `export const value${i} = ${i};`);
    let head = git.commitTree({ 'src/file.ts': lines.join('\n') + '\n' });
    for (let i = 0; i < 50; i++) {
      lines[i * 7] = `export const value${i * 7} = ${i + 1}_000;`;
      head = git.commitTree({ 'src/file.ts': lines.join('\n') + '\n' }, head, `Edit ${i}`);
    }
    git.native(['update-ref', 'refs/heads/main', head]);
    const { read, store } = trunkFixture(git);
    const start = performance.now();
    const first = await read();
    const coldMs = performance.now() - start;
    await store.settled();
    const completedMs = performance.now() - start;
    const secondStart = performance.now();
    const second = await read();
    const cachedMs = performance.now() - secondStart;
    expect(owners(second)).toEqual(nativeBlame(git, head, 'src/file.ts'));
    expect(second.note).toBeUndefined();
    console.log(JSON.stringify({ fixture: '500 lines / 50 changing commits', coldMs: +coldMs.toFixed(2), completedMs: +completedMs.toFixed(2), cachedMs: +cachedMs.toFixed(2), coldFinal: !first.note, ranges: second.ranges.length }));
  }, 60_000);
});
