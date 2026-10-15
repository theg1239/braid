import { accountApi, type AgentConnection } from '../../account/api';
import { useRepository } from '../../account/RepositoryGate';
import { useLive } from '../../lib/live';

/** A connection is a tool on a machine; its model is learned when it submits work. These can take a task here now. */
export function taskConnections(connections: AgentConnection[], workspaceId: string | null, now: number): AgentConnection[] {
  return connections.filter(connection => (connection.workspaceId === workspaceId || connection.workspaceId === '*') && connection.scope === 'work' && connection.expires > now);
}

/** The person's connected agents for this repository, read only for someone who may start a task here. */
export function useTaskConnections(enabled: boolean) {
  const { scope } = useRepository();
  const live = useLive(enabled && scope ? `task-connections:${scope}` : null, accountApi.connections, 30_000);
  return { ...live, data: live.data ? taskConnections(live.data, scope, Date.now()) : null };
}
