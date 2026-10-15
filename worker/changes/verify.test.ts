import { describe, expect, it, vi } from 'vitest';
import { storageFixture } from '../test/storage';
import { Trunk } from './trunk';
import { VerifyWorkflow } from './verify';
import type { BraidEnv } from '../env';
import type { VerifyJob, VerifyResult } from '../agents/runner';

describe('hosted verification result', () => {
  it.each([['npm test'], [], undefined])('carries baseline %j through both RPC copies to the queue', async failing => {
    const fixture = storageFixture();
    const job: VerifyJob = { id: 'audit-batch', repo: 'repo', remote: 'https://git.test/repo.git', commit: 'b'.repeat(40), baseline: 'a'.repeat(40), checks: ['npm test'], timeoutMs: 1000 };
    const result: VerifyResult = {
      id: job.id, commit: job.commit, status: 'failed',
      checks: [{ command: 'npm test', exitCode: 1, durationMs: 1, output: 'failed', truncated: false, phase: 'check' }],
      startedAt: '2026-10-13T12:00:00Z', finishedAt: '2026-10-13T12:00:01Z',
      ...(failing ? { baseline: { commit: job.baseline!, failing } } : {}),
    };
    const sandboxDisposed = vi.fn(), rpcDisposed = vi.fn(), verified = vi.fn();
    const env = {} as BraidEnv;
    Object.assign(fixture.ctx, { exports: { AgentSandbox: { getByName: () => ({ verify: async () => ({ ...result, [Symbol.dispose]: sandboxDisposed }) }) } } });
    const trunk = new Trunk(fixture.ctx, env);
    let intermediate: VerifyResult;
    Object.assign(env, { TRUNKS: { getByName: () => ({
      runVerification: async (repository: string, job: VerifyJob) => {
        intermediate = await trunk.runVerification(repository, job);
        return { ...intermediate, [Symbol.dispose]: rpcDisposed };
      }, verified,
    }) } });
    const step = { do: async (_name: string, config: unknown, callback: (ctx: unknown) => Promise<unknown>) => structuredClone(await callback({ attempt: 1, config })) };
    try {
      const workflow = new VerifyWorkflow({} as never, env);
      await workflow.run({ payload: { repository: 'audit', batchId: job.id, job } } as never, step as never);
      expect(verified).toHaveBeenCalledWith('audit', job.id, result);
      expect(intermediate!.baseline).toEqual(result.baseline);
      if (result.baseline) {
        expect(intermediate!.baseline).not.toBe(result.baseline);
        expect(intermediate!.baseline!.failing).not.toBe(result.baseline.failing);
      }
      expect(sandboxDisposed).toHaveBeenCalledOnce();
      expect(rpcDisposed).toHaveBeenCalledOnce();
    } finally { fixture.db.close(); }
  });
});

describe('verification that could not run', () => {
  const job: VerifyJob = { id: 'audit-error', repo: 'repo', remote: 'https://git.test/repo.git', commit: 'b'.repeat(40), checks: ['npm test'], timeoutMs: 1000 };
  /** Runs a step as Workflows does: retries what it throws, then rethrows only the last error's text. */
  const step = { do: async (_name: string, config: { retries: { limit: number } }, callback: (ctx: unknown) => Promise<unknown>) => {
    for (let attempt = 1; ; attempt++) {
      try { return structuredClone(await callback({ attempt, config })); }
      catch (error) { if (attempt > config.retries.limit) throw new Error((error as Error).message); }
    }
  } };
  async function run(runVerification: () => Promise<unknown>) {
    const verified = vi.fn(), calls = vi.fn(runVerification);
    const env = { TRUNKS: { getByName: () => ({ runVerification: calls, verified }) } } as unknown as BraidEnv;
    await new VerifyWorkflow({} as never, env).run({ payload: { repository: 'audit', batchId: job.id, job } } as never, step as never);
    return { result: verified.mock.calls[0][2] as VerifyResult, attempts: calls.mock.calls.length };
  }

  it("retries, then reports the runner's own reason", async () => {
    const at = '2026-10-13T12:00:00Z';
    const { result, attempts } = await run(async () => ({ id: job.id, commit: job.commit, status: 'error', checks: [], startedAt: at, finishedAt: at,
      error: 'The repository could not be cloned for verification.', [Symbol.dispose]: () => {} }));
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ status: 'error', error: 'The repository could not be cloned for verification.' });
  });

  it('never reports what a failed call said', async () => {
    const { result } = await run(async () => { throw new Error('internal error; reference = 7f3k2 durable object reset'); });
    expect(result).toMatchObject({ status: 'error', error: 'Verification could not run.' });
  });
});
