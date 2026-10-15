import type { HostedFailureCause } from './types';
export const hostedCauseLabel: Record<HostedFailureCause, string> = {
  container_start: 'container start', image_pull: 'image pull', out_of_memory: 'out of memory', process_killed: 'process killed',
  disk_full: 'disk full', install_failed: 'setup failed', network: 'network unavailable', timeout: 'time limit', provider: 'model provider',
  collection: 'collecting changes', workflow_step: 'workflow step', preflight: 'setup required', command: 'command failed', interrupted: 'interrupted command',
};
