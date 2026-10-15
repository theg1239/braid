import { useState } from 'react';
import { Button, Collapsible } from '@cloudflare/kumo';
import type { AgentReport, AgentReports } from '../../../shared/types';
import { modelName } from '../../../shared/models';
import { personHandle } from '../../../shared/people';
import { api, errorMessage, onWorkspaceReset } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { setLive, type Live } from '../../lib/live';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { SkeletonRows } from '../ui/Skeleton';
import { ErrorPanel, ErrorNotice } from '../ui/States';
import { Row, Section, SettingsEmpty, SettingsError } from './Section';
import { RelativeTime } from '../ui/Time';

function Report({ report, canResolve, now }: { report: AgentReport; canResolve: boolean; now: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    let current = true;
    const unsubscribe = onWorkspaceReset(() => { current = false; });
    try {
      const reports = await api.resolveAgentReport(report.id);
      if (current) setLive('agent-reports', reports);
    } catch (err) { if (current) setError(errorMessage(err)); }
    finally { unsubscribe(); if (current) setBusy(false); }
  };
  return <li className="agent-report">
    <Collapsible.Root>
      <Row compact label={report.summary} hint={<>
        <span title={`Connection: ${report.agent.connection}`}>{report.agent.model ? modelName(report.agent.model) : report.agent.name} for {personHandle(report.agent.owner)}</span>
        {report.tool ? <><span aria-hidden="true"> · </span><span className="mono">{report.tool}</span></> : null}
        {report.pullRequest ? <><span aria-hidden="true"> · </span><RouterLink href={paths.pull(report.pullRequest)} className="text-link">#{report.pullRequest}</RouterLink></> : null}
        <span aria-hidden="true"> · </span><RelativeTime at={report.createdAt} now={now} />
      </>}>
        {report.details ? <Collapsible.Trigger render={props => <Button {...props} variant="ghost" size="sm">Details</Button>} /> : null}
        {canResolve ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void resolve()} aria-label={`Resolve: ${report.summary}`}>Resolve</Button> : null}
      </Row>
      {report.details ? <Collapsible.Panel className="agent-report__details" keepMounted><p>{report.details}</p></Collapsible.Panel> : null}
      {error ? <div className="agent-report__error"><SettingsError>{error}</SettingsError></div> : null}
    </Collapsible.Root>
  </li>;
}

export function AgentReportsSection({ live }: { live: Live<AgentReports> }) {
  const now = useNow();
  return <Section id="agent-reports" title="Reports from agents" rows>
    <div className="agent-reports" role="region" aria-label="Reports from agents" tabIndex={0}>
      {live.error && live.data ? <ErrorNotice message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} /> : null}
      {live.error && !live.data ? <ErrorPanel title="Couldn’t load reports" message={live.error} onRetry={() => void live.refresh()} retrying={live.refreshing} />
        : !live.data ? <SkeletonRows rows={3} label="Loading reports" />
          : live.data.items.length ? <ul aria-label="Unresolved reports">{live.data.items.map(report => <Report key={report.id} report={report} canResolve={live.data!.canResolve} now={now} />)}</ul>
            : <SettingsEmpty>No unresolved reports.</SettingsEmpty>}
    </div>
  </Section>;
}
