import type { Mission } from '../../shared/types';

/** A task's agents are working, or its result is merging. */
export function isMissionActive(mission: Mission): boolean {
  return mission.status === 'running' || mission.status === 'merging';
}

/** The owner stopped a local task. */
export function isStopped(mission: Mission): boolean {
  return mission.status === 'failed' && mission.cancelled === true;
}
