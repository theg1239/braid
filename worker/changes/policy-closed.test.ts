import { afterEach, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { await h?.close(); });
const ok = <T>(result: { ok: true; data: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.data; };

it.each(['{', '{"autonomy":"invalid"}'])('holds documentation for a person despite passing agent review when policy is %s', async policy => {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Before\n', '.braid/policy.json': policy });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'Owner' });
  const submitted = ok(await h.submit('writer', { title: 'Documentation', summary: 'An innocent docs-only edit', baseCommit: base, files: [{ path: 'README.md', content: 'After\n' }] }));
  const shard = h.shard(parseInt(submitted.id[3], 16));
  ok(await shard.review(h.context('reviewer', parseInt(submitted.id[3], 16)), submitted.id, { revision: submitted.revision, verdict: 'approve', summary: 'Documentation is correct.' }));
  await h.settle();
  const waiting = ok(await shard.get(submitted.id));
  expect(waiting).toMatchObject({ status: 'attention', autonomy: 'human', label: 'Policy file error' });
  expect(waiting.reviews.some(review => review.kind === 'agent' && review.verdict === 'approve')).toBe(true);
  expect(waiting.policy?.requirements).toContainEqual(expect.objectContaining({ id: 'policy', satisfied: false }));
  expect(h.head()).toBe(base);
  ok(await shard.approve(h.context({ kind: 'owner', id: 'owner', name: 'Owner' }, parseInt(submitted.id[3], 16)), submitted.id, { revision: waiting.revision }));
  await h.settle();
  expect(ok(await shard.get(submitted.id)).status).toBe('landed');
});
