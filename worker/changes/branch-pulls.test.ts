import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangePage } from '../../shared/types';
import { publicRepository } from '../test/public-repository';
import { recordedExample, type ExampleState } from './demo';
import { listChanges } from './router';

let fixture: Awaited<ReturnType<typeof publicRepository>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function pushed() {
  const f = fixture = await publicRepository();
  const shard = f.h.shard(0), context = f.h.context('pusher', 0);
  const body = { title: 'Round refunds', summary: 'Round refunds.', baseCommit: f.base, files: [{ path: 'src/refunds.ts', content: 'export const round = Math.round;\n' }] };
  const headCommit = f.h.git.commitTree({ 'src/refunds.ts': body.files[0].content }, f.base, body.title);
  const result = await shard.push(context, { topic: 'refund-rounding', commit: headCommit }, body);
  if (!result.ok) throw new Error(result.error);
  return { f, shard, context, body, change: result.data, headCommit };
}

describe('pull requests linked from repository branches', () => {
  it('lists the current pushed head, replaces it on a new push and drops it for a patch-only revision', async () => {
    const { f, shard, context, body, change, headCommit } = await pushed();
    const listed = async () => (await listChanges(f.h.env, f.h.repository, { limit: 100 })).items.find(item => item.id === change.id)!;
    expect(await listed()).toMatchObject({ number: change.number, headCommit });
    const content = 'export const round = (value: number) => Math.round(value);\n';
    const nextHead = f.h.git.commitTree({ 'src/refunds.ts': content }, headCommit, 'Revise rounding');
    const revised = await shard.push(context, { topic: 'refund-rounding', commit: nextHead }, { ...body, files: [{ path: 'src/refunds.ts', content }] });
    expect(revised).toMatchObject({ ok: true, data: { id: change.id, revision: 2 } });
    expect(await listed()).toMatchObject({ headCommit: nextHead, revision: 2 });
    expect(await shard.revise(context, change.id, { ...body, previousRevision: 2 }, 'branch-pull-patch-only')).toMatchObject({ ok: true });
    expect(await listed()).not.toHaveProperty('headCommit');
  });

  it('serves the pushed head through the public repository list', async () => {
    const { f, change, headCommit } = await pushed();
    const response = await f.anonymous('/api/changes?status=active&limit=100');
    expect(response.status).toBe(200);
    const page = await response.json() as ChangePage;
    expect(page.items).toEqual([expect.objectContaining({ number: change.number, headCommit })]);
  });

  it('does not read or reveal a private repository list to a visitor', async () => {
    const { f, shard } = await pushed();
    f.db.db.prepare("UPDATE workspaces SET visibility = 'private'").run();
    const read = vi.spyOn(shard, 'list');
    const response = await f.anonymous('/api/changes?status=active&limit=100');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Repository not found.' });
    expect(read).not.toHaveBeenCalled();
  });

  it('exposes the recorded branch head for #7 without changing its recording and removes a closed result', async () => {
    const example = await recordedExample(), state: ExampleState = { since: Date.now(), decisions: {}, changes: [] };
    const branch = example.branch('refund-rounding', state)!;
    const original = example.change('7', state);
    const query = { statuses: ['open', 'revise', 'attention', 'queued', 'landing'] as const, limit: 100 };
    const listed = example.changes({ ...query, statuses: [...query.statuses] }, state).items.find(item => item.number === 7);
    expect(listed).toMatchObject({ id: branch.changeId, number: 7, headCommit: branch.tip.hash, status: 'attention' });
    expect(example.change('7', state)).toEqual(original);
    state.decisions[original.id] = { action: 'close', at: Date.now(), revision: original.revision };
    expect(example.changes({ ...query, statuses: [...query.statuses] }, state).items.some(item => item.number === 7)).toBe(false);
  });
});
