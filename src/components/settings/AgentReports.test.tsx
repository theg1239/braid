import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentReport, AgentReports } from '../../../shared/types';
import { AgentReportsSection } from './AgentReports';
import { api } from '../../lib/api';
import { setLive, type Live } from '../../lib/live';

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, buttons: new Map<string, { disabled?: boolean; onClick?(): void }>(), resets: new Set<() => void>() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => {
  const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial;
  return [state.values[index], (value: unknown) => { state.values[index] = value; }];
} }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-13T12:10:00Z') }));
vi.mock('../../lib/live', () => ({ setLive: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { resolveAgentReport: vi.fn() }, errorMessage: (error: Error) => error.message,
  onWorkspaceReset: (listener: () => void) => { state.resets.add(listener); return () => state.resets.delete(listener); } }));
vi.mock('../../lib/router', () => ({ paths: { pull: (number: number) => `/pull/${number}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ children, ...props }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => <a {...props}>{children}</a> }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  state.buttons.set(props['aria-label'] ?? String(props.children), props as { disabled?: boolean; onClick?(): void });
  return <button type="button" disabled={props.disabled} aria-label={props['aria-label']}>{props.children}</button>;
} }));

const report: AgentReport = { id: 'ar_00000000-0000-0000-0000-000000000001', summary: '<img src=x onerror="alert(1)"> **Missing tool**',
  details: '<script>alert(2)</script>\n[click](javascript:alert(3))\n**literal**', tool: '<b>create_branch</b>', createdAt: '2026-10-13T12:00:00Z',
  pullRequest: 42, agent: { connection: 'connection-1', name: 'Codex', model: 'gpt-6', owner: { name: '@maya' } } };
const live = (data: AgentReports | null, error: string | null = null): Live<AgentReports> => ({ data, error, loading: !data && !error, refreshing: false, errorStatus: null, updatedAt: null, refresh: vi.fn() });
const render = (value = live({ items: [report], canResolve: true })) => { state.cursor = 0; state.buttons.clear(); return renderToStaticMarkup(<AgentReportsSection live={value} />); };
beforeEach(() => { state.values = []; state.resets.clear(); vi.clearAllMocks(); });

describe('reports from agents', () => {
  it('renders every text field literally, with attribution, tool, time and the local pull request link', () => {
    const html = render();
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; **Missing tool**');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('[click](javascript:alert(3))');
    expect(html).toContain('&lt;b&gt;create_branch&lt;/b&gt;');
    expect(html).not.toMatch(/<img|<script|<strong|<b>|href="javascript:/);
    expect(html).toContain('GPT-6 for @maya');
    expect(html).toContain('Connection: connection-1');
    expect(html).toContain('href="/pull/42"');
    expect(html).toContain('10m ago');
    expect(html).toContain('Details');
  });

  it('does not offer Resolve to members and replaces both the list and count with the owner’s saved response', async () => {
    expect(render(live({ items: [report], canResolve: false }))).not.toContain('Resolve:');
    const saved = { items: [], canResolve: true };
    vi.mocked(api.resolveAgentReport).mockResolvedValue(saved);
    render(); state.buttons.get(`Resolve: ${report.summary}`)!.onClick!();
    await vi.waitFor(() => expect(setLive).toHaveBeenCalledWith('agent-reports', saved));
    expect(api.resolveAgentReport).toHaveBeenCalledExactlyOnceWith(report.id);
    expect(render(live(saved))).toContain('No unresolved reports.');
    expect(render(live(saved))).not.toContain('Missing tool');
  });

  it('keeps a report on screen if resolving fails and prevents another click while saving', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(api.resolveAgentReport).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    render(); state.buttons.get(`Resolve: ${report.summary}`)!.onClick!();
    render(); expect(state.buttons.get(`Resolve: ${report.summary}`)!.disabled).toBe(true);
    fail(new Error('Only repository owners can resolve agent reports.'));
    await vi.waitFor(() => expect(state.values[0]).toBe(false));
    expect(render()).toContain('Only repository owners can resolve agent reports.');
    expect(render()).toContain('Missing tool');
    expect(setLive).not.toHaveBeenCalled();
  });

  it('reserves the list region during loading and empty states and offers retry after a failed read', () => {
    for (const value of [live(null), live({ items: [], canResolve: false }), live(null, 'Unavailable')]) expect(render(value)).toContain('class="agent-reports"');
    expect(render(live(null))).toContain('Loading reports');
    expect(render(live(null, 'Unavailable'))).toContain('Try again');
    expect(state.buttons.has(`Resolve: ${report.summary}`)).toBe(false);
  });

  it('does not put a late resolution response into another repository or session', async () => {
    let finish!: (data: AgentReports) => void;
    vi.mocked(api.resolveAgentReport).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(); state.buttons.get(`Resolve: ${report.summary}`)!.onClick!();
    for (const reset of state.resets) reset();
    finish({ items: [], canResolve: true });
    await vi.waitFor(() => expect(state.resets.size).toBe(0));
    expect(setLive).not.toHaveBeenCalled();
  });
});
