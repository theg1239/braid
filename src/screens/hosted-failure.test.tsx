import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { agentFixture, missionFixture, textOf } from '../test/fixtures';
import { hostedErrors } from '../../worker/agents/errors';

let mission: ReturnType<typeof missionFixture>;
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'project', branch: 'main', head: 'base' }, missions: [mission], activity: [] }), canWrite: () => true, newMissionBlocker: () => null }));
vi.mock('../lib/resources', () => ({ useTaskChange: () => null }));
vi.mock('../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../lib/router', () => ({ paths: { settings: (section: string) => '/settings/' + section }, navigate: vi.fn(), useRoute: () => ({ id: 'task', query: new URLSearchParams() }) }));
vi.mock('../components/mission/TaskHeader', () => ({ TaskHeader: () => null }));
vi.mock('../components/mission/Topology', () => ({ Topology: () => null }));
vi.mock('../components/mission/TaskInstruction', () => ({ TaskInstruction: () => null }));

import { TaskScreen } from './TaskScreen';

it.each([hostedErrors.capacity, hostedErrors.quota, hostedErrors.collectionCommand])('shows a terminal hosted failure beside one restart control: %s', error => {
  const agent = agentFixture({ status: 'failed', failureStage: 'generation', error });
  mission = missionFixture({ source: 'live', status: 'failed', error, agents: [agent] });
  const html = renderToStaticMarkup(<TaskScreen view="task" onNewTask={() => {}} />);
  expect(textOf(html)).toContain(error);
  // The error must be visible before the person opens an agent's collapsed details.
  expect(html).not.toContain('class="agent-row__error"');
  const restart = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match => textOf(match[2]).trim() === 'Start again');
  expect(restart).toHaveLength(1);
  expect(restart[0][1]).not.toContain(' disabled=""');
});

import { failure } from '../../worker/agents/hosted-failures';
import { hostedFailureLine } from '../components/mission/hostedFailure';
import { hostedCauseLabel } from '../../shared/hosted';
import type { HostedFailureCause } from '../../shared/types';

it.each(Object.keys(hostedCauseLabel) as HostedFailureCause[])('renders typed %s evidence with one recovery control', cause => {
  const reason = failure(cause, 'command', { source: 'process', operation: 'fixture command', exitCode: 17 }, 'TOKEN=must-be-redacted\nlast command line');
  const agent = agentFixture({ status: 'failed', environment: { status: 'failed', failure: reason } });
  mission = missionFixture({ source: 'live', status: 'failed', agents: [agent] });
  const html = renderToStaticMarkup(<TaskScreen view="task" onNewTask={() => {}} />), text = textOf(html);
  expect(text).toContain(hostedFailureLine(reason)); expect(text).toContain('exit 17');
  expect(text).toContain('Last 40 lines'); expect(text).toContain('[redacted]'); expect(text).not.toContain('must-be-redacted');
  const label = reason.action === 'edit_setup' ? 'Edit setup commands' : reason.action === 'more_time' ? 'Retry with more time' : 'Retry';
  const controls = [...html.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)].filter(match => textOf(match[1]).trim() === label);
  expect(controls).toHaveLength(1); expect(html).not.toMatch(/spinner|status-dot/);
});

it('builds the failure line from provider fields and links directly to the key settings', () => {
  const reason = failure('provider', 'model', { source: 'provider', operation: 'anthropic', code: 'auth', status: 401 }, '', 'A vague upstream message');
  mission = missionFixture({ source: 'live', status: 'failed', agents: [agentFixture({ status: 'failed', environment: { status: 'failed', failure: reason } })] });
  const html = renderToStaticMarkup(<TaskScreen view="task" onNewTask={() => {}} />);
  expect(textOf(html)).toContain('Anthropic rejected the key. Reconnect it in Settings → Providers and retry.');
  expect(textOf(html)).not.toContain('A vague upstream message');
  expect(html).toContain('href="/settings/agents#providers"');
  expect(textOf(html)).toContain('Manage providers');
});

it('names the failed check and its remedy without interpreting output text', () => {
  const reason = failure('command', 'command', { source: 'process', operation: 'uv run pytest', exitCode: 1, reason: 'check_failed' }, 'no useful diagnosis');
  mission = missionFixture({ source: 'live', status: 'failed', agents: [agentFixture({ status: 'failed', environment: { status: 'failed', failure: reason } })] });
  const html = renderToStaticMarkup(<TaskScreen view="task" onNewTask={() => {}} />);
  expect(textOf(html)).toContain('The check failed. Fix the check and retry.');
  expect(html.split('uv run pytest')).toHaveLength(2); expect(html).toContain('<code>uv run pytest</code>');
});
it.each([
  ['command', 180_000, 'The command ran past its 3-minute limit. Retry with more time.'],
  ['task', 27 * 60_000, 'The task reached its 27-minute limit. Retry with more time.'],
  ['transport', 190_000, 'The sandbox did not answer within 190 seconds. Retry the task.'],
] as const)('states the exact %s limit and leaves the command to the evidence', (limitKind, timeoutMs, line) => {
  const reason = failure('timeout', 'command', { source: 'process', operation: 'go build ./cmd/lecrev', limitKind, timeoutMs, timedOut: true }, '', 'Vague timeout');
  expect(hostedFailureLine(reason)).toBe(line);
});
it('says a model timeout plainly, without repeating the operation', () => {
  const reason = failure('timeout', 'model', { source: 'workers_ai', operation: 'model request', limitKind: 'model', timeoutMs: 120_000, timedOut: true }, '', 'deadline exceeded');
  expect(hostedFailureLine(reason)).toBe('The model did not answer within 2 minutes. Retry the task.');
});
it.each([
  ['launch', 'The task workflow could not start. Retry the task.'],
  ['generation', 'The agent stopped while preparing its changes. Retry the task.'],
  ['missing_context', 'The saved task context is missing. Start a new task.'],
])('shows the exact failed stage and remedy for %s', (stage, line) => {
  const reason = failure(stage === 'missing_context' ? 'preflight' : 'workflow_step', 'workflow', { source: 'workflow', operation: 'run', reason: stage }, '', 'Unhelpful message');
  mission = missionFixture({ source: 'live', status: 'failed', agents: [agentFixture({ status: 'failed', environment: { status: 'failed', failure: reason } })] });
  const html = renderToStaticMarkup(<TaskScreen view="task" onNewTask={() => {}} />);
  expect(textOf(html)).toContain(line); expect(textOf(html)).not.toContain('Edit setup commands');
});
