import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import type { CommitPage, RepositoryCommit } from '../../shared/history';
import { useMirror } from '../account/mirrors';
import { aggregateHistory, type HistoryContributor } from '../components/repo/mirror-history';
import { durationLabel } from '../components/mission/timing';
import { ErrorPanel } from '../components/ui/States';
import { RouterLink } from '../components/ui/Link';
import { LoadingRegion, SkeletonLine } from '../components/ui/Skeleton';
import { api, errorMessage } from '../lib/api';
import { shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useLive, type Live } from '../lib/live';
import { paths } from '../lib/router';
import { useDocumentTitle } from '../lib/title';
import { useSnapshot } from '../store/workspace';
import '../styles/pages.css';
import '../styles/agents.css';
import '../components/repo/mirror-history.css';

const PAGE = 100;
/** Where a mirror's copy stands: its first commit is on the way, its history is arriving, or both are done. */
type Copy = 'first' | 'history' | 'done';

/**
 * A mirror's Agents tab: the agents and people behind its newest commits, read from commit attribution. The first copy
 * brings the newest commit and the history follows newest first, so whatever has arrived is the newest commits; the
 * table shows them as they come and says how many it counted.
 */
export function MirrorAgentsScreen() {
  const snapshot = useSnapshot();
  const mirror = useMirror();
  useDocumentTitle(`Agents · ${snapshot.project.name || snapshot.importing?.name || 'Braid'}`);
  const head = snapshot.project.head;
  const copy: Copy = !head ? 'first' : snapshot.importing || mirror?.importing || snapshot.branchCopy ? 'history' : 'done';
  // While history arrives the first page is read again; once it is done, one read stands.
  const history = useLive(head ? `mirror-authors:${head}:${copy}` : null, () => api.commits(head, '', null, PAGE), copy === 'done' ? 300_000 : 10_000);
  return (
    <div className="page">
      <h1 className="sr-only">Agents</h1>
      <Authors key={`${head}:${copy}`} head={head} copy={copy} history={history} startedAt={snapshot.importing?.startedAt ?? mirror?.startedAt} />
    </div>
  );
}

function Authors({ head, copy, history, startedAt }: { head: string; copy: Copy; history: Live<CommitPage>; startedAt?: string }) {
  const [extra, setExtra] = useState<RepositoryCommit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expanded = extra.length > 0;
  const page = history.data;
  const summary = page ? aggregateHistory([...page.items, ...extra], expanded ? 300 : PAGE) : null;
  const more = async () => {
    if (busy || !page) return;
    setBusy(true);
    setError(null);
    try {
      const items: RepositoryCommit[] = [];
      const cursors = new Set<string>();
      let cursor = page.nextCursor;
      while (cursor && page.items.length + items.length < 300 && !cursors.has(cursor)) {
        cursors.add(cursor);
        const next = await api.commits(head, '', cursor, PAGE);
        items.push(...next.items);
        cursor = next.nextCursor;
      }
      setExtra(items);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const rows = summary ? [...summary.agents, ...(summary.people.commits ? [summary.people] : [])] : null;
  return (
    <section className="list fleet mirror-history" aria-labelledby="mirror-authors-title" aria-busy={busy || !page && !history.error || undefined}>
      <header className="list__head">
        <h2 id="mirror-authors-title" className="list__filter" aria-current="page">
          Authors
          {rows?.length ? <span className="list__count">{rows.length}</span> : null}
        </h2>
        <p className="mirror-history__scope">{summary ? <Counted total={summary.total} copy={copy} /> : copy === 'first' ? <Copying startedAt={startedAt} /> : null}</p>
        {copy === 'done' && page?.nextCursor && !expanded ? <Button size="sm" variant="secondary" onClick={() => void more()} disabled={busy}>Show 300</Button> : null}
      </header>
      {history.error && !page ? <ErrorPanel title="Couldn’t read commit history" message={history.error} onRetry={() => void history.refresh()} retrying={history.refreshing} />
        : rows ? <AuthorTable rows={rows} /> : <AuthorSkeleton />}
      {error ? <ErrorPanel title="Couldn’t read more commits" message={error} onRetry={() => void more()} retrying={busy} /> : null}
    </section>
  );
}

/** How many commits the counts cover. Below a full page while history arrives, the rest is still on its way. */
function Counted({ total, copy }: { total: number; copy: Copy }) {
  if (copy === 'done' || total >= PAGE) return <>Last {total} {total === 1 ? 'commit' : 'commits'}</>;
  return <>Newest {total} {total === 1 ? 'commit' : 'commits'} · copying history</>;
}

function Copying({ startedAt }: { startedAt?: string }) {
  const now = useNow(1000);
  return <>Copying from GitHub{startedAt ? <span className="mono"> {durationLabel(now - Date.parse(startedAt))}</span> : null}</>;
}

function AuthorTable({ rows }: { rows: HistoryContributor[] }) {
  return (
    <table className="fleet__table mirror-history__table">
      <thead><tr><th scope="col">Author</th><th scope="col" className="fleet__n">Commits</th><th scope="col">Latest commit</th></tr></thead>
      <tbody>{rows.map(row => <AuthorRow key={row.key} row={row} />)}</tbody>
    </table>
  );
}

function AuthorRow({ row }: { row: HistoryContributor }) {
  return <tr>
    <th scope="row"><span className="fleet__name">{row.name}</span>{row.tool && row.tool !== row.name ? <span className="fleet__tool">{row.tool}</span> : null}</th>
    <td className="fleet__n">{row.commits}</td>
    <td>{row.latest ? <RouterLink className="mirror-history__commit" href={paths.commit(row.latest.hash)} title={row.latest.title} aria-label={`${row.latest.title} (${shortHash(row.latest.hash)})`}><span>{row.latest.title}</span><span className="mono">{shortHash(row.latest.hash)}</span></RouterLink> : null}</td>
  </tr>;
}

/** The table's own rows while the first commits arrive, so nothing moves when they do. */
function AuthorSkeleton() {
  return (
    <LoadingRegion label="Loading authors">
      <table className="fleet__table mirror-history__table" aria-hidden="true">
        <thead><tr><th scope="col">Author</th><th scope="col" className="fleet__n">Commits</th><th scope="col">Latest commit</th></tr></thead>
        <tbody>{[46, 32, 38].map(width => <tr key={width}>
          <th scope="row"><SkeletonLine width={`${width}%`} /></th>
          <td className="fleet__n"><SkeletonLine width={20} /></td>
          <td><SkeletonLine width={`${width + 20}%`} /></td>
        </tr>)}</tbody>
      </table>
    </LoadingRegion>
  );
}
