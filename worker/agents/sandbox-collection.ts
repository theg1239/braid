import * as v from 'valibot';
import { hostedErrors } from './errors';
import type { CommandResult } from './container';
import { collectedFiles, checkSize, hostedCollectionFailure } from '../schemas';
import { commandFailure, failure, HostedFailureError } from './hosted-failures';

const repairs = {
  empty: 'Implement the requested changes before finishing.',
  limit: 'Reduce the proposal to 256 text files and 3 MiB. Remove generated output from the changes.',
  binary: 'Remove binary or non-UTF-8 changes from the proposal.',
  protected: 'Restore changes to protected paths, symlinks and submodules.',
  credential: 'Remove credentials from the changed content.',
  race: 'Stop background writers and finish edits before calling finish.',
} as const;
const collectionFailure = v.pipe(v.string(), v.parseJson(), hostedCollectionFailure);
export class SandboxCollectionError extends HostedFailureError {
  constructor(reason: keyof typeof hostedErrors, readonly repair?: string, result?: CommandResult) {
    super(failure('collection', 'collection', { source: 'collector', operation: 'collect changes', reason,
      ...(result ? { exitCode: result.exitCode, truncated: result.truncated, ...(result.timedOut ? { timedOut: true } : {}) } : {}) }, result?.outputTail ?? result?.stderr ?? '', hostedErrors[reason]));
    if (reason === 'collectionTimeout') this.failure.action = 'more_time';
  }
}
export function collectSandboxResult(result: CommandResult) {
  const fail = (reason: keyof typeof hostedErrors, repair?: string): never => {
    console.warn(JSON.stringify({ event: 'sandbox_collection_failed', reason, exitCode: result.exitCode, truncated: result.truncated,
      stdoutBytes: new TextEncoder().encode(result.stdout).length, stderrBytes: new TextEncoder().encode(result.stderr).length }));
    throw new SandboxCollectionError(reason, repair, result);
  };
  if (result.timedOut) return fail('collectionTimeout');
  const environment = commandFailure(result, 'collection', 'collect changes');
  if (environment && environment.cause !== 'command') throw new HostedFailureError(environment);
  if (result.truncated) return fail('collectionTruncated');
  if (result.exitCode !== 0) {
    const parsed = v.safeParse(collectionFailure, result.stdout);
    if (!parsed.success) return fail('collectionCommand');
    const { reason, ...evidence } = parsed.output.collectionFailure;
    result = { ...result, ...evidence };
    const problem = commandFailure(result, 'collection', 'collector git command');
    if (problem && problem.cause !== 'command') throw new HostedFailureError(problem);
    if (reason === 'invalid') return fail('collectionInvalid');
    if (reason === 'command') return fail('collectionCommand');
    return fail(reason, repairs[reason]);
  }
  const parsed = v.safeParse(collectedFiles, result.stdout);
  if (!parsed.success) return fail('collectionInvalid');
  try { checkSize(parsed.output); } catch { return fail('limit', repairs.limit); }
  return parsed.output;
}
