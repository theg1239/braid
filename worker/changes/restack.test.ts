import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Change } from '../../shared/types';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import { parse, localSubmission, restack, stackPage } from '../schemas';
import { StackGraph, type StackNode } from './stacks';
import { shardOf } from './names';
import { changesRoute } from './router';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { if (h) { await h.settle(2); await h.close(); h = undefined!; } vi.restoreAllMocks(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }): T => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const owner = { kind: 'owner' as const, id: 'user:owner', name: 'Owner' };
const store = (c: Change) => h.shard(shardOf(c.id)!);
const context = (c: Change) => h.context(owner, shardOf(c.id)!);
const get = async (c: Change) => ok(await store(c).get(c.id));
const policy = JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, merge: { union: [] } });
const tree = (text: string) => ({ 'code.txt': text, '.braid/policy.json': policy });
const body = (baseCommit: string, content: string, dependsOn?: (string | number)[]) => ({ title: content, summary: content, baseCommit, files: [{ path: 'code.txt', content }], ...(dependsOn === undefined ? {} : { dependsOn }) });
async function setup(child = 'parent one\nkeep\nchild\n', patchOnly = false) {
  h = await changeHarness();
  const base = h.git.commitTree(tree('base\nkeep\nend\n'));
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'owner@example.test' });
  const old = h.git.commitTree(tree('parent one\nkeep\nend\n'), base);
  const parent = patchOnly ? ok(await h.submit('parent', body(base, 'parent one\nkeep\nend\n')))
    : ok(await h.shard(0).push(h.context('parent', 0), { commit: old }, body(base, 'parent one\nkeep\nend\n')));
  const dependent = ok(await h.submit('child', body(old, child, [parent.id])));
  return { base, old, parent, dependent };
}
async function reviseParent(parent: Change, base: string, content = 'parent two\nkeep\nend\n', patchOnly = false) {
  const head = h.git.commitTree(tree(content), base);
  ok(await store(parent).revise({ ...context(parent), ...(!patchOnly ? { headCommit: head } : {}) }, parent.id,
    { ...body(base, content), previousRevision: (await get(parent)).revision }, `revise-parent-${head}`));
  return head;
}

