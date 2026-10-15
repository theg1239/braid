import { afterEach, describe, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('starting a simulation', () => {
  it('lets only one of two starts in flight begin a run', async () => {
    harness = await changeHarness();
    harness.git.native(['update-ref', 'refs/heads/main', harness.git.commitTree({ 'README.md': '# Swarm\n' })]);
    await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
    const input = { agents: 2, scenario: 'disjoint' } as const;
    const results = await Promise.all([harness.swarm.start(harness.repository, input, 'owner'), harness.swarm.start(harness.repository, input, 'owner')]);
    expect(results.filter(result => result.ok)).toEqual([{ ok: true, data: expect.objectContaining({ status: 'preparing' }) }]);
    expect(results.find(result => !result.ok)).toEqual({ ok: false, status: 409, error: 'A simulation is already running in this repository.' });
  });
});
