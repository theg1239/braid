import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import type { RepositoryCommit } from '../../shared/history';
import { aggregateHistory, completeHistory, mirrorHistory, useMirrorHistory, type HistoryContributor } from '../components/repo/mirror-history';
import { ErrorPanel } from '../components/ui/States';
import { RouterLink } from '../components/ui/Link';
import { errorMessage } from '../lib/api';
import { shortHash } from '../lib/format';
import { paths } from '../lib/router';
import { useDocumentTitle } from '../lib/title';
import { useSnapshot } from '../store/workspace';
import '../styles/pages.css';
import '../styles/agents.css';
import '../components/repo/mirror-history.css';

export function MirrorAgentsScreen() {
  const snapshot = useSnapshot();
  useDocumentTitle(`Agents · ${snapshot.project.name || snapshot.importing?.name || 'Braid'}`);
  const history = useMirrorHistory();
  return <div className="page"><HistoryTable key={`${history.head}:${history.importing}`} history={history} /></div>;
}

function HistoryTable({ history }: { history: ReturnType<typeof useMirrorHistory> }) {
  const [extra, setExtra] = useState<RepositoryCommit[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = aggregateHistory([...(history.value?.items ?? []), ...extra], expanded ? 300 : 100);
  const ready = !!history.value && (!history.importing || completeHistory(history.value, true));
  const more = async () => {
    if (busy || !history.value) return;
    setBusy(true);
    setError(null);
    try {
      const items: RepositoryCommit[] = [...history.value.items];
      const cursors = new Set<string>();
      let cursor = history.value.nextCursor;
      // The endpoint pages at 100; the bound also tolerates its older 30-commit page size.
      while (cursor && items.length < 300 && cursors.size < 10 && !cursors.has(cursor)) {
        cursors.add(cursor);
        const page = await mirrorHistory.load(history.head, history.importing, cursor);
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      setExtra(items.slice(history.value.items.length));
      setExpanded(true);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <section className="list mirror-history" aria-labelledby="mirror-history-title" aria-busy={busy || !history.value && !history.error || undefined}>
    <header className="mirror-history__head">
      <div><h1 id="mirror-history-title">Agents</h1><p>{ready ? `Last ${summary.total} commits` : history.importing ? 'Copying from GitHub' : '\u00a0'}</p></div>
      {ready && history.value?.nextCursor && !expanded ? <Button size="sm" variant="secondary" onClick={() => void more()} disabled={busy}>Show 300</Button> : null}
    </header>
    {history.error && !history.value ? <ErrorPanel title="Couldn’t read commit history" message={history.error} onRetry={history.retry} /> : ready ? <table className="fleet__table mirror-history__table">
      <thead><tr><th scope="col">Agent</th><th scope="col" className="fleet__n">Commits</th><th scope="col">Latest commit</th></tr></thead>
      <tbody>{[...summary.agents, summary.people].map(row => <ContributorRow key={row.key} row={row} />)}</tbody>
    </table> : <div className="mirror-history__empty">{history.importing ? 'Commit history will appear when the copy is ready.' : null}</div>}
    {error ? <ErrorPanel title="Couldn’t read more commits" message={error} onRetry={() => void more()} retrying={busy} /> : null}
  </section>;
}

function ContributorRow({ row }: { row: HistoryContributor }) {
  return <tr>
    <th scope="row"><span className="fleet__name">{row.name}</span>{row.tool && row.tool !== row.name ? <span className="fleet__tool">{row.tool}</span> : null}</th>
    <td className="fleet__n">{row.commits}</td>
    <td>{row.latest ? <RouterLink className="mirror-history__commit" href={paths.commit(row.latest.hash)} title={row.latest.title} aria-label={`${row.latest.title} (${shortHash(row.latest.hash)})`}><span>{row.latest.title}</span><span className="mono">{shortHash(row.latest.hash)}</span></RouterLink> : <span className="quiet">—</span>}</td>
  </tr>;
}
