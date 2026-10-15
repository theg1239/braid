import { InlineCopyText } from '@cloudflare/kumo';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import type { ChangeAuthor } from '../../../shared/types';
import { api, changes } from '../../lib/api';
import { authorLine, checkState, checksFor } from '../../lib/changes';
import { mergedMissions } from '../../lib/derive';
import { shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { listInterval } from '../../lib/lists';
import { useLive } from '../../lib/live';
import { LATEST_KEY, latestList } from '../../lib/needs';
import { paths } from '../../lib/router';
import { useSnapshot } from '../../store/workspace';
import { AuthorChip, CheckStateIcon } from '../pulls/Bits';
import { RouterLink } from '../ui/Link';
import { LoadingRegion, SkeletonLine } from '../ui/Skeleton';
import { RelativeTime } from '../ui/Time';

/**
 * Imported commits have no Braid merge record. Read just their tip metadata, without fetching a diff,
 * and keep the same author, subject and time slots while either source resolves.
 */
export function LatestCommit() {
  const snapshot = useSnapshot();
  const now = useNow();
  const latest = useLive(LATEST_KEY, latestList, listInterval);
  const change = latest.data?.items[0];
  const history = latest.data?.counts.landed ?? 0;
  const full = useLive(change ? `changes:item:${change.number}` : null, () => changes.get(String(change!.number)), 60_000);
  const merged = mergedMissions(snapshot.missions).find((mission) => !mission.agents.some((agent) => agent.change));
  const head = snapshot.project.head;
  const changeAt = change ? Date.parse(change.updatedAt) : 0;
  const missionAt = merged ? Date.parse(merged.mergedAt ?? merged.createdAt) : 0;
  const checks = full.data && full.data.id === change?.id ? checkState(checksFor(full.data.checks, full.data.revision)) : null;
  const taskAuthor: ChangeAuthor | null = merged ? { kind: 'agent', id: merged.id, name: merged.agents.map((agent) => agent.name).join(', ') || 'Agents' } : null;
  const useChange = !!change && changeAt >= missionAt;
  const hash = (useChange ? change?.landedCommit : merged?.mergeCommit) || head;
  const readTip = !!head && !change && !merged && !!(latest.data || latest.error);
  const tip = useLive(readTip ? `commits:tip:${head}` : null, () => api.commits(head, '', null, 1), 300_000);
  const commit = readTip ? tip.data?.items[0] : undefined;
  const loading = !latest.data && !latest.error || readTip && !tip.data && !tip.error;
  const at = !loading && useChange && change ? change.updatedAt : !loading && merged ? merged.mergedAt ?? merged.createdAt : commit?.at;
  const author = !loading ? useChange ? change?.author : taskAuthor ?? commit?.author : undefined;
  return (
    <div className="commit-bar commit-bar--latest">
      {loading ? (
        <LoadingRegion label="Loading latest commit" className="commit-bar__author">
          <SkeletonLine width="80%" />
        </LoadingRegion>
      ) : (
        <span className="commit-bar__author" title={author ? authorLine(author) : undefined}>
          {author ? <AuthorChip author={author} /> : null}
        </span>
      )}
      <span className="commit-bar__subject">
      {loading ? <SkeletonLine width="70%" /> : useChange && change ? (
        <>
          <RouterLink href={paths.pull(change.number)} className="commit-bar__title">
            {change.title}
          </RouterLink>
          <RouterLink href={paths.pull(change.number)} className="commit-bar__num">
            #{change.number}
          </RouterLink>
        </>
      ) : merged && taskAuthor ? (
        <RouterLink href={paths.task(merged.id)} className="commit-bar__title">
          {merged.title}
        </RouterLink>
      ) : head ? (
        <RouterLink href={paths.commit(head)} className="commit-bar__title">{commit ? commit.title || 'Untitled commit' : 'View commit'}</RouterLink>
      ) : null}
      </span>
      <span className="commit-bar__right">
        <span className="commit-bar__check">{useChange && change && checks ? <RouterLink href={paths.pull(change.number, { tab: 'checks' })} title={checks.state === 'none' ? 'No checks ran' : checks.label} aria-label={checks.state === 'none' ? 'No checks ran' : checks.label}><CheckStateIcon state={checks.state} label="" size={15} /></RouterLink> : null}</span>
        {hash ? <span className="mono commit-bar__hash"><InlineCopyText value={hash} labels={{ copyAction: `Copy commit hash ${shortHash(hash)}`, copied: `Copied commit hash ${shortHash(hash)}` }}>{shortHash(hash)}</InlineCopyText></span> : null}
        <span className="commit-bar__time">{loading ? (
          <SkeletonLine width={64} />
        ) : at ? (
          <RelativeTime at={at} now={now} />
        ) : null}</span>
        <RouterLink href={paths.commits(snapshot.project.branch)} className="commit-bar__history" title={history ? `${history} merged pull requests` : undefined}>
          <ClockCounterClockwiseIcon size={14} aria-hidden="true" />
          Commits
        </RouterLink>
      </span>
    </div>
  );
}
