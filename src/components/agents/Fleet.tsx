import { Fragment, Suspense, useId, useState, type CSSProperties, type MouseEvent } from 'react';
import { Button } from '@cloudflare/kumo';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { AgentRecord } from '../../../shared/types';
import { api } from '../../lib/api';
import { toolBase } from '../../../shared/models';
import { personHandle } from '../../../shared/people';
import { useLive, type Live } from '../../lib/live';
import { lazyComponent } from '../../lib/lazy';
import { navigate, paths } from '../../lib/router';
import { Label } from '../pulls/Bits';
import { RouterLink } from '../ui/Link';
import { ErrorPanel, ErrorNotice } from '../ui/States';
import { LoadingRegion, SkeletonLine, SkeletonRows } from '../ui/Skeleton';

const detail = lazyComponent(() => import('./AgentDetail'), (m) => m.AgentDetail);
const AgentDetail = detail.Component;

/*
 * The fleet, as GitHub's Insights lists contributors: one row per agent, which is a model run by
 * a person's tool, with what it got merged, what came back, what is still open, and how many of
 * the lines it added are still on main. A count that is zero for every agent says nothing and
 * is not shown. Simulated load is left out. A row opens the agent's pull requests.
 */

type Count = 'landed' | 'sentBack' | 'reverted' | 'open';
const COUNTS: { key: Count; label: string }[] = [
  { key: 'landed', label: 'Merged' },
  { key: 'sentBack', label: 'Sent back' },
  { key: 'reverted', label: 'Reverted' },
  { key: 'open', label: 'Open' },
];

export function useFleet(ready: boolean): Live<AgentRecord[]> {
  return useLive(ready ? 'agents' : null, api.agents, 30_000);
}

/** Lines still on main first, as the measure of what an agent's work came to; simulated agents, whose edits are synthetic, last. */
function byAlive(a: AgentRecord, b: AgentRecord): number {
  return (a.simulated ? 1 : 0) - (b.simulated ? 1 : 0) || b.lines.alive - a.lines.alive || b.lines.added - a.lines.added || b.changes.landed - a.changes.landed || a.name.localeCompare(b.name);
}

/** Merged always; the other counts only when some agent has one. */
export function fleetColumns(records: AgentRecord[]): { key: Count; label: string }[] {
  return COUNTS.filter((column) => column.key === 'landed' || records.some((record) => record.changes[column.key] > 0));
}

export function Fleet({ live }: { live: Live<AgentRecord[]> }) {
  // Simulated load is not part of the fleet: the roster lists the agents people run.
  const records = live.data && live.data.filter((record) => !record.simulated);
  return (
    <section className="list fleet" aria-labelledby="fleet-title">
      <header className="list__head">
        <h2 id="fleet-title" className="list__filter" aria-current="page">
          Fleet
          {records?.length ? <span className="list__count">{records.length}</span> : null}
        </h2>
      </header>
      {live.error && records ? <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : null}
      {live.error && !records ? (
        <ErrorPanel title="Couldn’t load the fleet" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />
      ) : !records ? (
        <FleetSkeleton />
      ) : records.length ? (
        <FleetTable records={records} />
      ) : (
        <p className="agents-empty">No agents yet.</p>
      )}
    </section>
  );
}

export function FleetTable({ records }: { records: AgentRecord[] }) {
  const rows = [...records].sort(byAlive);
  const columns = fleetColumns(rows);
  const busiest = Math.max(0, ...rows.map((record) => record.lines.added));
  return (
    <div className="table-scroll">
      <table className="fleet__table">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="fleet__n" data-column={column.key}>
                {column.label}
              </th>
            ))}
            <th scope="col" className="fleet__n fleet__added">Lines added</th>
            <th scope="col" className="fleet__lines" aria-label="Lines on main">
              <span className="fleet__long">Lines on main</span>
              <span className="fleet__short">On main</span>
            </th>
            <th scope="col" className="fleet__expand"><span className="sr-only">Agent details</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <FleetRow key={record.id} record={record} columns={columns} busiest={busiest} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FleetRow({ record, columns, busiest }: { record: AgentRecord; columns: { key: Count; label: string }[]; busiest: number }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const owner = record.owner ? personHandle(record.owner) : null;
  const tools = [...new Set(record.tools.map(toolBase))].filter(Boolean);
  const href = paths.agentPulls(record.id);
  const { added, alive } = record.lines;
  // The name is the link; a plain click anywhere else on the row follows it too.
  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('a, button')) return;
    navigate(href);
  };
  return (
    <Fragment>
    <tr className="fleet__row" data-simulated={record.simulated || undefined} data-expanded={expanded || undefined} onClick={open}>
      <td>
        <RouterLink href={href} className="fleet__agent">
          <span className="fleet__name">{record.name}</span>
          {owner ? <span className="fleet__owner">for {owner}</span> : null}
          {tools.length ? <span className="fleet__tool">{tools.join(', ')}</span> : null}
        </RouterLink>
        <span className="fleet__mobile-counts">{columns.map((column) => <span key={column.key}>{record.changes[column.key].toLocaleString()} {column.label.toLowerCase()}</span>)}</span>
      </td>
      {columns.map((column) => {
        const value = record.changes[column.key];
        return (
          <td key={column.key} className="fleet__n" data-column={column.key} data-zero={value === 0 || undefined}>
            {value.toLocaleString()}
          </td>
        );
      })}
      <td className="fleet__n fleet__added">{added.toLocaleString()}</td>
      <td className="fleet__lines">
        <span className="fleet__measure" title={added ? `${alive.toLocaleString()} of ${added.toLocaleString()} lines added still on main` : undefined}>
          <span className="fleet__num" data-zero={alive === 0 || undefined}>
            {alive.toLocaleString()}
          </span>
          {added > 0 ? (
            <span className="fleet__bar" aria-hidden="true" style={{ '--added': added / busiest, '--alive': alive / busiest } as CSSProperties}>
              <i className="fleet__bar-added" />
              <i className="fleet__bar-alive" />
            </span>
          ) : null}
        </span>
      </td>
      <td className="fleet__expand"><Button size="sm" variant="ghost" shape="square" icon={expanded ? CaretDownIcon : CaretRightIcon} aria-label={`${expanded ? 'Hide' : 'Show'} ${record.name}${owner ? ` for ${owner}` : ''} details`} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => setExpanded(!expanded)} onPointerEnter={() => void detail.prefetch()} onFocus={() => void detail.prefetch()} /></td>
    </tr>
    {expanded ? <tr className="fleet__detail"><td colSpan={columns.length + 4} id={detailId}><Suspense fallback={<SkeletonRows rows={3} detail label="Loading agent details" />}><AgentDetail record={record} /></Suspense></td></tr> : null}
    </Fragment>
  );
}

function FleetSkeleton() {
  return (
    <LoadingRegion className="fleet__skeleton" label="Loading the fleet">
      {[0, 1, 2].map((row) => (
        <div key={row} className="fleet__skeleton-row">
          <SkeletonLine />
          <SkeletonLine className="skeleton-line--short" />
          <SkeletonLine className="skeleton-line--short" />
          <SkeletonLine className="skeleton-line--short" />
        </div>
      ))}
    </LoadingRegion>
  );
}
