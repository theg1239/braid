import { afterEach, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import type { ChangeAuthor } from '../../shared/types';
import { fileProvenance, parseNote, provenanceOf } from '../../shared/provenance';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { if (h) { await h.settle(2); await h.close(); } });
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.data; };

it('preserves chosen file authors when restacking a combined task result', async () => {
  h = await changeHarness();
  const policy = JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 } });
  const base = h.git.commitTree({ 'parent.txt': 'base\n', '.braid/policy.json': policy });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'Fixture' });
  const parentHead = h.git.commitTree({ 'parent.txt': 'one\n' }, base);
  const parent = ok(await h.shard(0).push(h.context('parent', 0), { commit: parentHead }, {
    title: 'Parent', summary: 'Parent', baseCommit: base, files: [{ path: 'parent.txt', content: 'one\n' }],
  }));
  const chosen: ChangeAuthor = { kind: 'agent', id: 'agent:chosen', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', session: 'chosen-run', owner: { name: '@fixture' } };
  const actor = { kind: 'agent' as const, id: 'task:fixture', name: 'Claude Opus 5.5 and GPT-6.1 Sol', owner: { name: '@fixture' } };
  const child = ok(await h.shard(0).submit({ ...h.context(actor, 0), system: true, fileAuthors: { 'child.ts': chosen } }, {
    title: 'Combined task', summary: 'Combined task', baseCommit: parentHead, files: [{ path: 'child.ts', content: 'chosen code\n' }], dependsOn: [parent.id],
  }, 'review-combined-task'));
  const parentNext = h.git.commitTree({ 'parent.txt': 'two\n' }, base);
  const owner = { kind: 'owner' as const, id: 'owner:fixture', name: 'Fixture' };
  ok(await h.shard(0).revise({ ...h.context(owner, 0), headCommit: parentNext }, parent.id, {
    previousRevision: 1, summary: 'Parent revised', baseCommit: base, files: [{ path: 'parent.txt', content: 'two\n' }],
  }, 'review-parent-revision'));
  const revised = ok(await h.shard(0).restack(h.context(owner, 0), child.id, { previousRevision: 1 }, 'review-restack-child'));
  expect(revised.revision).toBe(2);
  await h.settle(6);
  const landed = ok(await h.shard(0).get(child.id));
  expect(landed.status).toBe('landed');
  expect.soft(ok(await h.trunk.blame(h.repository, 'child.ts')).ranges[0].provenance.agent).toMatchObject({ model: chosen.model, session: 'chosen-run' });
  const facts = (await h.git.repository.readCommit(landed.landedCommit!))!;
  const note = parseNote(h.git.native(['notes', '--ref=braid', 'show', facts.hash]));
  expect(fileProvenance(provenanceOf({ id: facts.hash, at: '', author: facts.author, message: facts.message }, note), 'child.ts').agent).toMatchObject({ model: chosen.model, session: 'chosen-run' });
});
