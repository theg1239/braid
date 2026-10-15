import type { ReactNode } from 'react';
import { Badge } from '@cloudflare/kumo';
import type { ExecutionMode, Mission } from '../../../shared/types';
import { taskStats } from '../../lib/derive';
import { plural } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { PhaseBadge, Stats } from '../ui/Status';
import { durationLabel, taskDuration } from './timing';
import { RelativeTime } from '../ui/Time';

export type TaskView = 'task' | 'review' | 'merge';
const VIEW_TITLE: Record<Exclude<TaskView, 'task'>, string> = { review: 'Compare code', merge: 'Combined result' };
/** Where a live task's agents ran; the recorded example's are simulated. */
const RUN_LABEL: Record<ExecutionMode, string> = { local: 'Local', cloud: 'Cloudflare' };

/** Task title under Agents, then one row of facts: the state, who, what changed, when. The two code views hang off the task, one level down. */
export function TaskHeader({ mission, head, view, action }: { mission: Mission; head: string; view: TaskView; action?: ReactNode }) {
  const now = useNow();
  const stats = taskStats(mission);
  const duration = taskDuration(mission, now);
  return (
    <header className="task-head">
      <div className="task-head__row">
        <nav aria-label="Breadcrumb" className="task-head__crumb">
          <RouterLink href={paths.agents()}>Agents</RouterLink>
          <span aria-hidden="true">/</span>
          {view !== 'task' ? (
            <>
              <RouterLink href={paths.task(mission.id)} className="task-head__parent">
                {mission.title}
              </RouterLink>
              <span aria-hidden="true">/</span>
            </>
          ) : null}
        </nav>
        <h1 className="task-head__title">{view === 'task' ? mission.title : VIEW_TITLE[view]}</h1>
        {action ? <span className="task-head__action">{action}</span> : null}
      </div>
      {view === 'task' ? (
        <>
          <p className="task-head__meta">
            <PhaseBadge mission={mission} head={head} />
            {mission.agents.length ? <span>{plural(mission.agents.length, 'agent')}</span> : null}
            {stats.files ? (
              <span>
                {plural(stats.files, 'file')} <Stats additions={stats.additions} deletions={stats.deletions} className="task-head__stats" />
              </span>
            ) : null}
            {duration !== null ? <span title="Time from the first agent starting to the last agent finishing">Run time {durationLabel(duration)}</span> : null}
            {/* A replay ran nowhere; the tour's Recorded banner says what it is. */}
            {mission.source === 'demo' ? null : <span>{RUN_LABEL[mission.execution]}</span>}
            <span>
              <RelativeTime at={mission.createdAt} now={now} />
            </span>
          </p>
          {mission.intent !== mission.title ? <p className="task-head__intent">{mission.intent}</p> : null}
        </>
      ) : null}
    </header>
  );
}
