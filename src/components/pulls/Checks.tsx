import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import type { Change, ChangeCheck } from '../../../shared/types';
import type { Policy } from '../../../shared/policy';
import { CHECK_GROUPS, GUARD_CHECK, checkGroup, checkState, checksFor, type CheckGroup } from '../../lib/changes';
import { plural, shortHash } from '../../lib/format';
import { CheckStateIcon } from './Bits';

const STATE: Record<ChangeCheck['status'], string> = { passed: 'Passed', failed: 'Failed', warning: 'Warning' };

/** A check's result in a word, and an agent-reported one as reported. */
export const checkWord = (status: ChangeCheck['status'], reported: boolean) => (reported ? `Reported ${STATE[status].toLowerCase()}` : STATE[status]);

interface Row {
  key: string;
  group: CheckGroup;
  label: string;
  status: ChangeCheck['status'];
  /** The agent reported this result; Braid did not run it. */
  reported: boolean;
  detail: string;
  run?: ChangeCheck['run'];
  /** A finding reads inline; a command's output opens on demand. */
  finding?: boolean;
}

/**
 * Every row the Checks tab shows for the current revision: its checks, then Code security, one row
 * per kind of finding. A scan that sends the pull request back fails; one that asks a person warns.
 */
export function checkRows(change: Change, policy?: Policy): Row[] {
  const rows: Row[] = checksFor(change.checks, change.revision).map((check, index) => ({
    key: `${check.source}-${check.label}-${index}`, group: checkGroup(check.source), label: check.label, status: check.status, reported: check.source === 'agent', detail: check.detail,
    ...(check.run ? { run: check.run } : {}),
  }));
  for (const kind of ['secrets', 'tests', 'dependencies', 'instructions'] as const) {
    const found = (change.guards ?? []).filter((guard) => guard.kind === kind);
    if (!found.length) continue;
    rows.push({ key: `guard-${kind}`, group: 'braid', label: GUARD_CHECK[kind], status: (policy?.guards[kind] ?? 'attention') === 'revise' ? 'failed' : 'warning', reported: false, detail: found.map((guard) => guard.detail).join('\n'), finding: true });
  }
  const order = { failed: 0, warning: 1, passed: 2 };
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

/** The same rows as checks, for what they add up to in a merge box. */
export function checkRowsAsChecks(change: Change, policy?: Policy): ChangeCheck[] {
  return checkRows(change, policy).map((row) => ({ revision: change.revision, label: row.label, status: row.status, detail: row.detail, source: row.reported ? 'agent' : 'braid' }));
}

/** What the rows add up to, as GitHub's checks header counts them. */
export function checksSummary(rows: Row[]): string {
  const parts = [plural(rows.length, 'check')];
  const passed = rows.filter((row) => row.status === 'passed' && !row.reported).length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const warnings = rows.filter((row) => row.status === 'warning').length;
  const reported = rows.filter((row) => row.reported).length;
  if (failed) parts.push(`${failed} failed`);
  if (warnings) parts.push(plural(warnings, 'warning'));
  if (passed) parts.push(`${passed} passed`);
  if (reported) parts.push(`${reported} agent-reported`);
  return parts.join(' · ');
}

/** Agent reports never increase the number of verified passes. */
export function mergeChecksSummary(checks: ChangeCheck[]) {
  const verified = checks.filter((check) => check.source !== 'agent');
  const reported = checks.length - verified.length;
  const result = checkState(checks.some((check) => check.status === 'failed') ? checks : verified);
  if (!verified.length && reported && result.state !== 'failed') return { state: 'reported' as const, label: 'Agent-reported only' };
  return { ...result, label: reported && verified.length ? `${result.label} · ${reported} agent-reported` : result.label };
}

/** One check: its state, its name, one line of what it found, and its output on demand. A reported result says so and never shows as a verified pass. */
function CheckRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const output = row.detail.trim();
  const first = output.split('\n')[0];
  const detail = row.run ? `combined ${shortHash(row.run.commit)} · exit ${row.run.exitCode} · ${row.run.seconds} s` : first;
  const state = row.status === 'failed' ? 'failed' : row.reported ? 'reported' : row.status;
  return (
    <li className="check" data-status={row.status} data-reported={row.reported || undefined} data-finding={row.finding || undefined} data-open={open || undefined}>
      <CheckStateIcon state={state} label="" />
      <span className={row.finding ? 'check__label' : 'check__label mono'}>{row.label}</span>
      {output && !open ? (
        <span className="check__detail" title={row.finding ? undefined : output}>
          {row.finding ? output : detail}
        </span>
      ) : (
        <span />
      )}
      <span className="check__right">
        <span className="check__state">{checkWord(row.status, row.reported)}</span>
        {output && !row.finding ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide' : 'Output'}
          </Button>
        ) : null}
      </span>
      {open ? <pre className="check__pre">{output}</pre> : null}
    </li>
  );
}

/**
 * The current revision's checks as GitHub lists them: a count on top, then one box with the rows
 * grouped by where they ran. Braid's group also carries Code security: what the scans found, as the
 * file and line, never the secret itself. Nothing here claims a run that did not happen.
 */
export function Checks({ change, policy }: { change: Change; policy?: Policy }) {
  const rows = checkRows(change, policy);
  const groups = new Map<CheckGroup, Row[]>();
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  if (!groups.size) return <p className="quiet checks-empty">No checks ran.</p>;
  return (
    <div className="checks-tab">
      <p className="checks__summary">{checksSummary(rows)}</p>
      <div className="checks__box">
        {CHECK_GROUPS.filter((group) => groups.has(group.group)).map((group) => (
          <section key={group.group} className="checks-group" aria-labelledby={`checks-${group.group}`}>
            <h2 className="checks-group__title" id={`checks-${group.group}`} title={group.detail}>
              {group.group === 'braid' && groups.get('braid')!.some((row) => row.run) ? 'Braid sandbox' : group.label}
            </h2>
            <ul className="checks-group__rows">
              {groups.get(group.group)!.map((row) => (
                <CheckRow key={row.key} row={row} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** How many rows the Checks tab shows. */
export function checkRowCount(change: Change, policy?: Policy): number {
  return checkRows(change, policy).length;
}
