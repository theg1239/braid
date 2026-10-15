import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import { Trunk } from './trunk';
import { BlameQueue, BLAME_WARM_FILES, BLAME_WARM_HOURLY, PUBLIC_BLAME_HOURLY, PUBLIC_BLAME_PENDING } from './blame-queue';
import { blameWarmPaths } from './blame-warm';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const context = (trunk: Trunk) => (trunk as unknown as { ctx: DurableObjectState }).ctx;
const jobs = (trunk: Trunk) => context(trunk).storage.sql.exec<{ path: string; warm: number }>('SELECT path, warm FROM blame_queue').toArray();
async function fixture() { const f = await publicRepository(); cleanup.push(f.close); return f; }
async function alarm(trunk: Trunk) { await context(trunk).storage.deleteAlarm(); await trunk.alarm(); }

describe('ahead-of-view blame', () => {
  it('selects README and the most recently changed top-level source, capped at eight', async () => {
    const f = await fixture();
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/file${i}.ts`, `export const n = ${i};\n`]));
    const old = f.h.git.commitTree({ ...files, 'node_modules/vendor.ts': 'ignored', 'src/deep/file.ts': 'ignored', 'package-lock.json': '{}', 'image.bin': '\0binary', 'old.go': 'package old' }, f.base);
    const middle = f.h.git.commitTree({ 'src/z-new.ts': 'middle\n' }, old);
    const head = f.h.git.commitTree({ 'z-new.py': 'latest\n' }, middle);
    const paths = await blameWarmPaths(f.h.git.repository, head);
    expect(paths.slice(0, 3)).toEqual(['README.md', 'z-new.py', 'src/z-new.ts']);
    expect(paths).toHaveLength(BLAME_WARM_FILES);
    expect(new Set(paths).size).toBe(BLAME_WARM_FILES);
    expect(paths).not.toContain('node_modules/vendor.ts');
    expect(paths).not.toContain('src/deep/file.ts');
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('image.bin');
  });

  it('warms real imported history before the first anonymous view, durably once per commit', async () => {
    const f = await fixture();
    const root = f.h.git.commitTree({ 'README.md': 'one\ntwo\nthree\n' }, f.base);
    const head = f.h.git.commitTree({ 'README.md': 'one\nTWO\nthree\n' }, root);
    f.h.git.native(['update-ref', 'refs/heads/main', head]);
    await Promise.all(Array.from({ length: 20 }, () => f.h.trunk.warmBlame(f.h.repository, head)));
    expect(f.h.workspace.repository).toHaveBeenCalledTimes(1);
    expect(jobs(f.h.trunk)).toEqual(expect.arrayContaining([{ path: 'README.md', warm: 1 }]));
    const reopened = new Trunk(context(f.h.trunk), f.h.env);
    await reopened.warmBlame(f.h.repository, head);
    expect(f.h.workspace.repository).toHaveBeenCalledTimes(1);
    await alarm(reopened);
    f.h.artifacts.get.mockClear();
    const first = await reopened.blame(f.h.repository, 'README.md', head, true);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.ranges.map(range => range.provenance.commit)).toEqual([root, head, root]);
    expect(first.data.pending).toBeUndefined();
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    await reopened.warmBlame(f.h.repository, head);
    expect(jobs(reopened)).toHaveLength(0);
  });

  it('works for an authorized private import without enabling anonymous builds', async () => {
    const f = await fixture();
    f.db.db.prepare("UPDATE workspaces SET visibility = 'private'").run();
    await f.h.trunk.warmBlame(f.h.repository, f.base);
    expect(jobs(f.h.trunk).length).toBeGreaterThan(0);
    await alarm(f.h.trunk);
    expect(jobs(f.h.trunk)).toHaveLength(0);
    expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(404);
    const member = await f.h.trunk.blame(f.h.repository, 'README.md');
    expect(member.ok && member.data.pending).toBeUndefined();
  });

  it('never expands an anonymous file request into speculative work or bypasses its network limit', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await f.h.trunk.blame(f.h.repository, `file-${i}.ts`, undefined, true, 'one-network')).ok).toBe(true);
    expect(await f.h.trunk.blame(f.h.repository, 'overflow.ts', undefined, true, 'one-network')).toMatchObject({ ok: false, status: 503 });
    expect(jobs(f.h.trunk)).toHaveLength(10);
    expect(jobs(f.h.trunk).every(job => !job.warm)).toBe(true);
    expect(context(f.h.trunk).storage.sql.exec('SELECT head FROM blame_warmed').toArray()).toEqual([]);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
  });

  it('resolves the configured default branch instead of warming an arbitrary revision', async () => {
    const f = await fixture();
    const other = f.h.git.commitTree({ 'private.ts': 'other revision\n' }, f.base);
    await f.h.trunk.warmBlame(f.h.repository, other);
    expect(jobs(f.h.trunk)).toHaveLength(0);
    expect(await context(f.h.trunk).storage.getAlarm()).toBeNull();
  });

  it('promotes a requested warm file after the speculative allowance runs out, charging the visitor once', async () => {
    const f = await fixture();
    await f.h.trunk.warmBlame(f.h.repository, f.base);
    const sql = context(f.h.trunk).storage.sql;
    for (let i = 0; i < BLAME_WARM_HOURLY; i++) sql.exec('INSERT INTO blame_starts (started, warm) VALUES (?, 1)', Date.now());
    await alarm(f.h.trunk);
    expect(jobs(f.h.trunk).every(job => job.warm)).toBe(true);
    await Promise.all(Array.from({ length: 20 }, () => f.h.trunk.blame(f.h.repository, 'README.md', undefined, true, 'visitor')));
    expect(jobs(f.h.trunk)).toContainEqual({ path: 'README.md', warm: 0 });
    expect(JSON.parse(sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'public-build-budget'").one().value).used).toBe(1);
    await alarm(f.h.trunk);
    const result = await f.h.trunk.blame(f.h.repository, 'README.md', undefined, true, 'visitor');
    expect(result.ok && result.data.pending).toBeUndefined();
    expect(result.ok && result.data.ranges).toHaveLength(1);
    expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame_starts').one().count).toBe(BLAME_WARM_HOURLY + 1);
    expect(jobs(f.h.trunk)).toEqual([{ path: 'src/router.ts', warm: 1 }]);
  });

  it('cannot use promotion to bypass a visitor network budget', async () => {
    const f = await fixture();
    await f.h.trunk.warmBlame(f.h.repository, f.base);
    for (let i = 0; i < 10; i++) await f.h.trunk.blame(f.h.repository, `request-${i}.ts`, undefined, true, 'visitor');
    expect(await f.h.trunk.blame(f.h.repository, 'README.md', undefined, true, 'visitor')).toMatchObject({ ok: false, status: 503 });
    expect(jobs(f.h.trunk)).toContainEqual({ path: 'README.md', warm: 1 });
    expect((await f.h.trunk.blame(f.h.repository, 'README.md', undefined, true, 'another-visitor')).ok).toBe(true);
    expect(jobs(f.h.trunk)).toContainEqual({ path: 'README.md', warm: 0 });
    expect(jobs(f.h.trunk)).toHaveLength(12);
  });
});

describe('warming shares the blame budget', () => {
  function fixtureQueue() {
    const f = storageFixture(); cleanup.push(() => f.db.close());
    return { ...f, queue: new BlameQueue(f.storage) };
  }
  const paths = Array.from({ length: 20 }, (_, i) => `file-${i}.ts`);

  it('promotes in place even when the queue is full and keeps the existing attempt and lease', () => {
    const f = fixtureQueue();
    f.queue.warm(['README.md']);
    expect(f.queue.take()).toEqual([{ path: 'README.md', attempts: 1, warm: 1 }]);
    const due = f.db.prepare('SELECT due FROM blame_queue').get()!.due;
    for (let i = 1; i < PUBLIC_BLAME_PENDING; i++) f.queue.enqueue(`request-${i}.ts`);
    f.queue.enqueue('README.md');
    expect(f.db.prepare('SELECT attempts, due, warm FROM blame_queue WHERE path = ?').get('README.md')).toEqual({ attempts: 1, due, warm: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blame_queue').get()!.n).toBe(PUBLIC_BLAME_PENDING);
    expect(f.queue.take().map(job => job.path)).not.toContain('README.md');
  });

  it('retains deduplication after eviction and after the rolling-hour discovery allowance resets', () => {
    const f = fixtureQueue(); let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
    expect(f.queue.claimWarm('one')).toBe(true);
    expect(new BlameQueue(f.storage).claimWarm('one')).toBe(false);
    expect(f.queue.claimWarm('two')).toBe(true);
    expect(f.queue.claimWarm('three')).toBe(false);
    time += 3_600_000;
    expect(new BlameQueue(f.storage).claimWarm('one')).toBe(false);
    expect(f.queue.claimWarm('three')).toBe(true);
  });

  it('caps warm pending work at eight, reserves twenty queue places and prioritizes requested files', () => {
    const f = fixtureQueue();
    f.queue.warm(paths); f.queue.warm(paths.slice(8));
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blame_queue').get()!.n).toBe(8);
    for (let i = 0; i < 22; i++) { expect(f.queue.full()).toBe(false); f.queue.enqueue(`request-${i}`); }
    expect(f.queue.full()).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blame_queue').get()!.n).toBe(PUBLIC_BLAME_PENDING);
    expect(f.queue.take().every(job => !job.warm)).toBe(true);
    f.db.exec('DELETE FROM blame_queue');
    for (let i = 0; i < 10; i++) f.queue.enqueue(`requested-${i}`);
    expect(f.queue.claimWarm('busy-head')).toBe(false);
    f.queue.warm(paths);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blame_queue').get()!.n).toBe(10);
  });

  it('charges warm retries to both limits and leaves forty-four starts for requested files', () => {
    const f = fixtureQueue(); let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
    f.queue.warm(paths);
    for (let i = 0; i < BLAME_WARM_HOURLY / 2; i++) {
      const batch = f.queue.take(); expect(batch).toHaveLength(2);
      for (const job of batch) f.queue.failed(job);
      time += 10_000;
    }
    const reopened = new BlameQueue(f.storage);
    expect(reopened.take()).toEqual([]);
    expect(reopened.next()).toBeGreaterThan(time);
    for (let i = 0; i < PUBLIC_BLAME_HOURLY - BLAME_WARM_HOURLY; i += 2) {
      reopened.enqueue(`wanted-${i}`); reopened.enqueue(`wanted-${i + 1}`);
      const batch = reopened.take(); expect(batch).toHaveLength(2);
      expect(batch.every(job => !job.warm)).toBe(true);
      for (const job of batch) reopened.done(job.path);
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blame_starts').get()!.n).toBe(PUBLIC_BLAME_HOURLY);
    expect(reopened.take()).toEqual([]);
  });

  it('shares the sixty-start ceiling even when requested jobs spent it first', () => {
    const f = fixtureQueue();
    for (let i = 0; i < PUBLIC_BLAME_HOURLY; i++) f.storage.sql.exec('INSERT INTO blame_starts (started) VALUES (?)', Date.now());
    f.queue.warm(paths);
    expect(f.queue.take()).toEqual([]);
    expect(f.queue.next()).toBeGreaterThan(Date.now());
  });

  it('migrates existing queues without losing their leases or hourly charges', () => {
    const f = storageFixture(); cleanup.push(() => f.db.close());
    f.db.exec('CREATE TABLE blame_queue (path TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE blame_starts (started INTEGER NOT NULL)');
    f.db.prepare('INSERT INTO blame_queue VALUES (?, ?, ?)').run('requested.ts', Date.now() + 60_000, 2);
    f.db.prepare('INSERT INTO blame_starts VALUES (?)').run(Date.now());
    new BlameQueue(f.storage);
    expect(f.db.prepare('SELECT path, attempts, warm FROM blame_queue').get()).toEqual({ path: 'requested.ts', attempts: 2, warm: 0 });
    expect(f.db.prepare('SELECT warm FROM blame_starts').get()).toEqual({ warm: 0 });
  });
});
