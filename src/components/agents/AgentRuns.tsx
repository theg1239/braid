import type { AgentRecord, ChangeSummary, Mission } from '../../../shared/types';
import { agentKey } from '../../../shared/models';
import { useNow } from '../../lib/hooks';
import { paths } from '../../lib/router';
import { useSnapshot } from '../../store/workspace';
import { agentDuration, durationLabel, taskDuration } from '../mission/timing';
import { RouterLink } from '../ui/Link';

/** Match actual provenance or linked PRs; a shared model name alone is not an identity. */
export function runsForAgent(record: AgentRecord, missions: Mission[], changes: ChangeSummary[]) {
  const ownChanges = new Set(changes.map(change => change.id));
  return missions.flatMap(mission => mission.agents.filter(agent =>
    (agent.change && ownChanges.has(agent.change.id)) || agentKey({ kind: 'agent', model: agent.model, owner: agent.owner, tool: agent.tool }) === record.id,
  ).map(agent => ({ mission, agent })));
}

export function AgentRuns({ record, changes }: { record: AgentRecord; changes: ChangeSummary[] }) {
  const { missions } = useSnapshot();
  const now = useNow();
  const runs = runsForAgent(record, missions, changes).flatMap(run => {
    const duration = agentDuration(run.agent, now);
    return duration === null ? [] : [{ ...run, duration, total: taskDuration(run.mission, now) }];
  });
  if (!runs.length) return <p className="quiet">No task run times recorded</p>;
  return <div className="agent-detail__runs">
    <strong>Task runs</strong>
    <ul>{runs.map(({ mission, agent, duration, total }) => <li key={`${mission.id}:${agent.id}`}>
      <RouterLink href={paths.task(mission.id)}>{mission.title}</RouterLink>
      <span>{durationLabel(duration)} agent{total !== null ? ` · ${durationLabel(total)} task` : ''}</span>
    </li>)}</ul>
  </div>;
}
