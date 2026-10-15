import type { HostedFailure } from '../../../shared/types';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../../../shared/providers';
import type { HostedTiming } from '../../../worker/agents/hosted-limits';
import { plural } from '../../lib/format';

export function hostedRecovery(reason: HostedFailure) {
  if (reason.evidence.source === 'provider' && ['revoked', 'auth', 'forbidden', 'model', 'quota', 'invalid'].includes(reason.evidence.code ?? '')) return 'providers';
  if (['missing_context', 'invalid_inspection'].includes(reason.evidence.reason ?? '')) return 'retry';
  return reason.action;
}

/** One cause and one useful next action, derived only from the failure contract. The operation, which can be a long
 * command, never enters the sentence: the run shows it once, beside the evidence. */
export function hostedFailureLine(reason: HostedFailure) {
  const { cause, phase } = reason;
  const e: HostedFailure['evidence'] & HostedTiming = reason.evidence;
  if (cause === 'timeout') {
    const limit = e.timeoutMs === undefined ? '' : e.timeoutMs >= 60_000 && e.timeoutMs % 60_000 === 0 ? `${e.timeoutMs / 60_000}-minute ` : `${Math.ceil(e.timeoutMs / 1000)}-second `;
    if (e.limitKind === 'task') return `The task reached its ${limit}limit. Retry with more time.`;
    const within = e.timeoutMs === undefined ? ' in time' : ` within ${e.timeoutMs >= 60_000 && e.timeoutMs % 60_000 === 0 ? plural(e.timeoutMs / 60_000, 'minute') : plural(Math.ceil(e.timeoutMs / 1000), 'second')}`;
    if (e.limitKind === 'transport') return `The sandbox did not answer${within}. Retry the task.`;
    if (e.limitKind === 'model' || phase === 'model') return `The model did not answer${within}. Retry the task.`;
    return `The command ran past its ${limit}limit. Retry with more time.`;
  }
  const provider = PROVIDER_IDS.includes(e.operation as ProviderId) ? PROVIDERS[e.operation as ProviderId].name : 'The model provider';
  if (e.source === 'provider') {
    const messages: Record<string, string> = {
      revoked: 'The provider connection is missing. Connect a key in Settings → Providers and retry.',
      auth: `${provider} rejected the key. Reconnect it in Settings → Providers and retry.`,
      forbidden: `${provider} refused the model. Check key access in Settings → Providers.`,
      model: `${provider} could not use the model. Choose another in Settings → Providers.`,
      quota: `${provider} has no credit or quota left. Add credit and retry.`,
      rate_limit: `${provider} rate-limited the request. Retry after the limit resets.`,
      context: `${provider} could not fit the task in its context. Start again with a smaller task.`,
      invalid: e.status ? `${provider} rejected the request (HTTP ${e.status}). Check model access in Settings → Providers.` : `${provider} returned an unusable answer. Choose another model in Settings → Providers and retry.`,
      unavailable: `${provider} could not be reached. Retry shortly.`,
    };
    if (e.code && messages[e.code]) return messages[e.code];
  }
  if (e.reason === 'authorization') return 'Owner authorization failed. Sign in with repository access and retry.';
  if (e.reason === 'fork') return 'The repository fork could not be prepared. Check repository access and retry.';
  if (e.reason === 'validation') return 'The proposal failed validation. Review the task requirements and retry.';
  if (e.reason === 'publish') return 'The proposal could not be published. Check repository access and retry.';
  if (e.reason === 'generation') return 'The agent stopped while preparing its changes. Retry the task.';
  if (e.reason === 'launch') return 'The task workflow could not start. Retry the task.';
  if (e.reason === 'missing_context') return 'The saved task context is missing. Start a new task.';
  if (e.reason === 'turn_limit') return 'The agent reached its turn limit. Start again with a smaller task.';
  if (e.reason === 'check_limit') return 'The agent reached its check limit. Start again with a smaller task.';
  if (e.reason === 'missing_configuration') return 'Repository policy is invalid. Fix .braid/policy.json in Settings → Rules and retry.';
  if (e.reason === 'invalid_inspection') return 'Repository manifests could not be read. Retry with an updated sandbox image.';
  if (e.reason === 'missing_binding_or_image') return 'The sandbox is not configured. Connect a local agent or enable containers.';
  if (e.reason === 'invalid_tool') return 'The model returned invalid tool arguments. Retry or choose another model in Settings → Providers.';
  if (e.reason === 'invalid_response' || e.reason === 'empty_response') return 'The model returned no usable answer. Retry or choose another model in Settings → Providers.';
  if (e.source === 'collector') {
    const collection: Record<string, string> = {
      empty: 'The agent produced no changed files. Clarify the task and retry.',
      limit: 'The changes exceed the text review limit. Start again with a smaller task.',
      binary: 'The changes include binary files. Start again with a text-only task.',
      protected: 'The agent changed protected paths or file types. Adjust the task and retry.',
      credential: 'The changes may contain credentials. Remove the secrets and retry.',
      race: 'Files changed during collection. Stop background writers and retry.',
      collectionTimeout: 'Collecting changes timed out. Retry with more time.',
      collectionTruncated: 'The collected changes exceeded the output limit. Start again with a smaller task.',
      collectionInvalid: 'The collector returned invalid changes. Retry with an updated sandbox image.',
      collectionCommand: 'The collector command failed. Retry the task.',
    };
    if (e.reason && collection[e.reason]) return collection[e.reason];
  }
  const action = reason.action === 'more_time' ? 'Retry with more time.' : reason.action === 'edit_setup' ? 'Edit setup commands and retry.' : 'Retry the task.';
  if (e.reason === 'check_failed') return 'The check failed. Fix the check and retry.';
  if (phase === 'checkout' && cause === 'command') return 'Repository checkout failed. Check repository access and retry.';
  const messages: Record<HostedFailure['cause'], string> = {
    container_start: 'The sandbox could not start.', image_pull: 'The sandbox image could not be downloaded.',
    out_of_memory: 'The sandbox ran out of memory. Reduce the task or its parallelism and retry.',
    process_killed: 'The sandbox process was killed.', disk_full: 'The sandbox disk filled up. Reduce generated files and retry.',
    install_failed: 'The setup command failed.', network: 'A sandbox network request failed.',
    timeout: phase === 'model' ? 'The model request timed out.' : 'The task ran out of time.',
    provider: 'The model provider could not complete the request.', collection: 'The changed files could not be collected.',
    workflow_step: 'The task workflow stopped.', preflight: 'Repository setup could not be read.',
    command: 'The command failed.', interrupted: 'The sandbox was interrupted.',
  };
  if (cause === 'out_of_memory' || cause === 'disk_full') return messages[cause];
  return `${messages[cause]} ${action}`;
}
