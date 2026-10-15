import { useState } from 'react';
import type { ProviderId } from '../../../shared/providers';
import { Button, useKumoToastManager } from '@cloudflare/kumo';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import type { Mission } from '../../../shared/types';
import { api, type AgentCount } from '../../lib/api';
import { plural } from '../../lib/format';
import { navigate, paths } from '../../lib/router';
import { newMissionBlocker, useSnapshot, useWorkspace } from '../../store/workspace';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/** What the new task dialog opens with when a task starts again: its brief and the same agents, connected or Braid's. */
export type MissionDraft = Pick<Mission, 'title' | 'intent' | 'execution'> & { agentCount?: AgentCount; connectionIds?: string[]; provider?: ProviderId; timeBudgetMinutes?: number };

/** Starts a new task with the same brief from the latest commit. */
export function StartAgain({ mission, onRestart, variant }: { mission: Mission; onRestart: (draft: MissionDraft) => void; variant: 'primary' | 'secondary' }) {
  const snapshot = useSnapshot();
  const blocker = newMissionBlocker(snapshot);
  const reason = mission.agents.find(agent => agent.environment?.status === 'failed')?.environment?.failure;
  const moreTime = reason?.action === 'more_time' && (mission.timeBudgetMinutes ?? 27) < 54;
  return (
    <span title={blocker ?? undefined}>
      <Button
        variant={variant}
        icon={ArrowCounterClockwiseIcon}
        disabled={!!blocker}
        onClick={() => onRestart({ title: mission.title, intent: mission.intent, execution: mission.execution, agentCount: mission.agents.length >= 1 && mission.agents.length <= 3 ? (mission.agents.length as AgentCount) : 1, connectionIds: mission.agents.flatMap((agent) => (agent.connection ? [agent.connection.id] : [])), ...(mission.agents[0]?.provider ? { provider: mission.agents[0].provider } : {}), ...(moreTime ? { timeBudgetMinutes: Math.min(54, (mission.timeBudgetMinutes ?? 27) * 2) } : mission.timeBudgetMinutes ? { timeBudgetMinutes: mission.timeBudgetMinutes } : {}) })}
      >
        {moreTime ? 'Retry with more time' : reason ? 'Retry' : 'Start again'}
      </Button>
    </span>
  );
}

/** Keeps the finished proposals of a task whose other agents did not finish, and closes the rest. */
export function UseCompletedWork({ mission }: { mission: Mission }) {
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  // Capture exactly the proposals the owner saw. A late submission requires a new confirmation.
  const [selection, setSelection] = useState<string[] | null>(null);
  const completed = mission.agents.filter((agent) => agent.status === 'review');
  return (
    <>
      <Button variant="primary" onClick={() => setSelection(completed.map((agent) => agent.id))}>
        Use completed work
      </Button>
      <ConfirmDialog
        open={selection !== null}
        title="Continue with completed work?"
        description={`Keep ${plural(selection?.length ?? completed.length, 'finished proposal')} and close the remaining agents.`}
        confirmLabel="Continue"
        variant="primary"
        onClose={() => setSelection(null)}
        onConfirm={async () => {
          const updated = await api.finishMission(mission.id, selection!);
          toasts.add({ title: 'Kept the finished work', description: mission.title });
          await refresh();
          navigate(paths.task(updated.id));
        }}
      />
    </>
  );
}
