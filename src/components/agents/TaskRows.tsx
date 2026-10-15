import { memo, type ComponentType } from 'react';
import { CheckCircleIcon, ClockIcon, GitMergeIcon, GitPullRequestIcon, MinusCircleIcon, QuestionIcon, WarningCircleIcon, XCircleIcon, type IconProps } from '@phosphor-icons/react';
import type { Mission } from '../../../shared/types';
import { pullState, statusLabel } from '../../lib/changes';
import { isMissionActive, isStopped } from '../../lib/task-state';
import { missionPhase, phaseLabel, taskChange, taskNeedsYou, taskStats } from '../../lib/derive';
import { plural } from '../../lib/format';
import { paths } from '../../lib/router';
import { Label } from '../pulls/Bits';
import { RouterLink } from '../ui/Link';
import { Stats } from '../ui/Status';
import { RelativeTime } from '../ui/Time';

/*
 * Tasks as the pull request list draws them: one state icon in colour, the title, who worked
 * on it by model, what changed, its pull request and its age. A task that waits for the person
 * carries the reason as a label; everything else says its state through the icon and the time.
 */

type TaskState = 'decide' | 'blocked' | 'ready' | 'working' | 'open' | 'merged' | 'closed' | 'failed' | 'stopped';
export type TaskFilter = 'all' | 'needs' | 'running';

export function taskMatches(mission: Mission, head: string, filter: TaskFilter): boolean {
  return filter === 'all' || (filter === 'needs' ? taskNeedsYou(mission, head) : isMissionActive(mission) && !taskNeedsYou(mission, head));
}

/** What the one mark on a row shows: what the task waits for, or how it ended. */
export function taskState(mission: Mission, head: string): TaskState {
  const phase = missionPhase(mission, head);
  if (phase === 'failed') return isStopped(mission) ? 'stopped' : 'failed';
  // A submitted task is its pull request: open, merged or closed.
  if (phase === 'submitted') return pullState(taskChange(mission)?.status ?? 'queued');
  return phase === 'merged' || phase === 'decide' || phase === 'blocked' || phase === 'ready' ? phase : 'working';
}

const ICON: Record<TaskState, { icon: ComponentType<IconProps>; weight: IconProps['weight'] }> = {
  decide: { icon: QuestionIcon, weight: 'fill' },
  blocked: { icon: WarningCircleIcon, weight: 'fill' },
  ready: { icon: CheckCircleIcon, weight: 'fill' },
  working: { icon: ClockIcon, weight: 'bold' },
  open: { icon: GitPullRequestIcon, weight: 'bold' },
  merged: { icon: GitMergeIcon, weight: 'bold' },
  closed: { icon: GitPullRequestIcon, weight: 'bold' },
  failed: { icon: XCircleIcon, weight: 'fill' },
  stopped: { icon: MinusCircleIcon, weight: 'bold' },
};

function TaskStateIcon({ state, label }: { state: TaskState; label: string }) {
  const { icon: Icon, weight } = ICON[state];
  return <Icon size={16} weight={weight} className="task-state" data-state={state} role="img" aria-label={label} />;
}

/** The verb before the time: how a finished task ended, or that it started. */
const VERB: Record<TaskState, string> = { decide: 'started', blocked: 'started', ready: 'started', working: 'started', open: 'started', merged: 'merged', closed: 'closed', failed: 'failed', stopped: 'stopped' };

/** When a task ended: its merge, or its last agent's last word. */
function endedAt(mission: Mission): string {
  if (mission.mergedAt) return mission.mergedAt;
  let latest = mission.createdAt;
  for (const agent of mission.agents) if (agent.completedAt && agent.completedAt > latest) latest = agent.completedAt;
  return latest;
}

/** Who worked on a task, by model: up to three names, then a count. */
function agentNames(mission: Mission): string | null {
  const names = [...new Set(mission.agents.map((agent) => agent.name))];
  if (!names.length) return null;
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** The person's tasks first, then the fleet's, then what is done; newest first within each. */
export function sortTasks(missions: Mission[], head: string): Mission[] {
  // Ranked once per task rather than once per comparison.
  return missions
    .map((mission) => ({ mission, rank: taskNeedsYou(mission, head) ? 0 : isMissionActive(mission) ? 1 : 2, at: Date.parse(mission.mergedAt ?? mission.createdAt) }))
    .sort((a, b) => a.rank - b.rank || b.at - a.at)
    .map(({ mission }) => mission);
}

/** What the header says: tasks still running, and tasks whose next move is the person's. */
export function taskCounts(missions: Mission[], head: string): { running: number; needs: number } {
  let running = 0;
  let needs = 0;
  for (const mission of missions) {
    if (taskNeedsYou(mission, head)) needs += 1;
    else if (isMissionActive(mission)) running += 1;
  }
  return { running, needs };
}

export const TaskRow = memo(function TaskRow({ mission, head, now, writable }: { mission: Mission; head: string; now: number; writable: boolean }) {
  const state = taskState(mission, head);
  const needs = taskNeedsYou(mission, head);
  const phase = phaseLabel(mission, head);
  const label = needs && !writable ? 'Needs the owner' : phase.label;
  const change = taskChange(mission);
  const stats = taskStats(mission);
  const names = agentNames(mission);
  const done = state === 'merged' || state === 'closed' || state === 'failed' || state === 'stopped';
  const when = done ? endedAt(mission) : mission.createdAt;
  const moving = change && (change.status === 'queued' || change.status === 'landing') ? statusLabel(change).label : null;
  return (
    <li className="pr" data-state={state}>
      <TaskStateIcon state={state} label={label} />
      <div className="pr__main">
        <div className="pr__title-row">
          <RouterLink href={paths.task(mission.id)} className="pr__title">
            {mission.title}
          </RouterLink>
          {needs ? <Label tone={phase.tone === 'error' ? 'danger' : 'warning'}>{label}</Label> : null}
        </div>
        <p className="pr__meta task__meta">
          {state === 'working' ? <span>{label}</span> : null}
          {names ? <span className="task__agents">{names}</span> : null}
          {stats.files ? <span>{plural(stats.files, 'file')}</span> : null}
          {change ? (
            <RouterLink href={paths.pull(change.number)} className="text-link">
              #{change.number}
            </RouterLink>
          ) : null}
          {moving ? <span>{moving}</span> : null}
          <span>
            {VERB[state]}{' '}
            <RelativeTime at={when} now={now} />
          </span>
        </p>
      </div>
      <span className="pr__right">{stats.files ? <Stats additions={stats.additions} deletions={stats.deletions} className="pr__stats" /> : null}</span>
    </li>
  );
});
