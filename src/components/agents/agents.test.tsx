import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { agentFixture, missionFixture, textOf } from '../../test/fixtures';
import type { Agent, AgentRecord, ChangeSummary, Mission } from '../../../shared/types';

vi.mock('../../lib/router', () => ({
  paths: { task: (id: string) => `/example/relay/tasks/${id}`, pull: (n: number) => `/example/relay/pull/${n}`, agentPulls: (id: string) => `/example/relay/pulls?agent=${encodeURIComponent(id)}` },
  navigate: vi.fn(),
}));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('../../lib/live', () => ({ useLive: () => null }));
vi.mock('../../lib/api', () => ({ api: { agents: async () => [] } }));

import { Fleet, FleetTable, fleetColumns } from './Fleet';
import { mergeRate } from './AgentDetail';
import { TaskRow, sortTasks, taskCounts, taskMatches, taskState } from './TaskRows';

const HEAD = '50930eca13e2e06c526cc8171d1f83a5dab1f7ce';
const NOW = Date.parse('2026-10-12T12:00:00Z');

const agent = (name: string, over: Partial<Agent> = {}) => agentFixture({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  role: 'Reliability',
  color: '#888',
  changes: [{ path: 'src/limits.ts', before: '', after: `${name}\n`, afterHash: name, additions: 19, deletions: 0 }],
  ...over,
});

const mission = (over: Partial<Mission>) => missionFixture({ id: 'task-limits', title: 'Limit deliveries per endpoint', createdAt: '2026-10-12T11:59:45Z', baseCommit: HEAD, ...over });

const choice = mission({
  agents: [agent('Claude Opus 5.5'), agent('GPT-6.1 Sol', { changes: [{ path: 'src/limits.ts', before: '', after: 'sol\n', afterHash: 'sol', additions: 21, deletions: 0 }] }), agent('Gemini 3 Pro', { changes: [{ path: 'docs/limits.md', before: '', after: 'docs\n', afterHash: 'docs', additions: 6, deletions: 0 }] })],
  collisions: [{ id: 'c1', path: 'src/limits.ts', agentIds: ['claude-opus-5-5', 'gpt-6-1-sol'] }],
});
const working = mission({ id: 'task-retry', title: 'Parse Retry-After before retrying', status: 'running', createdAt: '2026-10-12T11:58:00Z', agents: [agent('Claude Fable 5.1', { status: 'working', changes: [] })] });
const merged = mission({
  id: 'task-sign',
  title: 'Sign webhook payloads',
  status: 'merged',
  createdAt: '2026-10-10T09:00:00Z',
  mergedAt: '2026-10-10T10:00:00Z',
  agents: [agent('GPT-6.1 Sol', { status: 'merged', change: { id: 'ch-23', number: 23, status: 'landed' } })],
});

const row = (m: Mission, writable = true) => renderToStaticMarkup(<TaskRow mission={m} head={HEAD} now={NOW} writable={writable} />);

