import { afterEach, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import type { VerifyJob, VerifyResult } from '../agents/runner';

let h: Awaited<ReturnType<typeof changeHarness>>;
afterEach(async () => { await h?.close(); });
const check = { command: 'npm test', exitCode: 0, durationMs: 1, output: 'ok', truncated: false, phase: 'check' as const };
const result = (job: VerifyJob): VerifyResult => ({ id: job.id, commit: job.commit, status: 'passed', checks: [check], startedAt: '', finishedAt: '' });
async function staged(required: string[] = [], install?: string) {
  h = await changeHarness();
  const base = h.git.commitTree({ 'README.md': 'Before\n', '.braid/policy.json': JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, checks: ['npm test'], install, verify: { required } }) });
  h.git.native(['update-ref', 'refs/heads/main', base]);
  await h.trunk.configure(h.repository, { enabled: true, actor: 'Owner' });
  expect((await h.submit('writer', { title: 'Candidate', summary: 'Candidate', baseCommit: base, files: [{ path: 'README.md', content: 'After\n' }] })).ok).toBe(true);
  await h.trunk.alarm();
  return { base, ...h.verifications[0] };
}

it.each(['id', 'commit', 'empty', 'command', 'baseline'] as const)('ignores a verification receipt with mismatched %s', async kind => {
  const { base, batchId, job } = await staged();
  const forged = result(job);
  if (kind === 'id') forged.id = 'previous-batch';
  if (kind === 'commit') forged.commit = base;
  if (kind === 'empty') forged.checks = [];
  if (kind === 'command') forged.checks = [{ ...check, command: 'true' }];
  if (kind === 'baseline') { forged.status = 'failed'; forged.checks = [{ ...check, exitCode: 1 }]; forged.baseline = { commit: '0'.repeat(40), failing: ['npm test'] }; }
  await h.trunk.verified(h.repository, batchId, forged);
  expect.soft(h.head()).toBe(base);
  expect.soft((await h.trunk.status(h.repository)).paused).toBeUndefined();
  const { ctx } = h.trunk as unknown as { ctx: DurableObjectState };
  const stack = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'verifying'").toArray()[0];
  expect.soft(stack && JSON.parse(stack.value)[0]?.runner?.state).toBe('pending');
});

it('does not overwrite a completed receipt while another gate is pending', async () => {
  const { base, batchId, job } = await staged(['required-ci']);
  await h.trunk.verified(h.repository, batchId, result(job));
  await h.trunk.verified(h.repository, batchId, { ...result(job), status: 'failed', checks: [{ ...check, exitCode: 1 }], baseline: { commit: base, failing: ['npm test'] } });
  expect(h.head()).toBe(base);
  expect((await h.trunk.status(h.repository)).paused).toBeUndefined();
  const { ctx } = h.trunk as unknown as { ctx: DurableObjectState };
  expect(JSON.parse(ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'verifying'").one().value)[0].runner.state).toBe('passed');
});

it.each(['missing', 'after-checks'] as const)('requires the configured install phase: %s', async kind => {
  const { batchId, job } = await staged(['required-ci'], 'npm ci');
  const forged = result(job);
  const install = { ...check, command: 'npm ci', phase: 'install' as const };
  if (kind === 'after-checks') forged.checks.push(install);
  await h.trunk.verified(h.repository, batchId, forged);
  const { ctx } = h.trunk as unknown as { ctx: DurableObjectState };
  const state = () => JSON.parse(ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'verifying'").one().value)[0].runner.state;
  expect(state()).toBe('pending');
  await h.trunk.verified(h.repository, batchId, { ...result(job), checks: [install, check] });
  expect(state()).toBe('passed');
});
