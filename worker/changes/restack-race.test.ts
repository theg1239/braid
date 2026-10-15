import { afterEach, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import type { Change } from '../../shared/types';

let h: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { if (h) { await h.settle(2); await h.close(); h = undefined; } vi.restoreAllMocks(); });
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.data; };
const owner = { kind: 'owner' as const, id: 'user:owner', name: 'Owner' };

it('serializes a reused restack key across two changes before either graph or revision is changed', async () => {
  h = await changeHarness();
  const f = h;
  const policy = JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, merge: { union: [] } });
  const initial = { 'parent.txt': 'old\n', '.braid/policy.json': policy };
  const base = f.git.commitTree(initial);
  f.git.native(['update-ref', 'refs/heads/main', base]);
  const parentHead = f.git.commitTree({ ...initial, 'parent.txt': 'new\n' }, base);
  const parent = ok(await f.shard(1).push(f.context('parent', 1), { commit: parentHead }, {
    title: 'Parent', summary: 'Parent', baseCommit: base, files: [{ path: 'parent.txt', content: 'new\n' }],
  }));
  const children: Change[] = [];
  for (const name of ['alpha', 'beta']) children.push(ok(await f.shard(0).submit(f.context(owner, 0), {
    title: name, summary: name, baseCommit: parentHead, dependsOn: [parent.id], files: [{ path: `${name}.txt`, content: `${name}\n` }],
  }, `create-dependent-${name}`)));
  const result = await Promise.all(children.map(child => f.shard(0).restack(f.context(owner, 0), child.id,
    { previousRevision: 1 }, 'identical-restack-key')));
  expect(result.filter(r => r.ok)).toHaveLength(1);
  const failed = result.findIndex(r => !r.ok);
  expect.soft(result[failed]).toMatchObject({ ok: false, status: 409 });
  const current = ok(await f.shard(0).dependencyNode(children[failed].id));
  expect(current.revision).toBe(1);
  // A later legitimate edit of the rejected PR must still be possible.
  expect(await f.shard(0).revise(f.context(owner, 0), current.id, { previousRevision: 1, baseCommit: parentHead,
    summary: 'Independent follow-up', files: [{ path: 'followup.txt', content: 'preserved work\n' }],
  }, 'valid-new-revision-key')).toMatchObject({ ok: true, data: { revision: 2 } });
});
