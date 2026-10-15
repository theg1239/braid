import { AgentRuns } from './AgentRuns';
import { Button } from '@cloudflare/kumo';
import type { AgentRecord, ChangePage, ChangeSummary } from '../../../shared/types';
import { changes } from '../../lib/api';
import { useLive } from '../../lib/live';
import { paths } from '../../lib/router';
import { PullStateIcon } from '../pulls/Bits';
import { RouterLink } from '../ui/Link';
import { ErrorPanel } from '../ui/States';
import { SkeletonRows } from '../ui/Skeleton';

/** List totals cover the repository; derive an agent's rate only from its own returned PRs. */
export function mergeRate(items: Pick<ChangeSummary, 'status'>[]): { rate: number | null; merged: number; finished: number } {
  const merged = items.filter((item) => item.status === 'landed').length;
  const finished = merged + items.filter((item) => item.status === 'closed').length;
  return { rate: finished ? Math.round((merged / finished) * 100) : null, merged, finished };
}

export function AgentDetail({ record }: { record: AgentRecord }) {
  const live = useLive<ChangePage>(`agent-detail:${record.id}`, () => changes.list({ agent: record.id, limit: 100 }), 30_000);
  const page = live.data;
  if (!page) return live.error ? <ErrorPanel title="Couldn’t load pull requests" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : <SkeletonRows rows={3} detail label="Loading agent details" />;
  const { rate, merged, finished } = mergeRate(page.items);
  return (
    <div className="agent-detail">
      <dl className="agent-detail__metrics">
        <div><dt>{page.nextCursor ? 'Recent merge rate' : 'Merge rate'}</dt><dd>{rate === null ? '—' : `${rate}%`}<span>{finished ? `${merged} of ${finished} finished pull requests` : 'No finished pull requests'}{page.nextCursor ? ` · latest ${page.items.length} loaded` : ''}</span></dd></div>
        <div><dt>Lines added</dt><dd>{record.lines.added.toLocaleString()}</dd></div>
        <div><dt>Lines on main</dt><dd>{record.lines.alive.toLocaleString()}</dd></div>
      </dl>
      <AgentRuns record={record} changes={page.items} />
      {live.error ? <p className="agent-detail__error" role="alert">{live.error} <Button size="sm" variant="ghost" onClick={() => void live.refresh()} loading={live.refreshing}>Retry</Button></p> : null}
      <div className="agent-detail__heading"><strong>Recent pull requests</strong><RouterLink className="text-link" href={paths.agentPulls(record.id)}>View all</RouterLink></div>
      {page.items.length ? <ul className="agent-detail__pulls">{page.items.slice(0, 5).map((change) => (
        <li key={change.id}><PullStateIcon status={change.status} /><RouterLink href={paths.pull(change.number)}>{change.title}</RouterLink><span className="quiet">#{change.number}</span></li>
      ))}</ul> : <p className="quiet">No pull requests yet</p>}
    </div>
  );
}
