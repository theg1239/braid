import type { AgentFailureStage } from '../../shared/types';
import { shown, ShownError } from '../errors';
import { GitError } from '../git/transport';

// Fixed messages survive the sandbox RPC boundary; never expose provider or command output.
export const hostedErrors = {
  capacity: 'Workers AI is temporarily at capacity. No proposal was published. Choose Start again to retry.',
  timeout: 'Workers AI did not answer in time. No proposal was published. Choose Start again to retry.',
  quota: 'Workers AI has reached its usage limit. No proposal was published. Choose Start again and select another agent.',
  configuration: 'Workers AI cannot run the configured model. No proposal was published. Choose Start again and select another agent.',
  context: 'The task exceeded the model input limit. No proposal was published. Choose Start again with a smaller task.',
  unavailable: 'Workers AI could not answer this task. No proposal was published. Choose Start again to retry.',
  response: 'Workers AI returned an invalid response. No proposal was published. Choose Start again to retry.',
  tool: 'Workers AI returned an invalid tool call. No proposal was published. Choose Start again to retry.',
  empty: 'The agent finished without changed files. No proposal was published. Choose Start again to retry.',
  limit: 'The changes exceed the 256-file or 3 MiB review limit. No proposal was published. Choose Start again with a smaller task.',
  binary: 'The changes contain binary or non-UTF-8 files that Braid cannot review. No proposal was published. Choose Start again with a text-only task.',
  protected: 'The agent changed protected files or file types. No proposal was published. Choose Start again to retry.',
  credential: 'The changes may contain credentials. No proposal was published. Choose Start again to retry.',
  race: 'The checkout changed during collection. No proposal was published. Choose Start again to retry.',
  collectionTimeout: 'Sandbox collection timed out. No proposal was published. Choose Start again to retry.',
  collectionTruncated: 'Sandbox collection output was truncated. No proposal was published. Choose Start again to retry.',
  collectionInvalid: 'Sandbox collection returned an invalid result. No proposal was published. Choose Start again to retry.',
  collectionCommand: 'The sandbox collection command failed. No proposal was published. Choose Start again to retry.',
} as const;

const stages: Record<AgentFailureStage, string> = {
  authorization: 'Owner authorization could not be verified. Reconnect as an owner before retrying.',
  fork: 'The isolated Git workspace could not be prepared. Check Artifacts availability before retrying.',
  generation: 'The hosted agent stopped before returning a proposal. Choose Start again to retry.',
  validation: 'The proposal did not meet the repository requirements. No changes were committed.',
  publish: 'The proposal could not be committed to its isolated Git fork. Check repository access before retrying.',
};

/** A failure on an agent's own run whose fixed message is safe to show, without an HTTP status of its own. */
export class AgentError extends ShownError {}

/** Git refusals whose text tells the person what to do; other Git faults read as the stage that failed. */
const shownGit = new Set<GitError['code']>(['moved', 'rejected', 'full', 'redirect', 'too_large']);

export function agentFailure(error: unknown, stage: AgentFailureStage): string {
  return error instanceof GitError && !shownGit.has(error.code) ? stages[stage] : shown(error, stages[stage]);
}
