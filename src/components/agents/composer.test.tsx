import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../../test/fixtures';
import type { WorkspaceSnapshot } from '../../../shared/types';

const state = vi.hoisted(() => ({
  task: {} as Record<string, unknown>,
  snapshot: {} as WorkspaceSnapshot,
}));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => state.snapshot }));
vi.mock('../../lib/live', () => ({ peekLive: () => undefined }));
vi.mock('../../lib/needs', () => ({ LATEST_KEY: 'changes:list:latest' }));
vi.mock('../../lib/reads', () => ({ trees: { values: new Map() } }));
vi.mock('../mission/newTask', () => ({ useNewTask: () => state.task }));
vi.mock('./hostedRunners', () => ({ useHostedRunners: () => ({ runner: 'workers-ai', pick: () => {}, items: [{ value: 'workers-ai', label: 'Workers AI' }] }) }));
import { TaskComposer } from './TaskComposer';
import type { MissionDraft } from '../mission/NextStep';

const owner = { blocker: null, writable: true, demo: false, sample: null, localReady: true, cloudReady: false, busy: false, error: null, start: vi.fn() };
const render = (draft: MissionDraft | null = null) => renderToStaticMarkup(<TaskComposer draft={draft} />);
const startLabel = (html: string) => textOf(html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/)?.[0] ?? '').trim();
/** Whether Start is disabled, from its attribute rather than its disabled: styles. */
const startDisabled = (html: string) => / disabled=""/.test(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '');
beforeEach(() => {
  state.task = { ...owner };
  state.snapshot = { project: { id: 'relay', name: 'relay', branch: 'main', head: 'a', description: '', stack: [] }, capabilities: { mode: 'live' }, files: { 'README.md': '', 'src/delivery.ts': '' }, missions: [] } as unknown as WorkspaceSnapshot;
});

describe('task composer', () => {
  it('gives a visitor the reason in the picker’s place', () => {
    state.task = { ...owner, writable: false, blocker: 'Sign in to start a task.' };
    const html = render();
    expect(html).not.toContain('aria-label="Agents"');
    expect(textOf(html)).toContain('Sign in to start a task.');
    expect(startDisabled(html)).toBe(true);
  });
  it('starts locally, so whichever of the person’s agents gets the prompt takes the task', () => {
    const html = render();
    expect(html).toContain('aria-label="Agents"');
    expect(textOf(html)).toContain('Local');
    expect(textOf(html)).not.toContain('Connect an agent');
    expect(startLabel(html)).toBe('Start task');
  });
  it('starts a task again where it ran and says how many of Braid’s agents run', () => {
    state.task = { ...owner, cloudReady: true };
    const again = { title: 'Limit deliveries', intent: 'Limit deliveries per endpoint.', execution: 'cloud' as const, agentCount: 3 as const };
    const html = render(again);
    expect(startLabel(html)).toBe('Start 3 agents');
    expect(textOf(html)).toContain('3 of Braid’s agents');
    expect(html).toContain('Limit deliveries per endpoint.</textarea>');
    expect(textOf(render({ ...again, execution: 'local' }))).toContain('Local');
  });
  it('starts on one of Braid’s agents when local agents are unavailable', () => {
    state.task = { ...owner, localReady: false, cloudReady: true };
    const html = render();
    expect(textOf(html)).toContain('Braid’s agent');
    expect(startLabel(html)).toBe('Start task');
    expect(startDisabled(html)).toBe(true);
  });
  it('says so when nothing can run', () => {
    state.task = { ...owner, localReady: false };
    const html = render();
    expect(textOf(html)).toContain('Hosted agents are not available here.');
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
