import { useState } from 'react';
import { useKumoToastManager } from '@cloudflare/kumo';
import type { ExecutionMode, Mission } from '../../../shared/types';
import { api, errorMessage, type AgentCount, type HostedRunner, type MissionInput } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/hooks';
import { navigate, paths } from '../../lib/router';
import { canWrite, newMissionBlocker, useWorkspace } from '../../store/workspace';

interface NewTaskDraft {
  title?: string;
  intent: string;
  execution: ExecutionMode;
  agentCount?: AgentCount;
  connectionIds?: string[];
  provider?: HostedRunner;
  timeBudgetMinutes?: number;
}

/**
 * Starting a task, shared by the box the Agents tab opens on and the New task dialog: who may
 * start one here, which agents can take it, and the one request with its idempotency key.
 * In the recorded example every brief replays the sample task.
 */
export function useNewTask() {
  const { snapshot, refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = newMissionBlocker(snapshot);
  // Whether this person may start tasks here at all, apart from a passing merge.
  const writable = canWrite(snapshot);
  const demo = snapshot?.capabilities.mode === 'demo';
  const sample: Mission | null = (demo && snapshot?.missions.find((mission) => mission.source === 'demo')) || null;
  const cloudReady = !!snapshot?.capabilities.ai;
  const localReady = snapshot?.capabilities.identity?.provider !== 'owner-key';

  const start = async (draft: NewTaskDraft): Promise<boolean> => {
    if (busy) return false;
    const intent = draft.intent.trim();
    const local = !demo && draft.execution === 'local';
    const input: MissionInput = {
      title: draft.title?.trim() || intent.split('\n')[0].slice(0, 120),
      intent,
      execution: demo ? 'cloud' : draft.execution,
      ...(demo ? {} : { agentCount: local ? (draft.connectionIds?.length || 1) as AgentCount : (draft.agentCount ?? 1) }),
      ...(local && draft.connectionIds?.length ? { connectionIds: draft.connectionIds } : {}),
      ...(!demo && !local && draft.provider && draft.provider !== 'workers-ai' ? { provider: draft.provider } : {}),
      ...(!demo && !local && draft.timeBudgetMinutes ? { timeBudgetMinutes: draft.timeBudgetMinutes } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const { missionId } = await api.createMission(input, attempt.key(input));
      attempt.settle();
      toasts.add({ title: demo ? 'Recorded replay started' : local ? 'Task created for your agent' : 'Agents started', description: input.title });
      navigate(paths.task(missionId));
      void refresh();
      return true;
    } catch (err) {
      attempt.settle(err);
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { blocker, writable, demo, sample, cloudReady, localReady, busy, error, start };
}
