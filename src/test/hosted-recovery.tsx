/** Development-only entry. No application entry imports this fixture. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@cloudflare/kumo';
import '@cloudflare/kumo/styles/standalone';
import '../styles/index.css';
import { HostedAgentRun } from '../components/mission/HostedRun';
import { HostedActivity } from '../components/agents/HostedActivity';
import type { Agent, HostedEnvironment, HostedFailureCause, HostedPreflight } from '../../shared/types';
import { hostedCauseLabel } from '../../shared/hosted';
import { failure, HostedFailureError, retryHosted } from '../../worker/agents/hosted-failures';
import { hostedOutput } from '../../worker/agents/hosted-output';
import { runAgentLoop, type AgentLoopCheckpoint } from '../../worker/agents/loop';
import { hostedCommand } from '../../worker/agents/hosted-command';
import { collectSandboxResult } from '../../worker/agents/sandbox-collection';
import { FakeHostedAi, FakeHostedContainer, hostedTask, prepareTurn, workTurn, finishTurn } from '../../worker/agents/hosted-test-runtime';
import { agentFixture } from './fixtures';

const fixtureCauses = Object.keys(hostedCauseLabel) as HostedFailureCause[];
const setup: HostedPreflight = { commit: hostedTask.baseCommit, setup: 'npm ci', checks: ['npm test'], runtimes: [{ name: 'Node', version: '24', path: '.node-version' }], lockfiles: ['package-lock.json'], missing: [] };
const evidence: Record<HostedFailureCause, Parameters<typeof failure>[2]> = {
  container_start: { source: 'container', operation: 'container start' }, image_pull: { source: 'container', operation: 'container start', code: 'ImagePullError' },
  out_of_memory: { source: 'process', operation: 'npm test', signal: 9, oomKilled: true }, process_killed: { source: 'process', operation: 'npm test', signal: 9 },
  disk_full: { source: 'process', operation: 'npm ci', code: 'ENOSPC', diskAvailableBytes: 0 }, install_failed: { source: 'process', operation: 'npm ci', exitCode: 17 },
  network: { source: 'process', operation: 'Git host TLS check', code: 'ENETUNREACH' }, timeout: { source: 'process', operation: 'npm test', signal: 15, timedOut: true },
  provider: { source: 'workers_ai', operation: 'model request', status: 503, providerCode: 3040 }, collection: { source: 'collector', operation: 'collect changes', exitCode: 1, reason: 'collectionCommand' },
  workflow_step: { source: 'workflow', operation: 'run fixture-agent', step: 'run fixture-agent retry 3' }, preflight: { source: 'repository', operation: 'repository setup', reason: 'missing_configuration' },
  command: { source: 'process', operation: 'git checkout', exitCode: 128 }, interrupted: { source: 'process', operation: 'npm test', code: 'BRAID_COMMAND_INCOMPLETE' },
};
function failedAgent(cause: HostedFailureCause): Agent {
  const reason = failure(cause, cause === 'install_failed' ? 'setup' : cause === 'provider' ? 'model' : cause === 'workflow_step' ? 'workflow' : cause === 'preflight' ? 'preflight' : 'command', evidence[cause],
    hostedOutput(Array.from({ length: 45 }, (_, index) => `command output ${index + 1}`).join('\n') + '\nTOKEN=fixture-secret\nAuthorization: Bearer fixture-bearer'));
  if (cause === 'preflight') reason.message = 'Configure setup commands in Settings → Rules.';
  return agentFixture({ name: 'Coding agent', status: 'failed', environment: { status: 'failed', failure: reason, preflight: setup }, hostedActivity: [{ id: 'fixture:1', sequence: 1, at: reason.at, source: 'hosted', kind: 'failed', message: reason.message, failure: { code: cause, summary: reason.message, retryable: reason.retryable, lines: reason.output.split('\n'), evidence: reason.evidence, action: reason.action } }] });
}
function Fixture() {
  const query = new URLSearchParams(location.search);
  const requested = query.get('state');
  const state = fixtureCauses.includes(requested as HostedFailureCause) ? requested as HostedFailureCause : null;
  const [agent, setAgent] = useState<Agent>(() => state ? failedAgent(state) : agentFixture({ name: 'Coding agent', status: 'queued', environment: { status: 'preflight', preflight: setup } }));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  async function run() {
    setBusy(true); setResult('');
    const first = prepareTurn();
    first.choices[0].message.tool_calls.push(...workTurn().choices[0].message.tool_calls);
    const runtime = new FakeHostedContainer(), ai = new FakeHostedAi(first);
    runtime.startFailures = [new Error('injected container start rejection')];
    ai.answers = [new Response('{}', { status: 503 }), finishTurn()];
    const task = { ...hostedTask, provider: undefined, repository: { manifests: [], lockfiles: [], instructions: [], omitted: 0 } };
    let current = agentFixture({ name: 'Coding agent', status: 'working', environment: { status: 'preflight', preflight: setup }, hostedActivity: [] });
    const report = async (message: string, environment?: HostedEnvironment) => {
      const reason = environment?.failure;
      const sequence = (current.hostedActivity?.at(-1)?.sequence ?? 0) + 1;
      current = { ...current, environment: environment ? { ...environment, preflight: setup, recovered: environment.recovered ?? current.environment?.recovered } : current.environment,
        hostedActivity: [...(current.hostedActivity ?? []), { id: `fixture:${sequence}`, sequence, at: new Date().toISOString(), source: 'hosted', kind: environment?.status === 'failed' ? 'failed' : environment?.status === 'completed' ? 'finished' : 'working', message,
          ...(reason ? { failure: { code: reason.cause, summary: reason.message, retryable: reason.retryable, lines: reason.output.split('\n'), evidence: reason.evidence, action: reason.action } } : {}) }] };
      setAgent(current);
    };
    let saved: AgentLoopCheckpoint | undefined;
    const counts = new Map<string, number>();
    const attempts = (key: string) => ({ read: () => counts.get(key) ?? 0, write: (value: number) => { counts.set(key, value); } });
    const deadline = Date.now() + 60_000;
    try {
      await retryHosted(async () => { runtime.start(); }, { deadline, phase: 'start', operation: 'container start', report, authorize: async () => {}, attempts: attempts('start') });
      await report('Repository ready', { status: 'running' });
      await runAgentLoop(task, ai as unknown as Ai, { report, attempts,
        checkpoint: async message => { if (message) await report(message); }, load: () => saved, save: value => { saved = structuredClone(value); },
        exec: (command, timeout, id) => hostedCommand(runtime as unknown as Container, `fixture:${id}`, ['bash', '-c', command], timeout, {}),
        collect: async id => collectSandboxResult(await hostedCommand(runtime as unknown as Container, `fixture:collect:${id}`, ['/usr/local/bin/node', '/opt/braid/collect.mjs', task.baseCommit], 10_000, {})),
      }, deadline);
      await report('Changes ready for review', { status: 'completed' });
      setResult(`Recovered automatically · ${runtime.starts} container attempts · ${ai.calls} model calls · ${runtime.executions.filter(argv => argv.includes('bash')).length} edit command`);
    } catch (error) {
      if (error instanceof HostedFailureError) await report(error.failure.message, { status: 'failed', failure: error.failure });
      else setResult('Fixture failed: ' + String(error));
    } finally { setBusy(false); }
  }
  const action = agent.environment?.failure?.action;
  return <main style={{ maxWidth: 920, margin: '32px auto', padding: '0 20px' }}>
    <p style={{ color: 'var(--fg-3)', fontSize: 12 }}>Development fixture · fake container and model · no account</p>
    <h1 style={{ fontSize: 24, margin: '16px 0 8px' }}>Recover the cloud agent</h1>
    <p style={{ marginBottom: 24 }}>Task #1 · {agent.environment?.status === 'completed' ? 'Ready for review' : agent.environment?.status === 'failed' ? 'Failed' : 'Cloud agent'}</p>
    <HostedAgentRun agent={agent} />
    <div style={{ margin: '16px 0' }}><Button variant="primary" disabled={busy} onClick={() => { if (action === 'edit_setup') setResult('Setup editor: .braid/policy.json · install and checks'); else void run(); }}>{action === 'edit_setup' ? 'Edit setup commands' : action === 'more_time' ? 'Retry with more time' : action ? 'Retry' : 'Run recovery'}</Button></div>
    <p role="status" data-fixture-result>{result}</p>
    <h2 style={{ fontSize: 16, marginTop: 32 }}>Pull request timeline</h2>
    <div style={{ margin: '16px 0 32px' }}>{agent.hostedActivity?.map(event => <HostedActivity key={event.id} agent={agent} event={event} now={Date.now()} />)}</div>
    <details><summary>Failure states</summary><nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>{fixtureCauses.map(cause => <a key={cause} href={`?state=${cause}`}>{hostedCauseLabel[cause]}</a>)}</nav></details>
  </main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(<Fixture />);
