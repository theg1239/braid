import { publicPolling } from '../lib/polling';
import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, Input } from '@cloudflare/kumo';
import { CheckIcon, GitMergeIcon, GitPullRequestIcon, PauseIcon, XIcon } from '@phosphor-icons/react';
import type { ChangeSummary, TrunkStatus } from '../../shared/types';
import { changes, errorMessage } from '../lib/api';
import { FILTER_STATUSES, filterCount, listInterval, queueInterval } from '../lib/lists';
import { personHandle } from '../../shared/people';
import { isEditableTarget, isModifierKey } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { ATTENTION_KEY, SEARCH_PAGE, attentionList } from '../lib/needs';
import { paths, useRoute, type PullFilter } from '../lib/router';
import { canWrite, useSnapshot } from '../store/workspace';
import { SetupPromptButton } from '../account/SetupPrompt';
import { Label } from '../components/pulls/Bits';
import { PullRow } from '../components/pulls/PullRow';
import { filterPulls } from '../components/pulls/filtering';
import { QueueControl } from '../components/queue/QueueControl';
import { NoRepositoryPanel } from '../components/repo/RepositorySetup';
import { LoadMore } from '../components/ui/Scroll';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel, ErrorPanel, ErrorNotice } from '../components/ui/States';
import { PullRowsSkeleton } from '../components/ui/ScreenSkeleton';
import { SkeletonLine } from '../components/ui/Skeleton';
import { useFleet } from '../components/agents/Fleet';

const PAGE = 25;
const EMPTY: Record<PullFilter, string> = { review: 'Nothing needs you', open: 'No open pull requests', closed: 'No closed pull requests' };

/** GitHub's pull request list, or one agent's pull requests when the roster sent the viewer here. */
export function PullsScreen() {
  const route = useRoute();
  const agent = route.query.get('agent');
  return <><h1 className="sr-only">Pull requests</h1>{agent ? <AgentPulls key={agent} id={agent} /> : <PullList />}</>;
}

/** One agent's pull requests, every state in one list, as GitHub filters a list by author; the server filters by the roster record's model, owner and tool. */
function AgentPulls({ id }: { id: string }) {
  const now = useNow();
  const roster = useFleet(true);
  const record = roster.data?.find((item) => item.id === id);
  const page = useLive(`changes:list:agent:${id}`, () => changes.list({ agent: id, limit: 50 }), listInterval);
  const [extra, setExtra] = useState<{ items: ChangeSummary[]; cursor: string | null; busy: boolean; error: string | null }>({ items: [], cursor: null, busy: false, error: null });
  useRowKeys();

  useDocumentTitle(`${record?.name ?? 'Unknown agent'} · Pull requests · Braid`);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const mine: ChangeSummary[] = [];
    for (const item of [...(page.data?.items ?? []), ...extra.items]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      mine.push(item);
    }
    return mine;
  }, [page.data, extra.items, id]);

  const cursor = extra.items.length ? extra.cursor : (page.data?.nextCursor ?? null);
  const loadMore = async () => {
    if (!cursor || extra.busy) return;
    setExtra((current) => ({ ...current, busy: true, error: null }));
    try {
      const next = await changes.list({ agent: id, cursor, limit: 50 });
      setExtra((current) => ({ ...current, items: [...current.items, ...next.items], cursor: next.nextCursor, busy: false }));
    } catch (err) {
      setExtra((current) => ({ ...current, busy: false, error: errorMessage(err) }));
    }
  };

  const owner = record?.owner ? personHandle(record.owner) : null;
  return (
    <div className="page">
      <div className="pulls-bar">
        <span className="agent-filter">
          <span className="author">
            <span className="author__name">{record?.name ?? 'Unknown agent'}</span>
            {owner ? <span className="author__owner">for {owner}</span> : null}
          </span>
          <RouterLink href={paths.pulls()} className="agent-filter__clear" aria-label="All pull requests">
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </RouterLink>
        </span>
      </div>
      <div className="list">
        <header className="list__head">
          <span className="list__filter" aria-current="page">
            <GitPullRequestIcon size={15} aria-hidden="true" />
            Pull requests
            {page.data ? <span className="list__count">{items.length}</span> : null}
          </span>
        </header>
        {page.error && !page.data ? (
          <ErrorPanel title="Couldn’t load pull requests" message={page.error} onRetry={() => void page.refresh()} retrying={page.refreshing} />
        ) : page.loading && !page.data ? (
          <PullRowsSkeleton />
        ) : items.length ? (
          <ul className="list__rows" aria-label="Pull requests">
            {items.map((change) => (
              <PullRow key={change.id} change={change} now={now} />
            ))}
          </ul>
        ) : (
          <EmptyPanel icon={<GitPullRequestIcon size={28} />} title="No pull requests" />
        )}
      </div>
      {extra.error ? <Banner variant="error" size="sm" description={extra.error} /> : null}
      {cursor ? <LoadMore more={loadMore} busy={extra.busy} failed={!!extra.error} label="Load more pull requests" /> : null}
    </div>
  );
}

