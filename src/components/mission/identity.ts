import type { Agent, Mission } from '../../../shared/types';
import { modelName } from '../../../shared/models';
import { personHandle } from '../../../shared/people';

export const agentName = (agent: Agent): string => agent.model ? modelName(agent.model) : agent.name;
export function agentByline(agent: Agent): string {
  return `${agentName(agent)}${agent.owner ? ` for ${personHandle(agent.owner)}` : ''}`;
}

/** Stored Git paths stay intact; the task record is presented by its model. */
export function recordLabel(mission: Mission, filename: string): string {
  const agent = mission.agents.find(agent => filename === `${agent.id}.md`);
  return agent ? `${agentName(agent)}.md` : filename;
}
