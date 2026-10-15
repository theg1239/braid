import { afterEach, expect, it, vi } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { Directory } from '../accounts/directory';
import type { BraidEnv } from '../env';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); harness = undefined; });

it('tells the Directory once when a pull request starts needing a person', async () => {
  harness = await changeHarness({ env: { EMAIL_FROM: 'braid@example.test' } });
  (harness.env as { EMAIL?: BraidEnv['EMAIL'] }).EMAIL = { send: vi.fn() } as unknown as BraidEnv['EMAIL'];
  const enqueue = vi.spyOn(Directory.prototype, 'enqueuePullRequestNotification').mockResolvedValue();
  const base = harness.git.commitTree({ '.braid/policy.json': JSON.stringify({ rules: [{ paths: ['src/billing/**'], autonomy: 'human' }] }), 'README.md': '# Relay\n' });
  harness.git.native(['update-ref', 'refs/heads/main', base]);
  await harness.trunk.configure(harness.repository, { enabled: true, actor: 'owner@example.test' });
  const submitted = await harness.submit('atlas', { title: 'Round invoice totals', summary: 'Round.', baseCommit: base, files: [{ path: 'src/billing/total.ts', content: 'export const total = (cents: number) => Math.round(cents);\n' }] });
  if (!submitted.ok) throw new Error(submitted.error);
  await harness.settle();
  await harness.settle();
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0][0]).toMatchObject({ workspaceId: 'w', kind: 'attention', change: { id: submitted.data.id, number: submitted.data.number, revision: 1 } });
});