/** GitHub's pull request list: a filter box, the merge queue in one line, Open and Closed, and the ones that need the viewer first. */
function PullList() {
  const snapshot = useSnapshot();
  const route = useRoute();
  const now = useNow();
  const ready = !!snapshot.project.id;
  const hasIdentity = !!snapshot.capabilities.identity;
  const attention = useLive(ready && hasIdentity ? ATTENTION_KEY : null, attentionList, listInterval);
  const queue = useLive(ready ? 'queue' : null, changes.queue, queueInterval);
  const reviewCount = attention.data?.counts.attention ?? 0;
  const explicit: PullFilter | null = route.query.has('review') ? 'review' : route.query.get('state') === 'closed' ? 'closed' : route.query.get('state') === 'open' ? 'open' : null;
  const filter: PullFilter | null = !hasIdentity || publicPolling() ? (explicit === 'closed' ? 'closed' : 'open') : explicit ?? (attention.data ? (reviewCount ? 'review' : 'open') : null);
  const listed = filter && filter !== 'review' ? filter : null;
  const status = listed ? FILTER_STATUSES[listed].join(',') : '';
  const [query, setQuery] = useState('');
  const searching = !!query.trim();
  // Search reads every state so both counts describe the same matching set.
  const scope = searching ? 'search' : filter;
  const page = useLive(ready && (searching || listed) ? `changes:list:${scope}` : null, () => changes.list(searching ? { limit: SEARCH_PAGE } : { status, limit: PAGE }), listInterval);
  const first = searching || (filter && filter !== 'review') ? page : attention;
  const [extra, setExtra] = useState<{ scope: typeof scope; items: ChangeSummary[]; cursor: string | null; error: string | null; busy: boolean }>({ scope, items: [], cursor: null, error: null, busy: false });
  useRowKeys();

  useDocumentTitle(`Pull requests · ${snapshot.project.name || 'Braid'}`);

  // Search pages survive state switches and new text; other lists have their own pages.
  useEffect(() => {
    setExtra({ scope, items: [], cursor: null, error: null, busy: false });
  }, [scope]);

  const matching = useMemo(() => {
    const seen = new Set<string>();
    const merged: ChangeSummary[] = [];
    for (const item of [...(first.data?.items ?? []), ...(extra.scope === scope ? extra.items : [])]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return filterPulls(merged, query);
  }, [first.data, extra, scope, query]);
  const items = searching && filter ? matching.items.filter((item) => FILTER_STATUSES[filter].includes(item.status)) : matching.items;

  const nextCursor = extra.scope === scope && extra.items.length ? extra.cursor : (first.data?.nextCursor ?? null);
  const loadMore = async () => {
    if (!nextCursor || extra.busy || !filter) return;
    setExtra((current) => ({ ...current, busy: true, error: null }));
    try {
      const next = await changes.list({ ...(searching ? { limit: SEARCH_PAGE } : { status: FILTER_STATUSES[filter].join(','), limit: PAGE }), cursor: nextCursor });
      setExtra((current) => (current.scope === scope ? { ...current, items: [...current.items, ...next.items], cursor: next.nextCursor, busy: false } : current));
    } catch (err) {
      setExtra((current) => current.scope === scope ? { ...current, busy: false, error: errorMessage(err) } : current);
    }
  };

  if (!ready) {
    return (
      <div className="page">
        <NoRepositoryPanel />
      </div>
    );
  }

  const counts = searching ? (first.data ? matching.counts : null) : first.data?.counts ?? attention.data?.counts ?? null;
  const needsCount = searching ? counts?.attention ?? 0 : reviewCount;
  const countSuffix = searching && nextCursor ? '+' : '';
  const countTitle = countSuffix ? 'Matches in loaded pull requests. Load more to search older pull requests.' : undefined;

  return (
    <div className="page">
      <div className="pulls-bar">
        <Input aria-label="Filter pull requests" placeholder="Filter pull requests" value={query} onChange={(event) => setQuery(event.target.value)} className="pulls-bar__search" passwordManagerIgnore />
      </div>
      {queue.error ? <ErrorNotice message={queue.error} onRetry={() => void queue.refresh()} retrying={queue.refreshing} /> : <QueueLine queue={queue.data} />}
      {first.error && first.data ? (
        <div className="notice">
          <ErrorNotice message={first.error} onRetry={() => void first.refresh()} retrying={first.refreshing} />
        </div>
      ) : null}
      <div className="list">
        <header className="list__head">
          <RouterLink href={paths.pulls('open')} className="list__filter" aria-current={filter === 'open' ? 'page' : undefined}>
            <GitPullRequestIcon size={15} aria-hidden="true" />
            Open
            {counts ? <span className="list__count" title={countTitle}>{filterCount('open', counts)}{countSuffix}</span> : null}
          </RouterLink>
          <RouterLink href={paths.pulls('closed')} className="list__filter" aria-current={filter === 'closed' ? 'page' : undefined}>
            <CheckIcon size={15} aria-hidden="true" />
            Closed
            {counts ? <span className="list__count" title={countTitle}>{filterCount('closed', counts)}{countSuffix}</span> : null}
          </RouterLink>
          {hasIdentity ? <RouterLink href={filter === 'review' ? paths.pulls('open') : paths.pulls('review')} className="list__filter list__filter--needs" aria-current={filter === 'review' ? 'page' : undefined}>
            Needs you
            {needsCount || searching && counts ? <span className="list__count" title={countTitle}>{needsCount}{countSuffix}</span> : null}
          </RouterLink> : null}
        </header>
        {first.error && !first.data ? (
          <ErrorPanel title="Couldn’t load pull requests" message={first.error} onRetry={() => void first.refresh()} retrying={first.refreshing} />
        ) : !filter || (first.loading && !first.data) ? (
          <PullRowsSkeleton />
        ) : items.length ? (
          <ul className="list__rows" aria-label="Pull requests">
            {items.map((change) => (
              <PullRow key={change.id} change={change} now={now} />
            ))}
          </ul>
        ) : (
          <EmptyPanel
            icon={<GitPullRequestIcon size={28} />}
            title={query ? 'No matches' : EMPTY[filter]}
            // A repository with no pull requests yet gets them from agents: the one step is connecting one.
            action={query ? <Button variant="secondary" onClick={() => setQuery('')}>Clear filter</Button> : filter === 'review' ? <RouterLink href={paths.pulls('open')} className="text-link">View open pull requests</RouterLink> : counts && !filterCount('open', counts) && !filterCount('closed', counts) && canWrite(snapshot) ? <SetupPromptButton /> : undefined}
          />
        )}
      </div>
      {extra.error ? <Banner variant="error" size="sm" description={extra.error} /> : null}
      {nextCursor ? <LoadMore more={loadMore} busy={extra.busy} failed={!!extra.error} label="Load more pull requests" /> : null}
    </div>
  );
}

/**
 * The merge queue in one line, as PlanetScale shows its deploy queue above the requests: which
 * pull requests are merging and how many wait, or why merging stopped, with Resume for owners.
 */
function QueueLine({ queue }: { queue: TrunkStatus | null }) {
  if (!queue) return <div className="queue-line" aria-label="Loading merge queue"><SkeletonLine width={160} /></div>;
  if (!queue.enabled || queue.paused) {
    return (
      <div className="queue-line queue-line--paused">
        <Banner variant="alert" size="sm" icon={<PauseIcon weight="fill" />} description={queue.paused ?? 'Merging is off.'} action={<QueueControl enabled={false} compact />} />
      </div>
    );
  }
  const { merging, waiting } = queue;
  return (
    <p className="queue-line" data-state={merging.length ? 'merging' : undefined}>
      <RouterLink href={paths.queue()} className="queue-line__link">
        <GitMergeIcon size={15} aria-hidden="true" />
        {merging.length ? `Merging ${merging.map((item) => `#${item.number}`).join(', ')}` : waiting ? 'Merge queue' : 'Merge queue is empty'}
      </RouterLink>
      {waiting ? <span>{waiting} waiting</span> : null}
    </p>
  );
}

/** j and k move between rows, like most review tools; Enter opens the focused one. */
function useRowKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isModifierKey(event) || event.altKey || isEditableTarget(event.target) || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      const links = [...document.querySelectorAll<HTMLAnchorElement>('.pr__title')];
      if (!links.length) return;
      const index = links.findIndex((link) => link === document.activeElement);
      const next = event.key === 'j' ? Math.min(links.length - 1, index + 1) : Math.max(0, index === -1 ? 0 : index - 1);
      event.preventDefault();
      links[next]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
