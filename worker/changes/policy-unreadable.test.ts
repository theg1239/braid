import { afterEach, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { await h?.close(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.data; };

it.each([
  ['oversized', ' '.repeat(1024 * 1024) + '{"autonomy":"human","rules":[]}'],
  ['binary', '{"autonomy":"human","rules":[]}\0'],
])('requires person approval when the existing policy is %s', async (_kind, policy) => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Before\n', '.braid/policy.json': policy });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'Owner' });
  const submitted = ok(await h.submit('writer', { title: 'Documentation', summary: 'An ordinary edit', baseCommit: base, files: [{ path: 'README.md', content: 'After\n' }] }));
  const index = parseInt(submitted.id[3], 16), shard = h.shard(index);
  ok(await shard.review(h.context('reviewer', index), submitted.id, { revision: submitted.revision, verdict: 'approve', summary: 'Documentation is correct.' }));
  await h.settle();
  expect(ok(await shard.get(submitted.id))).toMatchObject({ status: 'attention', autonomy: 'human', label: 'Policy file error' });
  expect(h.head()).toBe(base);
});
