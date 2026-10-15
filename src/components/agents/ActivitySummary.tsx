import type { AgentActivityEvent, LocalActivityRun } from '../../../shared/agent-activity';
import { activityText, currentActivity, activityRunning } from '../../../shared/agent-activity';
import { personHandle } from '../../../shared/people';
import { RouterLink } from '../ui/Link';
import { paths } from '../../lib/router';
import { RelativeTime } from '../ui/Time';
import './activity.css';

export function ActivitySummary({ event }: { event: AgentActivityEvent }) {
  return <span>{activityText(event)}</span>;
}

/** Group a run's last edit, completed command and current observation into one quiet row. */
function runSummary(run: LocalActivityRun) {
  const current = currentActivity(run);
  const edit = run.events.findLast(event => event.kind === 'editing');
  const command = run.events.findLast(event => event.command && event.exitCode !== undefined);
  return [...new Set([edit, command, current].filter(event => !!event).map(activityText))].join(' · ');
}

function ActivityRow({ run, now, live = false }: { run: LocalActivityRun; now: number; live?: boolean }) {
  const last = currentActivity(run), stale = activityRunning(run) && now - Date.parse(run.lastSeenAt) > 45_000;
  const summary = live ? stale ? 'updates paused' : last ? activityText(last) : 'started' : runSummary(run);
  return <li className="local-activity__row">
    <div className="local-activity__identity"><strong>{run.agent.name}</strong><span>for {personHandle(run.agent.owner)}</span>{run.changeNumber ? <RouterLink className="text-link" href={paths.pull(run.changeNumber)}>#{run.changeNumber}</RouterLink> : null}</div>
    <div className="local-activity__line"><span className="local-activity__summary" title={summary}>{summary}</span><RelativeTime at={last?.at ?? run.startedAt} now={now} /></div>
  </li>;
}

export function ActivityRows({ runs, now, live = false, error }: { runs: LocalActivityRun[]; now: number; live?: boolean; error?: string | null }) {
  const shown = live ? runs.filter(activityRunning) : [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return <div className="local-activity__viewport" tabIndex={0} aria-label={live ? 'Current local activity' : 'Local activity timeline'}>
    {error ? <p className="local-activity__notice" role="status">Updates paused. Reconnecting…</p> : null}
    {shown.length ? <ol className="local-activity__rows">{shown.map(run => <ActivityRow key={run.id} run={run} now={now} live={live} />)}</ol> : <p className="local-activity__notice">{live ? 'No local agents running.' : 'No local activity reported.'}</p>}
  </div>;
}
