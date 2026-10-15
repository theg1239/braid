import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { PathIndex } from './paths';
import { shardOf } from './names';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); harness = undefined; });
const ok = <T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }) => {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
};
const owner = { kind: 'owner' as const, id: 'user:owner', name: 'owner@example.test' };
const UPSTREAM = 'upstream-text-with-a-credential-fixture';

async function setup(options?: Parameters<typeof changeHarness>[0]) {
  harness = await changeHarness(options);
  const base = harness.git.commitTree({ 'docs/guide.md': '# Guide\n' });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
  return { harness, base };
}
/** What the shard wrote to the console, as the JSON lines it logs. */
function logs() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { text: () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]), events: () => warn.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>) };
}

describe('failures the shard carries on past', () => {
  it('answers an unexpected failure with fixed text and logs its type, not its message', async () => {
    const { harness, base } = await setup();
    const logged = logs();
    harness.workspace.repository.mockRejectedValueOnce(new Error(UPSTREAM));
    expect(await harness.submit('atlas', { title: 'Add a guide', summary: 'Adds a guide.', baseCommit: base, files: [{ path: 'docs/more.md', content: '# More\n' }] }))
      .toEqual({ ok: false, status: 500, error: 'The change operation could not complete. Retry with the same request key.' });
    expect(logged.events()).toContainEqual({ event: 'change_operation_failed', error: 'Error' });
    expect(logged.text()).not.toContain(UPSTREAM);
  });

  it('logs a failed automatic review by its type and retries it', async () => {
    const { harness, base } = await setup({ review: () => { throw new Error(UPSTREAM); } });
    const logged = logs();
    const change = ok(await harness.submit('atlas', { title: 'Add a guide', summary: 'Adds a guide.', baseCommit: base, files: [{ path: 'docs/more.md', content: '# More\n' }] }));
    await harness.settle(1);
    expect(logged.events()).toContainEqual({ event: 'review_failed', changeId: change.id, attempts: 0, error: 'Error' });
    expect(logged.text()).not.toContain(UPSTREAM);
    expect(ok(await harness.shard(shardOf(change.id)!).get(change.id)).status).toBe('open');
  });

  it('closes a change and tells its task even when the path index fails, and logs the index failure', async () => {
    const { harness, base } = await setup();
    const change = ok(await harness.submit('atlas', { title: 'Add a guide', summary: 'Adds a guide.', baseCommit: base, taskId: 'task-1', files: [{ path: 'docs/more.md', content: '# More\n' }] }));
    const logged = logs();
    vi.spyOn(PathIndex.prototype, 'release').mockImplementation(() => { throw new Error(UPSTREAM); });
    const index = shardOf(change.id)!;
    expect(ok(await harness.shard(index).close(harness.context(owner, index), change.id, { reason: 'rejected' }))).toMatchObject({ status: 'closed', closeReason: 'rejected' });
    expect(harness.workspace.taskChange).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ id: change.id, status: 'closed', reason: 'rejected' }));
    expect(logged.events()).toContainEqual({ event: 'path_index_failed', changeId: change.id, status: 'closed', error: 'Error' });
    expect(logged.text()).not.toContain(UPSTREAM);
  });
});

describe('concurrent requests', () => {
  it('reverts a landed change once when two reverts arrive together', async () => {
    const { harness, base } = await setup();
    const change = ok(await harness.submit('atlas', { title: 'Add a guide', summary: 'Adds a guide.', baseCommit: base, files: [{ path: 'docs/more.md', content: '# More\n' }] }));
    await harness.settle();
    const index = shardOf(change.id)!, shard = harness.shard(index);
    expect(ok(await shard.get(change.id)).status).toBe('landed');
    const [first, second] = await Promise.all(['revert-race-key-0001', 'revert-race-key-0002'].map(key => shard.revert(harness!.context(owner, index), change.id, key)));
    expect(ok(second).id).toBe(ok(first).id);
    expect(shard.agentStats().find(stats => stats.authors.includes('agent:atlas'))).toMatchObject({ reverted: 1 });
    expect(ok(await shard.get(change.id)).events.filter(event => event.type === 'reverted')).toHaveLength(1);
  });

  it('opens one instruction change when the same request arrives twice at once', async () => {
    const { harness } = await setup();
    const shard = harness.shard(0), add = { add: { text: 'Keep the guide short' } };
    const [first, second] = await Promise.all([shard.instruct(harness.context(owner, 0), add, 'instruction-race-key-0001'), shard.instruct(harness.context(owner, 0), add, 'instruction-race-key-0001')]);
    expect(ok(second).id).toBe(ok(first).id);
  });
});
