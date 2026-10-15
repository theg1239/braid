import type { AgentActivityEvent } from '../../../shared/agent-activity';
import type { Agent } from '../../../shared/types';
import { modelName } from '../../../shared/provenance';
import { personHandle } from '../../../shared/people';
import { hostedEvidence } from '../mission/HostedRun';
import { RelativeTime } from '../ui/Time';
import { ActivitySummary } from './ActivitySummary';

/** The same event and evidence appear on tasks and in the pull request conversation. */
export function HostedActivity({ agent, event, now }: { agent: Pick<Agent, 'name' | 'model' | 'owner'>; event: AgentActivityEvent; now: number }) {
  const problem = event.failure;
  return <div className="hosted-activity-event">
    <span>{modelName(agent.model ?? agent.name)}{agent.owner ? ` for ${personHandle(agent.owner)}` : ''} · <ActivitySummary event={event} /></span>
    <RelativeTime at={event.at} now={now} />
    {problem?.evidence ? <p className="hosted-run__evidence">{hostedEvidence({ evidence: problem.evidence })}</p> : null}
    {problem?.lines.filter(Boolean).length ? <details><summary>Last 40 lines · redacted</summary><pre>{problem.lines.slice(-40).join('\n')}</pre></details> : null}
    {event.kind === 'failed' && problem?.action ? <p>{problem.action === 'edit_setup' ? 'Edit setup commands in Settings → Rules.' : problem.action === 'more_time' ? 'Retry with more time from the task.' : 'Retry from the task.'}</p> : null}
  </div>;
}