describe('restack and direct dependency notifications', () => {
  it('validates task dependencies, restack preconditions and stack cursors at the boundary', () => {
    expect(parse(localSubmission, { ...body('a'.repeat(40), 'result', [51]), rationale: 'Why' }).dependsOn).toEqual([51]);
    expect(() => parse(localSubmission, { ...body('a'.repeat(40), 'result', [-1]), rationale: 'Why' })).toThrow();
    for (const input of [{}, { previousRevision: 0 }, { previousRevision: 1.5 }]) expect(() => parse(restack, input)).toThrow();
    expect(parse(stackPage, {})).toEqual({ stackCursor: 0 });
    for (const value of ['-1', 'NaN', '1.5']) expect(() => parse(stackPage, { stackCursor: value })).toThrow();
  });

  it('restacks only the dependent edits, resets approval, retains identity, and lands on current main', async () => {
    const { parent, dependent, base } = await setup();
    const head = await reviseParent(parent, base);
    await vi.waitFor(async () => expect(await get(dependent)).toMatchObject({ status: 'revise', label: 'Needs restack', next: expect.stringContaining(`#${parent.number} changed since this was built`), outdated: [{ id: parent.id }] }));
    const revised = ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-clean-request'));
    expect(revised).toMatchObject({ id: dependent.id, number: dependent.number, revision: 2, baseCommit: head, status: 'open', outdated: [], files: [{ path: 'code.txt', additions: 1, deletions: 1 }] });
    const diff = ok(await store(dependent).diff(h.repository, dependent.id, 'code.txt'));
    expect(diff.before).toBe('parent two\nkeep\nend\n');
    expect(diff.after).toBe('parent two\nkeep\nchild\n');
    expect(ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-clean-request')).revision).toBe(2);
    expect(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 2 }, 'restack-clean-request')).toMatchObject({ ok: false, status: 409 });
    await h.settle(6);
    expect((await get(dependent)).status).toBe('landed');
    expect(h.git.native(['show', 'main:code.txt'])).toBe('parent two\nkeep\nchild\n');
  });

  it('materializes patch-only prerequisites without moving main and restacks onto that Git head', async () => {
    const { parent, dependent, base } = await setup(undefined, true);
    await reviseParent(parent, base, undefined, true);
    const result = ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-patch-request'));
    expect(h.head()).toBe(base);
    expect(h.git.native(['show', `${result.baseCommit}:code.txt`])).toBe('parent two\nkeep\nend\n');
    expect(ok(await store(dependent).diff(h.repository, dependent.id, 'code.txt')).after).toBe('parent two\nkeep\nchild\n');
  });

  it('reports conflicts without changing the patch, revision or main, including exact retries', async () => {
    const { parent, dependent, base } = await setup('child changed\nkeep\nend\n');
    await reviseParent(parent, base);
    const result = ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-conflict-request'));
    expect(result).toMatchObject({ status: 'revise', label: 'Conflicts', revision: 1, conflicts: [{ path: 'code.txt', kind: 'content' }] });
    expect(result.baseCommit).toBe(dependent.baseCommit);
    expect(ok(await store(dependent).diff(h.repository, dependent.id, 'code.txt')).after).toBe('child changed\nkeep\nend\n');
    expect(h.head()).toBe(base);
    expect(ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-conflict-request')).revision).toBe(1);
  });

  it('runs the next operation on a pull request after a restack fails while it waits', async () => {
    const { parent, dependent, base } = await setup('child changed\nkeep\nend\n');
    await reviseParent(parent, base);
    let reached!: () => void, release!: () => void;
    const dequeuing = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(h.trunk, 'dequeue').mockImplementationOnce(async () => { reached(); await gate; return { removed: false, landing: true }; });
    const restacking = store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-merging-request');
    await dequeuing;
    const commenting = store(dependent).comment(context(dependent), dependent.id, { body: 'Checking the merge.', revision: 1 }, 'comment-during-restack-key');
    release();
    expect(await restacking).toMatchObject({ ok: false, status: 409, error: 'This pull request is merging. Wait for its result.' });
    expect(ok(await commenting).commentCount).toBe(1);
  });

  it('keeps same-base revisions outdated instead of accepting a description update as a restack', async () => {
    const { parent, dependent, base, old } = await setup();
    await reviseParent(parent, base);
    const result = ok(await store(dependent).revise(context(dependent), dependent.id, { ...body(old, 'parent one\nkeep\nchild v2\n'), previousRevision: 1 }, 'same-base-child-request'));
    expect(result).toMatchObject({ status: 'revise', outdated: [{ id: parent.id }] });
  });

  it('keeps a concurrently revised prerequisite outdated after a restack prepared on its old revision', async () => {
    const { parent, dependent, base } = await setup();
    await reviseParent(parent, base);
    const original = h.trunk.restackBase.bind(h.trunk);
    vi.spyOn(h.trunk, 'restackBase').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await reviseParent(parent, base, 'parent three\nkeep\nend\n');
      return result;
    });
    const result = ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-racing-request'));
    expect(result).toMatchObject({ revision: 2, status: 'revise', outdated: [{ id: parent.id }] });
  });

  it('recovers a lost revision reply with its exact prepared restack and rejects another author', async () => {
    const { parent, dependent, base } = await setup();
    await reviseParent(parent, base);
    expect(await store(dependent).restack(h.context('other', shardOf(dependent.id)!), dependent.id, { previousRevision: 1 }, 'restack-foreign-request')).toMatchObject({ ok: false, status: 403 });
    const original = store(dependent).revise.bind(store(dependent));
    vi.spyOn(store(dependent), 'revise').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Lost response'); });
    expect(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-lost-request')).toMatchObject({ ok: false, status: 500 });
    expect(ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 1 }, 'restack-lost-request')).revision).toBe(2);
  });

  it.each(['landed', 'closed'] as const)('wakes dependents directly when a prerequisite is %s', async outcome => {
    const { parent, dependent } = await setup();
    const wake = vi.spyOn(store(dependent), 'dependencyChanged');
    if (outcome === 'closed') ok(await store(parent).close(context(parent), parent.id, {}));
    else await h.trunk.alarm();
    await vi.waitFor(async () => expect(outcome === 'closed' ? ['attention'] : ['queued', 'landing', 'landed']).toContain((await get(dependent)).status));
    expect(wake).toHaveBeenCalledWith(dependent.id);
  });

  it.each(['landed', 'closed'] as const)('recovers a lost direct %s wake through the dependent alarm', async outcome => {
    const { parent, dependent } = await setup();
    const wake = vi.spyOn(store(dependent), 'dependencyChanged').mockRejectedValue(new Error('Lost notification'));
    if (outcome === 'closed') ok(await store(parent).close(context(parent), parent.id, {}));
    else await h.trunk.alarm();
    expect((await get(dependent)).status).toBe('open');
    await store(dependent).alarm();
    expect((await get(dependent)).status).toBe(outcome === 'closed' ? 'attention' : 'queued');
    wake.mockRestore();
  });

  it('detects a newly submitted dependent that explicitly names an old pushed head', async () => {
    const { parent, base, old } = await setup();
    await reviseParent(parent, base);
    const late = ok(await h.submit('late', body(old, 'parent one\nkeep\nlate child\n', [parent.id])));
    expect(late).toMatchObject({ status: 'revise', outdated: [{ id: parent.id }] });
  });

  it('composes multiple prerequisites into one base and keeps only the dependent patch', async () => {
    const { parent, dependent, base } = await setup();
    const second = ok(await h.submit('second', { title: 'Second prerequisite', summary: 'Second prerequisite', baseCommit: base, files: [{ path: 'second.txt', content: 'Second\n' }] }));
    ok(await store(dependent).revise(context(dependent), dependent.id, { ...body(dependent.baseCommit, 'parent one\nkeep\nchild\n', [parent.id, second.id]), previousRevision: 1 }, 'multiple-prerequisites'));
    await reviseParent(parent, base);
    const result = ok(await store(dependent).restack(context(dependent), dependent.id, { previousRevision: 2 }, 'restack-multiple-request'));
    expect(h.git.native(['show', `${result.baseCommit}:second.txt`])).toBe('Second\n');
    expect(result.files.map(file => file.path)).toEqual(['code.txt']);
    expect(ok(await store(dependent).diff(h.repository, dependent.id, 'code.txt')).after).toBe('parent two\nkeep\nchild\n');
    expect(h.head()).toBe(base);
  });

  it.each(['landed', 'closed'] as const)('retries a failed direct %s notification from the trunk outbox', async outcome => {
    const { parent, dependent } = await setup();
    const wake = vi.spyOn(store(dependent), 'dependencyChanged').mockRejectedValue(new Error('Lost notification'));
    if (outcome === 'closed') ok(await store(parent).close(context(parent), parent.id, {}));
    else await h.trunk.alarm();
    expect((await get(dependent)).status).toBe('open');
    wake.mockRestore();
    await h.trunk.alarm();
    await vi.waitFor(async () => expect(outcome === 'closed' ? ['attention'] : ['queued', 'landing', 'landed']).toContain((await get(dependent)).status));
  });

  it('validates task references against the same graph and exposes the HTTP restack contract', async () => {
    const { parent, dependent, base } = await setup();
    expect(await h.trunk.checkDependencies(h.repository, [999999])).toMatchObject({ ok: false, status: 404 });
    expect(await h.trunk.checkDependencies(h.repository, [dependent.id], parent.id)).toMatchObject({ ok: false, status: 409 });
    await reviseParent(parent, base);
    const response = await changesRoute(new Request(`http://braid/api/changes/${dependent.number}/restack`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'restack-route-request' }, body: JSON.stringify({ previousRevision: 1 }) }), h.env, { repository: h.repository, mode: 'live', role: 'owner', person: { id: 'owner', name: 'Owner' } });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ revision: 2, outdated: [] });
    ok(await store(parent).close(context(parent), parent.id, {}));
    expect(await h.trunk.checkDependencies(h.repository, [parent.number])).toMatchObject({ ok: false, status: 409 });
  });
});

it('pages more than 20 stacks, past a 128-member component, without duplicates', () => {
  const fixture = storageFixture();
  try {
    const graph = new StackGraph(fixture.storage.sql);
    const node = (number: number): StackNode => ({ id: `ch_${number.toString(16).padStart(13, '0')}`, number, revision: 1, status: 'open' });
    for (let n = 1; n <= 128; n++) fixture.storage.transactionSync(() => graph.set(node(n), n > 1 ? [node(n - 1)] : [], `key-${n}`, false));
    for (let n = 129; n < 179; n++) fixture.storage.transactionSync(() => graph.set(node(n), n % 2 === 0 ? [node(n - 1)] : [], `key-${n}`, false));
    const first = graph.active();
    expect(first.stacks).toHaveLength(20);
    expect(first.stacks[0]).toHaveLength(128);
    const next = graph.active(first.nextStackCursor!);
    expect(next.stacks).toHaveLength(6);
    expect(next.nextStackCursor).toBeNull();
    expect(new Set([...first.stacks, ...next.stacks].flatMap(stack => stack.map(item => item.id))).size).toBe(178);
  } finally { fixture.db.close(); }
});
