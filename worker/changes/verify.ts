import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { BraidEnv } from '../env';
import type { VerifyJob, VerifyResult } from '../agents/runner';
import { trunkOf } from './names';
import { now } from '../workspace/domain';

export interface VerifyParams { repository: string; batchId: string; job: VerifyJob }

/** Durable verification of one composed batch: run the checks, then report back to the landing queue. */
export class VerifyWorkflow extends WorkflowEntrypoint<BraidEnv, VerifyParams> {
  async run(event: WorkflowEvent<VerifyParams>, step: WorkflowStep) {
    const { repository, batchId, job } = event.payload;
    let result: VerifyResult;
    try {
      result = await step.do('run checks', { retries: { limit: 1, delay: '15 seconds' }, timeout: `${Math.ceil(job.timeoutMs / 60_000) + 15} minutes` }, async ({ attempt, config }) => {
        // The landing queue reaches the sandbox through its loopback export; a container object cannot have a second binding.
        using outcome = await trunkOf(this.env, repository).runVerification(repository, job);
        // Infrastructure errors are retried and never count against a change. The last attempt returns the runner's
        // reason as data, since a thrown error leaves the step as text.
        if (outcome.status === 'error' && attempt <= (config.retries?.limit ?? 0)) throw new Error('Verification could not run.');
        const plain: VerifyResult = { id: outcome.id, commit: outcome.commit, status: outcome.status, checks: outcome.checks.map(check => ({ ...check })), startedAt: outcome.startedAt, finishedAt: outcome.finishedAt,
          ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.baseline ? { baseline: { commit: outcome.baseline.commit, failing: [...outcome.baseline.failing] } } : {}) };
        return plain;
      });
    } catch {
      // A step that failed by throwing carries text Braid did not write, such as a platform error.
      const at = now();
      result = { id: job.id, commit: job.commit, status: 'error', checks: [], startedAt: at, finishedAt: at, error: 'Verification could not run.' };
    }
    await step.do('report result', { retries: { limit: 10, delay: '5 seconds', backoff: 'exponential' } },
      () => trunkOf(this.env, repository).verified(repository, batchId, result));
    return { status: result.status };
  }
}