describe('Task rows', () => {
  it('put the person first, then the fleet, then what is done', () => {
    expect(sortTasks([merged, working, choice], HEAD).map((m) => m.id)).toEqual(['task-limits', 'task-retry', 'task-sign']);
    expect(taskCounts([merged, working, choice], HEAD)).toEqual({ running: 1, needs: 1 });
  });

  it('filters decisions and running work without losing finished tasks from All', () => {
    const tasks = [merged, working, choice];
    expect(tasks.filter((task) => taskMatches(task, HEAD, 'all'))).toEqual(tasks);
    expect(tasks.filter((task) => taskMatches(task, HEAD, 'needs'))).toEqual([choice]);
    expect(tasks.filter((task) => taskMatches(task, HEAD, 'running'))).toEqual([working]);
  });

  it("tags no task as simulated: the tour's Recorded banner says what a replay is", () => {
    expect(textOf(row(choice))).not.toContain('Simulated');
    expect(textOf(row({ ...choice, source: 'live' }))).not.toContain('Simulated');
  });

  it('mark a task that needs a choice with one icon and the reason, the agents by model, its files and its age', () => {
    const html = row(choice);
    expect(taskState(choice, HEAD)).toBe('decide');
    expect(html).toContain('data-state="decide"');
    expect(html).toContain('aria-label="Needs your choice"');
    expect(html.match(/class="label"/g)).toHaveLength(1);
    const words = textOf(html);
    expect(words).toContain('Claude Opus 5.5, GPT-6.1 Sol, Gemini 3 Pro');
    expect(words).toContain('2 files');
    expect(words).toContain('+25');
    expect(words).toMatch(/started 15s ago/);
    expect(html).toContain('href="/example/relay/tasks/task-limits"');
    expect(html).not.toContain('status-badge');
  });

  it('say that a running task is working, without a label', () => {
    const html = row(working);
    expect(html).toContain('data-state="working"');
    expect(html).not.toContain('class="label"');
    expect(textOf(html)).toMatch(/Working .*Claude Fable 5\.1 .*started 2m ago/);
  });

  it('asks the owner when the viewer cannot choose a version, including the accessible state', () => {
    const html = row(choice, false);
    expect(textOf(html)).toContain('Needs the owner');
    expect(html).toContain('aria-label="Needs the owner"');
    expect(html).not.toContain('Needs your choice');
    expect(textOf(row(working, false))).toContain('Working');
    expect(textOf(row(merged, false))).not.toContain('Needs the owner');
  });

  it('link a merged task to its pull request and say when it merged', () => {
    const html = row(merged);
    expect(html).toContain('data-state="merged"');
    expect(html).toContain('href="/example/relay/pull/23"');
    expect(textOf(html)).toMatch(/#23 .*merged 2d ago/);
  });
});

const record = (name: string, over: Partial<AgentRecord> & Pick<AgentRecord, 'changes' | 'lines'>): AgentRecord => ({
  id: `["${name}","user:maya","claude-code"]`,
  name,
  owner: { id: 'user:maya', name: 'Maya Chen', github: 'maya-chen' },
  models: [name],
  tools: ['claude-code/2.4.1'],
  firstActive: '2026-10-11T20:11:53Z',
  lastActive: '2026-10-11T20:11:58Z',
  ...over,
});

const fleet: AgentRecord[] = [
  record('Claude Opus 5.5', { changes: { landed: 2, sentBack: 1, reverted: 0, open: 0 }, lines: { added: 17, alive: 16 } }),
  record('Simulated', { simulated: true, tools: [], changes: { landed: 37, sentBack: 0, reverted: 0, open: 0 }, lines: { added: 237, alive: 230 } }),
  record('Gemini 3 Pro', { owner: { id: 'user:dev', name: 'Dev Okafor', github: 'devokafor' }, tools: ['gemini-cli/0.9.2'], changes: { landed: 0, sentBack: 1, reverted: 0, open: 3 }, lines: { added: 0, alive: 0 } }),
];

describe('The fleet', () => {
  it('calculates merge rate from finished PRs, excluding open work and repeat reviews', () => {
    const items: Pick<ChangeSummary, 'status'>[] = [{ status: 'landed' }, { status: 'landed' }, { status: 'landed' }, { status: 'closed' }, { status: 'revise' }, { status: 'open' }, { status: 'queued' }];
    expect(mergeRate(items)).toEqual({ rate: 75, merged: 3, finished: 4 });
    expect(mergeRate([{ status: 'open' }])).toEqual({ rate: null, merged: 0, finished: 0 });
    expect(mergeRate([{ status: 'closed' }]).rate).toBe(0);
    expect(mergeRate([{ status: 'landed' }]).rate).toBe(100);
  });

  it('exposes details with a labelled control and keeps the direct pull-request link', () => {
    const html = renderToStaticMarkup(<FleetTable records={[fleet[0]]} />);
    expect(html).toContain('aria-label="Show Claude Opus 5.5 for @maya-chen details"');
    expect(html).toContain('aria-expanded="false"');
    expect(textOf(html)).toContain('Lines added');
    expect(html).toContain(`href="/example/relay/pulls?agent=${encodeURIComponent(fleet[0].id)}"`);
  });
  it('drops counts that are zero for every agent and keeps Merged', () => {
    expect(fleetColumns(fleet).map((c) => c.label)).toEqual(['Merged', 'Sent back', 'Open']);
    expect(fleetColumns([record('GPT-6 Astra', { changes: { landed: 0, sentBack: 0, reverted: 0, open: 0 }, lines: { added: 0, alive: 0 } })]).map((c) => c.label)).toEqual(['Merged']);
  });

  it('lists each agent as its model for its owner with the tool, busiest on main first and simulated agents last, each row opening its pull requests', () => {
    const html = renderToStaticMarkup(<FleetTable records={fleet} />);
    const words = textOf(html);
    expect(words).not.toContain('Reverted');
    expect(words).toMatch(/Claude Opus 5\.5 for @maya-chen claude-code .*Gemini 3 Pro for @devokafor gemini-cli .*Simulated for @maya-chen/);
    expect(html).toContain(`href="/example/relay/pulls?agent=${encodeURIComponent(fleet[0].id)}"`);
    expect(html).toContain('title="16 of 17 lines added still on main"');
    expect(html).toContain('--added:0.0717');
    expect(html).toContain('--added:1;--alive:0.97');
    expect(html.match(/data-zero="true"/g)).toHaveLength(5);
    expect(html.match(/<i class="fleet__bar-alive">/g)).toHaveLength(2);
  });

  it('says in one quiet line that no agent has worked here, leaving connecting to the composer', () => {
    const html = renderToStaticMarkup(<Fleet live={{ data: [], error: null, errorStatus: null, loading: false, refreshing: false, updatedAt: 1, refresh: async () => [] }} />);
    expect(html).toContain('<p class="agents-empty">No agents yet.</p>');
    expect(html).not.toContain('class="state"');
    expect(textOf(html)).not.toContain('Copy setup prompt');
  });
});
