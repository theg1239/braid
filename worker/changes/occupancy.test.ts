import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { agentRoster, listChanges } from './router';
import { ChangeShard } from './shard';
import { CHANGE_SHARDS, shardOf, submissionShard } from './names';
import { pageCursor, parse } from '../schemas';

/*
 * Lists gather only from the shards that hold changes. The landing queue keeps that record: a shard joins it when it
 * takes its first change number, before the change is written, and a repository from before the record is gathered
 * from every shard once, which completes it.
 */
const source = ['export const routes = [', "  '/health',", '];', ''].join('\n');
let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); harness = undefined; });

async function setup() {
  harness = await changeHarness();
  const base = harness.git.commitTree({ 'src/router.ts': source, 'docs/guide.md': '# Guide\n' });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  return { harness, base };
}
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const guide = (author: string, base: string, h: NonNullable<typeof harness>) =>
  h.submit(author, { title: `${author} documents the routes`, summary: 'Docs', baseCommit: base, files: [{ path: `docs/${author}.md`, content: `# ${author}\n` }] });
/** The queue's own table, as a repository from before the record would have it empty. */
const record = (h: NonNullable<typeof harness>) => (h.trunk as unknown as { ctx: DurableObjectState }).ctx.storage.sql;

describe('lists ask only the shards that hold changes', () => {
  it('gathers from every shard once for a repository the record does not know, then from none while it is empty', async () => {
    const { harness } = await setup();
    const list = vi.spyOn(ChangeShard.prototype, 'list'), stats = vi.spyOn(ChangeShard.prototype, 'agentStats');
    expect((await listChanges(harness.env, harness.repository, { limit: 10 })).items).toEqual([]);
    expect(list).toHaveBeenCalledTimes(CHANGE_SHARDS);
    expect(await harness.trunk.occupiedShards(harness.repository)).toEqual([]);
    expect(await listChanges(harness.env, harness.repository, { statuses: ['landed'], limit: 1 })).toEqual({ items: [], nextCursor: null, counts: { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 } });
    expect(await agentRoster(harness.env, harness.repository)).toEqual([]);
    expect(list).toHaveBeenCalledTimes(CHANGE_SHARDS);
    expect(stats).not.toHaveBeenCalled();
  });

  it('asks at most as many shards as there are changes, for the latest merge, the counts and the roster alike', async () => {
    const { harness, base } = await setup();
    await listChanges(harness.env, harness.repository, { limit: 1 });
    const ids = await Promise.all(['atlas', 'scribe', 'sable'].map(async author => ok(await guide(author, base, harness)).id));
    const occupied = [...new Set(ids.map(id => shardOf(id)!))].sort((a, b) => a - b);
    expect(await harness.trunk.occupiedShards(harness.repository)).toEqual(occupied);
    const list = vi.spyOn(ChangeShard.prototype, 'list'), stats = vi.spyOn(ChangeShard.prototype, 'agentStats');
    const latest = await listChanges(harness.env, harness.repository, { statuses: ['landed'], limit: 1 });
    expect(latest.items).toEqual([]);
    expect(latest.counts.open).toBe(3);
    expect(list).toHaveBeenCalledTimes(occupied.length);
    const open = await listChanges(harness.env, harness.repository, { statuses: ['open'], limit: 10 });
    expect(open.items.map(item => item.id).sort()).toEqual([...ids].sort());
    expect(list).toHaveBeenCalledTimes(occupied.length * 2);
    expect(await agentRoster(harness.env, harness.repository)).not.toEqual([]);
    expect(stats).toHaveBeenCalledTimes(occupied.length);
    expect(occupied.length).toBeLessThanOrEqual(3);
  });

  it('keeps a repository from before the record correct: one full gather completes it, later lists use it', async () => {
    const { harness, base } = await setup();
    const ids = await Promise.all(['atlas', 'scribe', 'sable', 'juno'].map(async author => ok(await guide(author, base, harness)).id));
    const occupied = [...new Set(ids.map(id => shardOf(id)!))].sort((a, b) => a - b);
    record(harness).exec('DELETE FROM change_shards');
    record(harness).exec("DELETE FROM meta WHERE key = 'shards-recorded'");
    expect(await harness.trunk.occupiedShards(harness.repository)).toBeNull();
    const list = vi.spyOn(ChangeShard.prototype, 'list');
    const page = await listChanges(harness.env, harness.repository, { limit: 10 });
    expect(page.items.map(item => item.id).sort()).toEqual([...ids].sort());
    expect(page.counts.open).toBe(4);
    expect(list).toHaveBeenCalledTimes(CHANGE_SHARDS);
    expect(await harness.trunk.occupiedShards(harness.repository)).toEqual(occupied);
    expect((await listChanges(harness.env, harness.repository, { limit: 10 })).items).toHaveLength(4);
    expect(list).toHaveBeenCalledTimes(CHANGE_SHARDS + occupied.length);
  });

  it('registers two shards written at the same moment, before their changes can be listed', async () => {
    const { harness, base } = await setup();
    await listChanges(harness.env, harness.repository, { limit: 1 });
    // The harness numbers request keys in order, so the shard each author's first change takes is known in advance.
    const names = ['atlas', 'scribe', 'sable', 'juno', 'kite', 'moss', 'nova', 'opal'];
    const first = names[0], second = names.slice(1).find(name => submissionShard(`agent:${name}:test-request-key-2-padding`) !== submissionShard(`agent:${first}:test-request-key-1-padding`))!;
    const [a, b] = await Promise.all([guide(first, base, harness), guide(second, base, harness)]);
    const shards = [shardOf(ok(a).id)!, shardOf(ok(b).id)!].sort((x, y) => x - y);
    expect(new Set(shards).size).toBe(2);
    expect(record(harness).exec<{ shard: number }>('SELECT shard FROM change_shards ORDER BY shard').toArray().map(row => row.shard)).toEqual(shards);
    const list = vi.spyOn(ChangeShard.prototype, 'list');
    const page = await listChanges(harness.env, harness.repository, { limit: 10 });
    expect(page.items.map(item => item.id).sort()).toEqual([ok(a).id, ok(b).id].sort());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('pages across shards in order, without a change missing or repeated', async () => {
    const { harness, base } = await setup();
    await listChanges(harness.env, harness.repository, { limit: 1 });
    const ids: string[] = [];
    for (const author of ['atlas', 'scribe', 'sable', 'juno', 'kite', 'moss', 'nova']) ids.push(ok(await guide(author, base, harness)).id);
    const occupied = new Set(ids.map(id => shardOf(id)!));
    const all = (await listChanges(harness.env, harness.repository, { limit: 10 })).items;
    expect(all.map(item => item.id).sort()).toEqual([...ids].sort());
    for (let index = 1; index < all.length; index++) expect(all[index - 1].updatedAt >= all[index].updatedAt).toBe(true);
    const list = vi.spyOn(ChangeShard.prototype, 'list');
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page = await listChanges(harness.env, harness.repository, { limit: 3, ...(cursor ? { before: parse(pageCursor, cursor) } : {}) });
      seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor; pages++;
    } while (cursor);
    expect(seen).toEqual(all.map(item => item.id));
    expect(pages).toBe(3);
    expect(list).toHaveBeenCalledTimes(pages * occupied.size);
  });
});
