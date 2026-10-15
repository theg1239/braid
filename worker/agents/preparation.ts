import * as v from 'valibot';
import type { AgentCheck } from '../../shared/types';
import { commandFailure, failure, HostedFailureError } from './hosted-failures';
import type { CommandResult } from './container';

export { preparation, repositoryInspection } from '../schemas';
import { preparation, repositoryInspection } from '../schemas';
export type Preparation = v.InferOutput<typeof preparation>;
export type RepositoryInspection = v.InferOutput<typeof repositoryInspection>;

/** Verification is repairable inside this checkout; its typed result is also the terminal failure after the repair budget. */
export class SandboxCheckError extends HostedFailureError {
  constructor(readonly checks: AgentCheck[], command: string, exitCode: number, output: string, result?: CommandResult) {
    super(result?.timedOut ? commandFailure(result, 'command', command)! : failure('command', 'command', { source: 'process', operation: command, exitCode, reason: 'check_failed' }, output, 'A repository check failed.'));
  }
}
