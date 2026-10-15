import type { InferOutput } from 'valibot';
import type { AgentCheck } from '../../shared/types';
import { proposalChecks } from './domain';
import { HttpError } from '../errors';
import { checkSize, localSubmission } from '../schemas';
import { outputTail } from '../changes/evidence';

export type LocalSubmission = InferOutput<typeof localSubmission>;

/**
 * A proposal from a local agent or a sandbox, with the checks that say what
 * Braid did and did not verify. A command the agent shows failing blocks the
 * task like a failed test report; its evidence goes on to the task's change.
 */
export function localProposal(input: LocalSubmission, baseCommit: string) {
  if (input.baseCommit !== baseCommit) throw new HttpError(409, 'This proposal uses a different base commit. Check out this task again.');
  checkSize(input.files);
  const proposal = { summary: input.summary, rationale: input.rationale, files: input.files };
  const checks: AgentCheck[] = proposalChecks(proposal, ['*']);
  checks.push({ kind: 'local', label: 'Local execution', status: 'warning', detail: 'Code and test reports came from a local agent. Braid did not execute project commands.' });
  for (const report of input.tests) checks.push({ kind: 'report', label: `Local report: ${report.command}`, status: report.result === 'failed' ? 'failed' : 'warning', detail: `Agent-reported ${report.result}; not independently verified by Braid.${report.detail ? ` ${report.detail}` : ''}` });
  for (const run of input.evidence) if (run.kind === 'command') checks.push({ kind: 'run', label: `Local run: ${run.command}`, status: run.exitCode === 0 ? 'warning' : 'failed',
    detail: `Exited with ${run.exitCode} on the agent's machine; not independently verified by Braid.${run.exitCode && run.output ? `\n${outputTail(run.output)}` : ''}` });
  return { proposal, model: input.model, checks, evidence: input.evidence };
}
