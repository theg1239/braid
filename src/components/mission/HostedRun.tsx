import type { Agent, HostedFailure, Mission } from '../../../shared/types';
import { hostedCauseLabel } from '../../../shared/hosted';
import { ActivitySummary } from '../agents/ActivitySummary';
import { absoluteTime, plural } from '../../lib/format';
import { hostedFailureLine } from './hostedFailure';
import type { HostedTiming } from '../../../worker/agents/hosted-limits';
import './hosted-run.css';

export function hostedEvidence(reason: Pick<HostedFailure, 'evidence'>, includeOperation = true): string {
  const value: HostedFailure['evidence'] & HostedTiming = reason.evidence;
  return [includeOperation ? value.operation : '', value.status !== undefined ? `HTTP ${value.status}` : '', value.providerCode !== undefined ? `Workers AI ${value.providerCode}` : '',
    value.exitCode !== undefined ? `exit ${value.exitCode}` : '', value.signal !== undefined ? `signal ${value.signal}` : '', value.code,
    value.oomKilled ? 'OOM confirmed' : '', value.diskAvailableBytes === 0 ? '0 bytes available' : '', value.timedOut ? 'deadline exceeded' : '',
    value.elapsedMs !== undefined ? `${Math.ceil(value.elapsedMs / 1000)}s elapsed` : '', value.retryAfterMs !== undefined ? `retry after ${value.retryAfterMs / 1000}s` : '', value.reason, value.truncated ? 'output truncated' : '', value.step].filter(Boolean).join(' · ');
}

export function HostedAgentRun({ agent }: { agent: Agent }) {
  const environment = agent.environment;
  if (!environment) return null;
  const reason = environment.failure;
  const latest = agent.hostedActivity?.at(-1);
  const retry = environment.retry;
  const preflight = environment.preflight;
  const checks = agent.checks?.filter(check => check.kind === 'runtime' && check.status !== 'warning') ?? [];
  return <section className="hosted-run" data-state={environment.status} aria-label={`${agent.name} cloud run`}>
    <div className="hosted-run__heading"><strong>{agent.name}</strong><span>Cloudflare</span></div>
    {reason ? <>
      <p className="hosted-run__message" role={environment.status === 'failed' ? 'alert' : 'status'}>{hostedFailureLine(reason)}</p>
      <p className="hosted-run__evidence"><code>{reason.evidence.operation}</code>{hostedEvidence(reason, false)}</p>
      {retry ? <p className="hosted-run__retry">Retried {retry.attempt} of {retry.limit} · {hostedCauseLabel[reason.cause]}</p> : null}
      {reason.output ? <details className="hosted-run__output" open><summary>Last 40 lines · redacted</summary><pre tabIndex={0}>{reason.output}</pre></details> : null}
    </> : latest ? <p className="hosted-run__message" role="status"><ActivitySummary event={latest} /></p> : agent.progress ? <p className="hosted-run__message" role="status">{agent.progress.message}</p> : null}
    {environment.recovered && !retry && !reason ? <p className="hosted-run__retry">Recovered after {plural(environment.recovered.attempts, 'retry', 'retries')} · {hostedCauseLabel[environment.recovered.cause]}</p> : null}
    {preflight ? <details className="hosted-run__setup"><summary>Run setup</summary><dl>
      <dt>Setup</dt><dd>{environment.prepared?.length
        ? <><span className="quiet">Prepared by the agent</span><code>{environment.prepared.map(step => step.status === 'failed' ? `${step.command}  # failed` : step.command).join('\n')}</code></>
        : <code>{preflight.setup || 'Not configured'}</code>}</dd>
      <dt>Checks</dt><dd><code>{checks.length ? checks.map(check => `${check.label}  # ${check.status}`).join('\n') : preflight.checks.join('\n') || 'Not configured'}</code></dd>
      <dt>Runtime</dt><dd>{preflight.runtimes.length ? preflight.runtimes.map(runtime => `${runtime.name} ${runtime.version} (${runtime.path})`).join(' · ') : 'See repository manifests'}</dd>
      <dt>Lockfile</dt><dd>{preflight.lockfiles.join(', ') || 'None at repository root'}</dd>
    </dl></details> : null}
    {(agent.hostedActivity?.length ?? 0) > 1 ? <details className="hosted-run__history"><summary>Run history</summary><ol>{agent.hostedActivity!.map(event => <li key={event.id}><ActivitySummary event={event} /><time dateTime={event.at}>{absoluteTime(event.at)}</time></li>)}</ol></details> : null}
  </section>;
}

export function HostedRun({ mission }: { mission: Mission }) {
  if (mission.execution !== 'cloud') return null;
  return <div className="hosted-runs">{mission.agents.filter(agent => agent.environment).map(agent => <HostedAgentRun key={agent.id} agent={agent} />)}</div>;
}
