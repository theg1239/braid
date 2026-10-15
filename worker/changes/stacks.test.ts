import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { parse, submission, revision } from '../schemas';
import { shardOf } from './names';
import { listChanges } from './router';
import type { Change } from '../../shared/types';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { await h?.close(); vi.restoreAllMocks(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }): T => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const owner = { kind: 'owner' as const, id: 'user:owner', name: 'Owner' };
const store = (c: Change) => h.shard(shardOf(c.id)!);
const context = (c: Change) => h.context(owner, shardOf(c.id)!);
async function setup() {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': '# Test\n', '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 } }) });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'owner@example.test' });
  return base;
}
const body = (baseCommit: string, name: string, dependsOn?: (number | string)[]) => ({ title: name, summary: name, baseCommit, files: [{ path: `${name}.txt`, content: `${name}\n` }], ...(dependsOn === undefined ? {} : { dependsOn }) });
const get = async (c: Change) => ok(await store(c).get(c.id));

describe('pull request stacks', () => {
  it('validates both request boundaries and bounds dependency references', () => {
    const raw = body('a'.repeat(40), 'changes', [51, 'ch_0123456789abc']);
    expect(parse(submission.agent, raw).dependsOn).toEqual(raw.dependsOn);
    expect(parse(revision.agent, { ...raw, previousRevision: 1 }).dependsOn).toEqual(raw.dependsOn);
    for (const dependsOn of [[0], [-1], [1.5], ['51'], ['ch_other'], new Array(17).fill(1)]) {
      expect(() => parse(submission.agent, { ...raw, dependsOn })).toThrow();
    }
  });

  it('declares by number or id, waits outside the queue and lands on main after every prerequisite', async () => {
    const base = await setup();
    const first = ok(await h.submit('parent', body(base, 'foundation')));
    const second = ok(await h.submit('child', body(base, 'feature', [first.number])));
    const third = ok(await h.submit('third', body(base, 'documentation', [second.id, first.id, first.number])));
    expect(second).toMatchObject({ status: 'open', next: `Waiting on #${first.number}`, dependsOn: [{ id: first.id }] });
    expect(third.dependsOn).toHaveLength(2);
    expect((await h.trunk.status(h.repository)).queued).toBe(1);
    expect(await get(first)).toMatchObject({ requiredBy: [expect.objectContaining({ id: second.id }), expect.objectContaining({ id: third.id })], stack: { position: 1, total: 3 } });
    expect((await listChanges(h.env, h.repository, { limit: 50 })).items.find(c => c.id === second.id)?.stack).toEqual({ position: 2, total: 3 });
    await h.settle(10);
    const results = await Promise.all([first, second, third].map(get));
    expect(results.map(c => c.status)).toEqual(['landed', 'landed', 'landed']);
    expect(results[1].landedParent).toBe(results[0].landedCommit);
    expect(results[2].landedParent).toBe(results[1].landedCommit);
    expect(results[2].waitingOn).toEqual([]);
  }, 30_000);

  it('infers the parent from the pushed head and does not confuse main with an open head', async () => {
    const base = await setup();
    const head = h.git.commitTree({ 'README.md': '# Test\n', 'foundation.txt': 'foundation\n' }, base);
    const first = ok(await h.shard(0).push(h.context('pusher', 0), { commit: head }, body(base, 'foundation')));
    const second = ok(await h.submit('child', body(head, 'feature')));
    expect(first.headCommit).toBe(head);
    expect(second.dependsOn?.map(c => c.id)).toEqual([first.id]);
    expect(second.status).toBe('open');
    expect(ok(await h.submit('independent', body(base, 'unrelated'))).dependsOn).toEqual([]);
    await h.settle(8);
    expect((await get(second)).status).toBe('landed');
  }, 30_000);

  it('rejects a cycle and self-reference without losing a queued revision', async () => {
    const base = await setup(), a = ok(await h.submit('a', body(base, 'alpha'))), b = ok(await h.submit('b', body(base, 'bravo', [a.id])));
    for (const dependency of [b.id, a.id]) {
      expect(await store(a).revise(context(a), a.id, { ...body(base, 'alpha', [dependency]), previousRevision: 1 }, `cycle-request-${dependency}`))
        .toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/cycle|itself/) });
      expect(await get(a)).toMatchObject({ revision: 1, status: 'queued', dependsOn: [] });
    }
    expect((await h.trunk.status(h.repository)).queued).toBe(1);
    await h.settle(8);
    expect((await get(b)).status).toBe('landed');
  }, 30_000);

  it('serializes simultaneous cross-shard edge edits, accepting at most one side of a cycle', async () => {
    const base = await setup();
    const a = ok(await h.shard(0).submit(h.context('a', 0), body(base, 'alpha'), 'simultaneous-alpha'));
    const b = ok(await h.shard(1).submit(h.context('b', 1), body(base, 'bravo'), 'simultaneous-bravo'));
    const results = await Promise.all([[a, b], [b, a]].map(([from, to]) => store(from).revise(context(from), from.id,
      { ...body(base, from.title, [to.id]), previousRevision: 1 }, `simultaneous-${from.id}`)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)[0]).toMatchObject({ status: 409, error: expect.stringContaining('cycle') });
  });

  it('rejects other repositories and missing changes without disclosing them', async () => {
    const base = await setup();
    expect(await h.submit('a', body(base, 'alpha', ['ch_0ffffffffffff']))).toMatchObject({ ok: false, status: 404, error: expect.stringContaining('in this repository') });
    expect(await h.submit('b', body(base, 'bravo', [9999]))).toMatchObject({ ok: false, status: 404 });
    const foreign = ok(await h.shard(0).submit(h.context('other', 0), body(base, 'foreign'), 'other-repo-request'));
    const { ChangeShard } = await import('./shard');
    const { storageFixture } = await import('../test/storage');
    const fixture = storageFixture();
    try {
      const other = new ChangeShard(fixture.ctx, h.env);
      expect(await other.submit({ ...h.context('a', 1), repository: 'other-repository' }, body(base, 'outside', [foreign.id]), 'cross-repo-request'))
        .toMatchObject({ ok: false, status: 404 });
    } finally { fixture.db.close(); }
  });

  it('requires a person after a dependency closes, and clearing dependencies makes a revision eligible', async () => {
    const base = await setup(), a = ok(await h.submit('a', body(base, 'alpha'))), b = ok(await h.submit('b', body(base, 'bravo', [a.id])));
    ok(await store(a).close(context(a), a.id, { reason: 'abandoned' }));
    expect(await h.submit('c', body(base, 'charlie', [a.id]))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('closed without merging') });
    await h.settle();
    expect(await get(b)).toMatchObject({ status: 'attention', label: 'Dependency closed', next: expect.stringContaining(`#${a.number} closed without merging`) });
    expect(ok(await store(b).approve(context(b), b.id, { revision: 1 })).status).toBe('attention');
    const revised = ok(await store(b).revise(context(b), b.id, { ...body(base, 'bravo', []), previousRevision: 1 }, 'clear-dependencies-request'));
    expect(revised).toMatchObject({ status: 'queued', dependsOn: [], waitingOn: [] });
    expect((await get(a)).requiredBy).toEqual([]);
    await h.settle();
    expect((await get(b)).status).toBe('landed');
  });

  it('keeps omitted dependencies on revisions, replaces explicit ones, and rejects altered retries', async () => {
    const base = await setup(), a = ok(await h.submit('a', body(base, 'alpha'))), b = ok(await h.submit('b', body(base, 'bravo')));
    const shard = h.shard(4), ctx = h.context('c', 4), input = body(base, 'charlie', [a.id]);
    const [one, two] = await Promise.all([shard.submit(ctx, input, 'same-submit-request'), shard.submit(ctx, input, 'same-submit-request')]);
    const c = ok(one); expect(ok(two).id).toBe(c.id);
    expect(await shard.submit(ctx, { ...input, dependsOn: [b.id] }, 'same-submit-request')).toMatchObject({ ok: false, status: 409 });
    const retained = ok(await shard.revise(ctx, c.id, { ...body(base, 'charlie'), previousRevision: 1 }, 'retained-dependencies'));
    expect(retained.dependsOn?.[0].id).toBe(a.id);
    const next = { ...body(base, 'charlie', [b.id]), previousRevision: 2 };
    const updated = ok(await shard.revise(ctx, c.id, next, 'changed-dependencies'));
    expect(updated.dependsOn?.[0].id).toBe(b.id);
    expect(ok(await shard.revise(ctx, c.id, next, 'changed-dependencies')).revision).toBe(3);
    expect((await get(a)).requiredBy).toEqual([]);
    expect((await get(b)).requiredBy?.[0].id).toBe(c.id);
  });

  it('retries lost outcome notifications and never queues before the dependency is recorded merged', async () => {
    const base = await setup(), a = ok(await h.submit('a', body(base, 'alpha'))), b = ok(await h.submit('b', body(base, 'bravo', [a.id])));
    const observe = h.trunk.observeChanges.bind(h.trunk);
    const notify = vi.spyOn(h.trunk, 'observeChanges').mockImplementation((key, nodes) => {
      if (nodes.some(node => node.status === 'landed')) throw new Error('offline');
      return observe(key, nodes);
    });
    await h.trunk.alarm();
    expect((await get(a)).status).toBe('landed');
    await store(b).alarm();
    expect((await get(b)).status).toBe('open');
    expect((await h.trunk.status(h.repository)).queued).toBe(0);
    notify.mockRestore();
    await h.settle(8);
    expect((await get(b)).status).toBe('landed');
  });
});
