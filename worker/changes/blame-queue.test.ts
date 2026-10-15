import { afterEach, describe, expect, it, vi } from 'vitest';
import api from '../http/api';
import { publicRepository } from '../test/public-repository';
import { storageFixture } from '../test/storage';
import type { FileBlame } from '../../shared/types';
import { Trunk } from './trunk';
import { BlameQueue, PUBLIC_BLAME_HOURLY, PUBLIC_BLAME_PENDING } from './blame-queue';
import * as history from './history-blame';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.data; };
const commits = (blame: FileBlame) => blame.ranges.flatMap(range => Array<string>(range.lines).fill(range.provenance.commit));
const context = (trunk: Trunk) => (trunk as unknown as { ctx: DurableObjectState }).ctx;
const queued = (trunk: Trunk) => context(trunk).storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame_queue').one().count;
const budget = (trunk: Trunk) => JSON.parse(context(trunk).storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'public-build-budget'").one().value) as { used: number };
async function fixture() { const f = await publicRepository(); cleanup.push(f.close); return f; }
const visit = (f: Awaited<ReturnType<typeof fixture>>, path: string, network = 'network-a') => f.h.trunk.blame(f.h.repository, path, undefined, true, network);
async function alarm(trunk: Trunk) { await context(trunk).storage.deleteAlarm(); await trunk.alarm(); }
function clock() { let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time); return { now: () => time, advance: (ms: number) => { time += ms; } }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('public blame jobs on real Git history', () => {
  it('queues a cold view without Git I/O, survives eviction and serves a final map with landing disabled', async () => {
    const f = await fixture();
    const root = f.h.git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' }, f.base);
    const head = f.h.git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root);
    f.h.git.native(['update-ref', 'refs/heads/main', head]);
    f.h.artifacts.get.mockClear(); f.h.workspace.repository.mockClear();
    const first = await f.anonymous('/api/blame?path=src/file.ts');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ranges: [], note: 'Line history is being prepared.' });
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    expect(f.h.workspace.repository).not.toHaveBeenCalled();
    expect(queued(f.h.trunk)).toBe(1);
    expect(await context(f.h.trunk).storage.getAlarm()).not.toBeNull();
    const reopened = new Trunk(context(f.h.trunk), f.h.env);
    await alarm(reopened);
    const result = ok(await reopened.blame(f.h.repository, 'src/file.ts', undefined, true));
    expect(commits(result)).toEqual([root, head, root]);
    expect(result.note).toBeUndefined();
    expect(queued(reopened)).toBe(0);
    f.h.artifacts.get.mockClear();
    const sql = context(reopened).storage.sql;
    const writes = sql.exec<{ count: number }>('SELECT total_changes() AS count').one().count;
    expect(ok(await reopened.blame(f.h.repository, 'src/file.ts', undefined, true))).toEqual(result);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    expect(sql.exec<{ count: number }>('SELECT total_changes() AS count').one().count).toBe(writes);
  });

  it('upgrades coarse imported ranges from an alarm and keeps witnessed landings and their counts', async () => {
    const f = await fixture();
    const root = f.h.git.commitTree({ 'src/file.ts': 'one\ntwo\nthree\n' }, f.base);
    const imported = f.h.git.commitTree({ 'src/file.ts': 'one\nTWO\nthree\n' }, root);
    f.h.git.native(['update-ref', 'refs/heads/main', imported]);
    await f.h.trunk.configure(f.h.repository, { enabled: true, actor: 'owner' });
    const change = ok(await f.h.submit('sable', { title: 'Add fourth line', summary: 'Adds a line.', baseCommit: imported, files: [{ path: 'src/file.ts', content: 'one\nTWO\nthree\nfour\n' }] }));
    await f.h.settle();
    const landed = ok(await f.h.shard(parseInt(change.id[3], 16)).get(change.id));
    expect(landed.status).toBe('landed');
    const original = ok(await f.h.trunk.blame(f.h.repository, 'src/file.ts'));
    const counts = await f.h.trunk.agentLines(f.h.repository);
    const sql = context(f.h.trunk).storage.sql;
    const importedRow = sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', imported).one().id;
    const witnessed = sql.exec<{ id: number }>('SELECT id FROM commits WHERE sha = ?', landed.landedCommit!).one().id;
    sql.exec('UPDATE blame SET ranges = ?, base = NULL, note = ? WHERE path = ?', JSON.stringify([[1, 3, importedRow], [4, 1, witnessed]]), `Lines older than Braid's records are attributed to ${imported.slice(0, 7)}.`, 'src/file.ts');
    sql.exec("DELETE FROM meta WHERE key = 'blame-seed:src/file.ts'");
    sql.exec('UPDATE commits SET alive = 0 WHERE id != ?', witnessed);
    sql.exec('UPDATE commits SET alive = 3 WHERE id = ?', importedRow);
    f.h.artifacts.get.mockClear();
    const coarse = ok(await visit(f, 'src/file.ts'));
    expect(commits(coarse)).toEqual([imported, imported, imported, landed.landedCommit]);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    await alarm(f.h.trunk);
    expect(ok(await visit(f, 'src/file.ts'))).toEqual(original);
    expect(await f.h.trunk.agentLines(f.h.repository)).toEqual(counts);
    expect(queued(f.h.trunk)).toBe(0);
  });

  it('deduplicates before charging the network budget and caps persisted pending paths at thirty', async () => {
    const f = await fixture(), time = clock();
    await Promise.all(Array.from({ length: 20 }, () => visit(f, 'src/file.ts')));
    expect(queued(f.h.trunk)).toBe(1);
    expect(budget(f.h.trunk).used).toBe(1);
    for (let i = 1; i < PUBLIC_BLAME_PENDING; i++) expect((await visit(f, `docs/${i}.md`, `network-${i}`)).ok).toBe(true);
    expect(queued(f.h.trunk)).toBe(PUBLIC_BLAME_PENDING);
    time.advance(61_000);
    expect(await visit(f, 'overflow.ts', 'fresh-network')).toMatchObject({ ok: false, status: 503, retryAfter: 60 });
    const reopened = new Trunk(context(f.h.trunk), f.h.env);
    expect((await reopened.blame(f.h.repository, 'src/file.ts', undefined, true)).ok).toBe(true);
    expect(queued(reopened)).toBe(PUBLIC_BLAME_PENDING);
    expect(budget(reopened).used).toBe(PUBLIC_BLAME_PENDING);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
  });

  it('retains the ten-build network budget while duplicates remain readable', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await visit(f, `file-${i}.ts`)).ok).toBe(true);
    expect(await visit(f, 'blocked.ts')).toMatchObject({ ok: false, status: 503 });
    expect((await visit(f, 'file-0.ts')).ok).toBe(true);
    expect((await visit(f, 'another-network.ts', 'network-b')).ok).toBe(true);
    expect(queued(f.h.trunk)).toBe(11);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
  });

  it('keeps the anonymous request budget in front of both cached and deduplicated jobs', async () => {
    const f = await fixture();
    for (let i = 0; i < 60; i++) expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(200);
    expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(429);
    expect(queued(f.h.trunk)).toBe(1);
    expect(budget(f.h.trunk).used).toBe(1);
    const env = { ...f.env, ANONYMOUS_LIMITER: { limit: async () => ({ success: false }) } };
    expect((await api.fetch(new Request('https://braid.example/api/blame?path=blocked.ts', { headers: { 'x-braid-workspace': 'w', 'cf-connecting-ip': '203.0.113.9' } }), env)).status).toBe(429);
    expect(queued(f.h.trunk)).toBe(1);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
  });

  it('never enqueues a private repository and cancels pending work after a private flip', async () => {
    const f = await fixture();
    f.db.db.prepare("UPDATE workspaces SET visibility = 'private'").run();
    expect((await f.anonymous('/api/blame?path=README.md')).status).toBe(404);
    expect(await visit(f, 'README.md')).toMatchObject({ ok: false, status: 404 });
    expect(queued(f.h.trunk)).toBe(0);
    expect(await context(f.h.trunk).storage.getAlarm()).toBeNull();
    f.db.db.prepare("UPDATE workspaces SET visibility = 'public'").run();
    expect((await visit(f, 'README.md')).ok).toBe(true);
    expect(queued(f.h.trunk)).toBe(1);
    f.db.db.prepare("UPDATE workspaces SET visibility = 'private'").run();
    await alarm(new Trunk(context(f.h.trunk), f.h.env));
    expect(queued(f.h.trunk)).toBe(0);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
  });

  it('shares two walk slots with members and starts at most two queued files per alarm', async () => {
    const f = await fixture();
    const files = Object.fromEntries(['a', 'b', 'c', 'member'].map(name => [`${name}.ts`, `${name}\n` ]));
    const head = f.h.git.commitTree(files, f.base);
    f.h.git.native(['update-ref', 'refs/heads/main', head]);
    const release = deferred(), entered = deferred(), walk = history.historyBlame;
    let active = 0, maximum = 0, started = 0;
    vi.spyOn(history, 'historyBlame').mockImplementation(async (...args) => {
      started++; active++; maximum = Math.max(maximum, active);
      if (started === 2) entered.resolve();
      try { await release.promise; return await walk(...args); }
      finally { active--; }
    });
    for (const name of ['a', 'b', 'c']) await visit(f, `${name}.ts`);
    const member = f.h.trunk.blame(f.h.repository, 'member.ts');
    const work = alarm(f.h.trunk);
    try {
      await entered.promise;
      expect(started).toBe(2);
      await f.h.trunk.alarm();
      expect(started).toBe(2);
      await visit(f, 'a.ts');
      expect(queued(f.h.trunk)).toBe(3);
    } finally { release.resolve(); await Promise.all([member, work]); }
    expect(maximum).toBe(2);
    expect(started).toBe(3);
    expect(queued(f.h.trunk)).toBe(1);
    await alarm(f.h.trunk);
    expect(started).toBe(4);
    expect(queued(f.h.trunk)).toBe(0);
  });

  it('retries failures durably at most three times and charges every attempt', async () => {
    const f = await fixture(), time = clock();
    vi.spyOn(history, 'historyBlame').mockRejectedValue(new Error('upstream unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await visit(f, 'README.md');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const reopened = new Trunk(context(f.h.trunk), f.h.env);
      await alarm(reopened);
      expect(history.historyBlame).toHaveBeenCalledTimes(attempt);
      expect(context(reopened).storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame_starts').one().count).toBe(attempt);
      if (attempt < 3) {
        const next = await context(reopened).storage.getAlarm();
        expect(next).toBe(time.now() + 5_000 * 2 ** (attempt - 1));
        time.advance(next! - time.now());
      }
    }
    expect(queued(f.h.trunk)).toBe(0);
  });

  it('does not postpone an earlier landing alarm when a visitor enqueues a file', async () => {
    const f = await fixture(), time = clock();
    await context(f.h.trunk).storage.setAlarm(time.now() + 10);
    await visit(f, 'README.md');
    expect(await context(f.h.trunk).storage.getAlarm()).toBe(time.now() + 10);
  });

  it('defers alarm work without upstream reads while the hourly budget is exhausted', async () => {
    const f = await fixture(), time = clock();
    const sql = context(f.h.trunk).storage.sql;
    for (let i = 0; i < PUBLIC_BLAME_HOURLY; i++) sql.exec('INSERT INTO blame_starts (started) VALUES (?)', time.now());
    await visit(f, 'README.md');
    await alarm(f.h.trunk);
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    expect(queued(f.h.trunk)).toBe(1);
    expect(await context(f.h.trunk).storage.getAlarm()).toBe(time.now() + 3_600_000);
    time.advance(3_600_000);
    await alarm(new Trunk(context(f.h.trunk), f.h.env));
    expect(commits(ok(await visit(f, 'README.md')))).toEqual([f.base]);
    expect(queued(f.h.trunk)).toBe(0);
  });

  it('remembers binary and oversized outcomes without walking their histories or keeping line maps', async () => {
    const f = await fixture();
    const head = f.h.git.commitTree({ 'binary.bin': '\0binary', 'big.txt': 'line\n'.repeat(20_001) }, f.base);
    f.h.git.native(['update-ref', 'refs/heads/main', head]);
    const walk = vi.spyOn(history, 'historyBlame');
    for (const path of ['binary.bin', 'big.txt']) await visit(f, path);
    await alarm(f.h.trunk);
    expect(walk).not.toHaveBeenCalled();
    const binary = ok(await visit(f, 'binary.bin')), big = ok(await visit(f, 'big.txt'));
    expect(binary.note).toContain('Binary files');
    expect(big.note).toContain('20,000 lines');
    expect(queued(f.h.trunk)).toBe(0);
    expect(context(f.h.trunk).storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM blame').one().count).toBe(0);
    const reopened = new Trunk(context(f.h.trunk), f.h.env);
    expect(ok(await reopened.blame(f.h.repository, 'big.txt', undefined, true))).toEqual(big);
  });

  it('measures visitor latency for 500 lines and fifty changing commits', async () => {
    const f = await fixture();
    const lines = Array.from({ length: 500 }, (_, i) => `export const line${i} = ${i};`);
    let head = f.h.git.commitTree({ 'src/file.ts': lines.join('\n') + '\n' }, f.base);
    for (let i = 0; i < 50; i++) {
      lines[i * 7] = `export const line${i * 7} = ${i + 1}_000;`;
      head = f.h.git.commitTree({ 'src/file.ts': lines.join('\n') + '\n' }, head);
    }
    f.h.git.native(['update-ref', 'refs/heads/main', head]);
    const start = performance.now();
    expect((await visit(f, 'src/file.ts')).ok).toBe(true);
    const visitorMs = performance.now() - start;
    expect(f.h.artifacts.get).not.toHaveBeenCalled();
    const walking = performance.now();
    await alarm(f.h.trunk);
    const backgroundMs = performance.now() - walking;
    const warm = performance.now();
    const final = ok(await visit(f, 'src/file.ts'));
    const cachedMs = performance.now() - warm;
    const native = f.h.git.native(['blame', '--first-parent', '--line-porcelain', head, '--', 'src/file.ts']).split('\n').flatMap(line => /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line)?.[1] ?? []);
    expect(commits(final)).toEqual(native);
    expect(final.note).toBeUndefined();
    console.log(JSON.stringify({ fixture: 'visitor / 500 lines / 50 changing commits', visitorMs: +visitorMs.toFixed(2), backgroundMs: +backgroundMs.toFixed(2), cachedMs: +cachedMs.toFixed(2), ranges: final.ranges.length }));
  }, 60_000);
});

