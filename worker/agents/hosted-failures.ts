import * as v from 'valibot';
import type { HostedEnvironment, HostedFailure, HostedFailureCause } from '../../shared/types';
import { hostedCauseLabel } from '../../shared/hosted';
import { hostedRuntimeError } from '../schemas';
import { hostedOutput, redactHostedText } from './hosted-output';
import { now } from '../workspace/domain';
import type { CommandResult } from './container';
import { duration, type HostedTiming } from './hosted-limits';

export const HOSTED_RETRIES = 3;
export class HostedFailureError extends Error {
  constructor(readonly failure: HostedFailure) { super(failure.message); this.name = 'HostedFailureError'; }
}
const messages: Record<HostedFailureCause, string> = {
  container_start: 'The container could not start.', image_pull: 'The container image could not be pulled.',
  out_of_memory: 'The container ran out of memory.', process_killed: 'The process was killed by SIGKILL. The runtime did not confirm an out-of-memory failure.',
  disk_full: 'The sandbox disk is full.', install_failed: 'The setup command failed.', network: 'The sandbox network request failed.',
  timeout: 'The run reached its time limit.', provider: 'The model provider could not complete the request.',
  collection: 'The sandbox changes could not be collected safely.', workflow_step: 'The workflow step failed.',
  preflight: 'Repository setup is incomplete.', command: 'The sandbox command failed.',
  interrupted: 'The command was interrupted before its result was saved. It was not repeated.',
};
const NETWORK_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT']);
export function failure(cause: HostedFailureCause, phase: HostedFailure['phase'], evidence: HostedFailure['evidence'] & HostedTiming, output = '', message = messages[cause]): HostedFailure {
  const operation = redactHostedText(evidence.operation).replaceAll('\n', ' ').slice(0, 400);
  if (cause === 'timeout' && evidence.timeoutMs !== undefined) {
    const limit = duration(evidence.timeoutMs);
    // The operation stays in the evidence: a long command would bury the sentence.
    const subject = { task: 'The task', command: 'The command', model: 'The model request', transport: 'The sandbox connection' }[evidence.limitKind ?? 'command'];
    message = `${subject} reached its ${limit} limit. ${evidence.limitKind === 'model' || evidence.limitKind === 'transport' ? 'Retry the task.' : 'Retry with more time.'}`;
  }
  return { cause, phase, message, action: cause === 'timeout' && evidence.limitKind !== 'model' && evidence.limitKind !== 'transport' ? 'more_time' : cause === 'install_failed' || cause === 'preflight' ? 'edit_setup' : 'retry',
    retryable: ['container_start', 'image_pull', 'network', 'workflow_step'].includes(cause),
    evidence: { ...evidence, operation }, output: hostedOutput(output), at: now() };
}
/** The operation is evidence too: a rejected start is a start failure, with no invented subtype. */
export function runtimeFailure(error: unknown, phase: HostedFailure['phase'], operation: string): HostedFailure {
  if (error instanceof HostedFailureError) return error.failure;
  const parsed = v.safeParse(hostedRuntimeError, error);
  const data = parsed.success ? parsed.output : {};
  const code = typeof data.code === 'string' ? data.code : undefined;
  const signal = data.signal === 'SIGKILL' ? 9 : data.signal;
  const cause: HostedFailureCause = data.oomKilled === true ? 'out_of_memory' : signal === 9 ? 'process_killed'
    : code === 'ENOSPC' ? 'disk_full'
    : code && NETWORK_CODES.has(code) ? 'network'
    : data.name === 'ImagePullError' || code === 'ImagePullError' ? 'image_pull'
    : phase === 'start' ? 'container_start' : phase === 'workflow' ? 'workflow_step' : 'command';
  return failure(cause, phase, { source: phase === 'workflow' ? 'workflow' : 'container', operation,
    ...(data.name === 'ImagePullError' ? { reason: data.name } : {}),
    ...(code ? { code } : {}), ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}), ...(data.oomKilled !== undefined ? { oomKilled: data.oomKilled } : {}),
  });
}
export function commandFailure(result: CommandResult, phase: HostedFailure['phase'], operation: string): HostedFailure | undefined {
  if (result.exitCode === 0 && !result.signal && !result.code && !result.timedOut) return;
  const cause = result.timedOut ? 'timeout' : result.oomKilled ? 'out_of_memory' : result.signal === 9 ? 'process_killed' : result.code === 'ENOSPC' || result.diskFull ? 'disk_full'
    : result.code && NETWORK_CODES.has(result.code) ? 'network'
    : phase === 'setup' ? 'install_failed' : 'command';
  return failure(cause, phase, { source: 'process', operation, exitCode: result.exitCode, truncated: result.truncated,
    ...(result.signal !== undefined ? { signal: result.signal } : {}), ...(result.code ? { code: result.code } : {}),
    ...(result.timedOut ? { timedOut: true, limitKind: 'command' as const } : {}), ...(result.oomKilled ? { oomKilled: true } : {}),
    ...(result.timeoutMs !== undefined ? { timeoutMs: result.timeoutMs } : {}), ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    ...(result.diskFull ? { diskAvailableBytes: 0 } : {}),
  }, result.outputTail ?? `${result.stdout}\n${result.stderr}`);
}
export function retryDelay(reason: HostedFailure, retries: number, deadline: number): number | null {
  if (!reason.retryable || retries >= HOSTED_RETRIES) return null;
  const delay = Math.max(1000 * 2 ** retries, reason.evidence.retryAfterMs ?? 0);
  // Do not retry *earlier* than Retry-After, or extend the task's execution budget.
  return delay > 60_000 || Date.now() + delay >= deadline ? null : delay;
}
export interface HostedRetryOptions {
  deadline: number; phase: HostedFailure['phase']; operation: string;
  report: (message: string, environment: HostedEnvironment) => Promise<unknown>;
  authorize: () => Promise<unknown>;
  /** Persist counts under the existing task identity; a replay cannot replenish them. */
  attempts?: { read(): number; write(value: number): void };
  sleep?: (ms: number) => Promise<void>;
}
export async function retryHosted<T>(run: () => Promise<T>, options: HostedRetryOptions): Promise<T> {
  let retries = options.attempts?.read() ?? 0;
  let recovered: HostedFailure | undefined;
  for (;;) {
    await options.authorize();
    let result: T;
    try { result = await run(); }
    catch (error) {
      const reason = runtimeFailure(error, options.phase, options.operation);
      const timing: HostedFailure['evidence'] & HostedTiming = reason.evidence;
      console.warn(JSON.stringify({ event: 'hosted_operation_failed', cause: reason.cause, phase: reason.phase, retries,
        limitKind: timing.limitKind, timeoutMs: timing.timeoutMs, elapsedMs: timing.elapsedMs,
        exitCode: reason.evidence.exitCode, code: reason.evidence.code, status: reason.evidence.status, providerCode: reason.evidence.providerCode }));
      const delay = retryDelay(reason, retries, options.deadline);
      if (delay === null) {
        await options.report(reason.message, { status: 'failed', failure: reason });
        throw new HostedFailureError(reason);
      }
      retries++; options.attempts?.write(retries);
      recovered = reason;
      await options.report(`Retried ${retries} of ${HOSTED_RETRIES} · ${hostedCauseLabel[reason.cause]}`, {
        status: 'retrying', failure: reason, retry: { attempt: retries, limit: HOSTED_RETRIES, nextAt: new Date(Date.now() + delay).toISOString() },
      });
      await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      await options.authorize();
      await options.report(`Retrying · ${hostedCauseLabel[reason.cause]}`, { status: 'running' });
      continue;
    }
    if (recovered) await options.report(`Recovered after ${retries} ${retries === 1 ? 'retry' : 'retries'} · ${hostedCauseLabel[recovered.cause]}`, {
      status: 'running', recovered: { cause: recovered.cause, attempts: retries },
    });
    return result;
  }
}
