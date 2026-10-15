import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../../test/fixtures';
import type { AgentConnection } from '../../account/api';
import type { WorkspaceSnapshot } from '../../../shared/types';

const state = vi.hoisted(() => ({
  task: {} as Record<string, unknown>,
  connections: { data: null as AgentConnection[] | null, error: null as string | null, refreshing: false, refresh: () => Promise.resolve(null) },
  enabled: [] as boolean[],
  snapshot: {} as WorkspaceSnapshot,
}));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => state.snapshot }));
vi.mock('../../lib/live', () => ({ peekLive: () => undefined }));
vi.mock('../../lib/needs', () => ({ LATEST_KEY: 'changes:list:latest' }));
vi.mock('../../lib/reads', () => ({ trees: { values: new Map() } }));
vi.mock('../mission/newTask', () => ({ useNewTask: () => state.task }));
vi.mock('./ConnectedAgents', () => ({ useTaskConnections: (enabled: boolean) => { state.enabled.push(enabled); return state.connections; } }));
vi.mock('./ConnectAgent', () => ({ ConnectAgentPopover: () => null }));
vi.mock('./hostedRunners', () => ({ useHostedRunners: () => ({ runner: 'workers-ai', pick: () => {}, items: [{ value: 'workers-ai', label: 'Workers AI' }] }) }));
import { TaskComposer } from './TaskComposer';
import type { MissionDraft } from '../mission/NextStep';

const owner = { blocker: null, writable: true, demo: false, sample: null, localReady: true, cloudReady: false, busy: false, error: null, start: vi.fn() };
const connection = (id: string, label: string): AgentConnection => ({ id, workspaceId: 'relay', scope: 'work', label, expires: Date.now() + 60_000 });
const render = (draft: MissionDraft | null = null) => renderToStaticMarkup(<TaskComposer draft={draft} />);
const startLabel = (html: string) => textOf(html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/)?.[0] ?? '').trim();
/** Whether Start is disabled, from its attribute rather than its disabled: styles. */
const startDisabled = (html: string) => / disabled=""/.test(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '');
beforeEach(() => {
  state.task = { ...owner };
  state.connections = { data: [], error: null, refreshing: false, refresh: () => Promise.resolve(null) };
  state.enabled = [];
  state.snapshot = { project: { id: 'relay', name: 'relay', branch: 'main', head: 'a', description: '', stack: [] }, capabilities: { mode: 'live' }, files: { 'README.md': '', 'src/delivery.ts': '' }, missions: [] } as unknown as WorkspaceSnapshot;
});

describe('task composer', () => {
  it('gives a visitor the reason in the picker’s place and never waits on connections they cannot read', () => {
    state.task = { ...owner, writable: false, blocker: 'Sign in to start a task.' };
    state.connections = { ...state.connections, data: null };
    const html = render();
    expect(state.enabled).toEqual([false]);
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('aria-label="Agents"');
    expect(textOf(html)).toContain('Sign in to start a task.');
    expect(startDisabled(html)).toBe(true);
  });
  it('starts on the person’s first connected agent', () => {
    state.connections = { ...state.connections, data: [connection('c1', 'Claude Code on MacBook Pro'), connection('c2', 'Codex on build-box')] };
    const html = render();
    expect(state.enabled).toEqual([true]);
    expect(html).toContain('aria-label="Agents"');
    expect(textOf(html)).toContain('Claude Code on MacBook Pro');
    expect(textOf(html)).not.toContain('No work connections');
    expect(startLabel(html)).toBe('Start task');
  });
  it('starts a task again on the same agents and says how many when there are several', () => {
    state.connections = { ...state.connections, data: [connection('c1', 'Claude Code on MacBook Pro'), connection('c2', 'Codex on build-box')] };
    const again = { title: 'Limit deliveries', intent: 'Limit deliveries per endpoint.', execution: 'local' as const, connectionIds: ['c1', 'c2'] };
    const html = render(again);
    expect(textOf(html)).toContain('Claude Code on MacBook Pro +1');
    expect(startLabel(html)).toBe('Start 2 agents');
    expect(html).toContain('Limit deliveries per endpoint.</textarea>');
    state.task = { ...owner, cloudReady: true };
    expect(startLabel(render({ ...again, execution: 'cloud', agentCount: 3, connectionIds: [] }))).toBe('Start 3 agents');
    expect(textOf(render({ ...again, execution: 'cloud', agentCount: 3, connectionIds: [] }))).toContain('3 of Braid’s agents');
    // An agent that is no longer connected falls back to the first that can run.
    expect(startLabel(render({ ...again, connectionIds: ['gone'] }))).toBe('Start task');
  });
  it('starts on one of Braid’s agents when nothing is connected, so a brief is all Start needs', () => {
    state.task = { ...owner, cloudReady: true };
    const html = render();
    expect(textOf(html)).toContain('Braid’s agent');
    expect(startLabel(html)).toBe('Start task');
    expect(startDisabled(html)).toBe(true);
    expect(html).not.toContain('title="Connect an agent to start a task."');
  });
  it('offers one Connect an agent when nothing can run, and says so on Start', () => {
    const html = render();
    expect(textOf(html).match(/Connect an agent/g)).toHaveLength(1);
    expect(html).toContain('title="Connect an agent to start a task."');
    expect(html).not.toContain('aria-label="Agents"');
  });
  it('replays the recorded task, labelled as a replay, with no picker and no simulated tag', () => {
    state.task = { ...owner, demo: true, sample: { title: 'Limit deliveries per endpoint', intent: 'Keep Relay from overwhelming a busy receiver.' } };
    const html = render();
    expect(textOf(html)).toContain('Limit deliveries per endpoint');
    expect(textOf(html)).not.toContain('Simulated');
    expect(html).toContain('aria-label="Replay recorded task"');
    expect(textOf(html)).toContain('Replay');
    expect(startDisabled(html)).toBe(false);
    expect(html).not.toContain('aria-label="Agents"');
    expect(state.enabled).toEqual([false]);
    expect(html).not.toContain('Task suggestions');
    expect(html).not.toContain('<textarea');
  });
  it('offers repository-specific suggestions as buttons that cannot submit the form', () => {
    const html = render();
    const suggestions = html.match(/<div[^>]*aria-label="Task suggestions".*?<\/div>/)?.[0] ?? '';
    expect(textOf(suggestions)).toContain('Add tests for src/delivery.ts');
    expect(textOf(suggestions)).toContain('Document src/delivery.ts in README.md');
    expect(suggestions.match(/type="button"/g)).toHaveLength(2);
    expect(suggestions).not.toContain('disabled=""');
    expect(startDisabled(html)).toBe(true);
  });
  it('keeps suggestion space but protects an existing draft, a busy submission and a read-only repository', () => {
    for (const mode of ['draft', 'busy', 'readonly']) {
      state.task = { ...owner, ...(mode === 'busy' ? { busy: true } : mode === 'readonly' ? { blocker: 'Sign in to start a task.' } : {}) };
      const html = render(mode === 'draft' ? { title: 'My task', intent: 'Keep my brief.', execution: 'local' } : null);
      const suggestions = html.match(/<div[^>]*aria-label="Task suggestions".*?<\/div>/)?.[0] ?? '';
      expect(suggestions.match(/ disabled=""/g)).toHaveLength(2);
      if (mode === 'draft') expect(html).toContain('Keep my brief.</textarea>');
    }
  });
});