describe('durable blame work limits', () => {
  it('bounds unavailable answers and keys them to the head', () => {
    const store = storageFixture(); cleanup.push(() => store.db.close());
    const queue = new BlameQueue(store.storage);
    const missing = { ok: false as const, status: 404, error: 'File not found.' };
    for (let i = 0; i <= PUBLIC_BLAME_PENDING; i++) queue.remember(`file-${i}`, 'head', missing);
    expect(queue.unavailable('file-0', 'head')).toBeUndefined();
    expect(queue.unavailable('file-1', 'head')).toEqual(missing);
    expect(queue.unavailable('file-1', 'another-head')).toBeUndefined();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM blame_unavailable').get()!.count).toBe(PUBLIC_BLAME_PENDING);
  });

  it('permits sixty starts in a rolling hour across eviction, then wakes when the first slot expires', () => {
    const store = storageFixture(); cleanup.push(() => store.db.close());
    const time = clock(), first = time.now();
    let queue = new BlameQueue(store.storage);
    for (let i = 0; i < PUBLIC_BLAME_HOURLY; i += 2) {
      queue.enqueue(`file-${i}`); queue.enqueue(`file-${i + 1}`);
      const jobs = queue.take(); expect(jobs).toHaveLength(2);
      for (const job of jobs) queue.done(job.path);
      time.advance(1000);
      queue = new BlameQueue(store.storage);
    }
    queue.enqueue('waiting');
    expect(queue.take()).toEqual([]);
    expect(queue.next()).toBe(first + 3_600_000);
    time.advance(first + 3_600_000 - time.now() - 1);
    expect(queue.take()).toEqual([]);
    time.advance(1);
    expect(queue.take()).toEqual([{ path: 'waiting', attempts: 1, warm: 0 }]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM blame_starts').get()!.count).toBe(59);
  });

  it('recovers interrupted attempts after their lease without resetting their cost or retry limit', () => {
    const store = storageFixture(); cleanup.push(() => store.db.close());
    const time = clock();
    let queue = new BlameQueue(store.storage);
    queue.enqueue('interrupted');
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(queue.take()).toEqual([{ path: 'interrupted', attempts: attempt, warm: 0 }]);
      queue = new BlameQueue(store.storage);
      expect(queue.take()).toEqual([]);
      time.advance(60_000);
    }
    expect(queue.take()).toEqual([]);
    expect(queue.has('interrupted')).toBe(false);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM blame_starts').get()!.count).toBe(3);
  });
});
