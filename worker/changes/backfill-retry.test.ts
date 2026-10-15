import { afterEach, expect, it, vi } from 'vitest';
import { Trunk } from './trunk';
import { storageFixture } from '../test/storage';
import type { BraidEnv } from '../env';

afterEach(() => { vi.restoreAllMocks(); });

function unavailableLegacyLanding() {
  const f = storageFixture();
  const readCommit = vi.fn(async () => null);
  const env = {
    WORKSPACES: { getByName: () => ({ repository: async () => ({ id: 'repo', branch: 'main' }) }) },
    ARTIFACTS: { get: async () => ({ readCommit, [Symbol.dispose]() {} }) },
  } as unknown as BraidEnv;
  new Trunk(f.ctx, env);
  f.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('repository', 'fixture')");
  f.storage.sql.exec('INSERT INTO commits (sha, provenance, agent, added, alive) VALUES (?, ?, ?, 2, 1)', 'a'.repeat(40), JSON.stringify({
    commit: 'a'.repeat(40), kind: 'agent', confidence: 'braid', at: '2026-10-13T00:00:00Z',
    agent: { name: 'Combined task' }, files: { 'a.ts': { kind: 'agent', agent: { name: 'Codex', model: 'codex' } } },
  }), 'combined');
  // A legacy deployment has no per-file rows; migration discovers the commit on startup.
  f.storage.sql.exec("DELETE FROM meta WHERE key = 'file-lines-version'");
  return { f, env, readCommit };
}

it('stops scheduling roster migration reads for a permanently unavailable commit, including after eviction', async () => {
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const { f, env, readCommit } = unavailableLegacyLanding();
  try {
    let rounds = 0;
    for (; rounds < 10; rounds++) {
      const scheduled = await f.storage.getAlarm();
      if (scheduled !== null) time = Math.max(time, scheduled);
      const trunk = new Trunk(f.ctx, env);
      await f.ready();
      const alarm = await f.storage.getAlarm();
      if (alarm === null) break;
      time = Math.max(time, alarm);
      await f.storage.deleteAlarm();
      await trunk.alarm();
    }
    expect(rounds).toBeLessThan(10);
    expect(readCommit.mock.calls.length).toBeGreaterThan(0);
    expect(await f.storage.getAlarm()).toBeNull();
    expect(await new Trunk(f.ctx, env).agentLines('fixture', true)).toEqual({ combined: { added: 2, alive: 1 } });
  } finally { f.db.close(); }
});

it('preserves a backfill retry delay when the object is evicted', async () => {
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const { f, env, readCommit } = unavailableLegacyLanding();
  try {
    const trunk = new Trunk(f.ctx, env);
    await f.ready();
    time = (await f.storage.getAlarm())!;
    await f.storage.deleteAlarm();
    await trunk.alarm();
    const retry = await f.storage.getAlarm();
    expect(retry).toBeGreaterThan(time);
    time += 100;
    new Trunk(f.ctx, env);
    await f.ready();
    expect(await f.storage.getAlarm()).toBe(retry);
    expect(readCommit).toHaveBeenCalledTimes(1);
  } finally { f.db.close(); }
});
