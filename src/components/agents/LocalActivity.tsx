import { activityRunning } from '../../../shared/agent-activity';
import { api } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { useLive } from '../../lib/live';
import { ActivityRows } from './ActivitySummary';

/** Local agents' activity: on a pull request, its timeline; on Agents, only the agents running now, and nothing when none are. */
export default function LocalActivity({ changeId }: { changeId?: string }) {
  const live = useLive(`local-activity:${changeId ?? 'now'}`, () => api.localActivity(changeId), 3000);
  const now = useNow();
  const runs = live.data?.items ?? [];
  if (!changeId && !runs.some(activityRunning)) return null;
  return <section className="list local-activity" aria-label={changeId ? 'Local agent activity' : 'Now'}>
    <header className="list__head"><h2 className="list__filter">{changeId ? 'Local activity' : 'Now'}</h2><span className="local-activity__source">Reported from the agent’s machine</span></header>
    <ActivityRows runs={runs} now={now} live={!changeId} error={live.error} />
  </section>;
}
