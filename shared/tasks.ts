import type { Mission } from './types';

/** An owner can close unused local lanes, or recover completed work after a hosted run fails. */
export function canUseCompletedWork(mission: Mission): boolean {
  return mission.source === 'live'
    && (mission.status === 'failed' || (mission.status === 'running' && mission.execution === 'local'))
    && mission.agents.some(agent => agent.status === 'review' && agent.changes.length > 0)
    && mission.agents.some(agent => agent.status !== 'review' && agent.status !== 'skipped');
}

/** Skipped lanes remain in the task record but never enter the reviewed composition. */
export function includedAgents(mission: Mission) {
  return mission.agents.filter(agent => agent.status !== 'skipped');
}

export { changeIdentity } from './changes';
