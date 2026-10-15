import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { activityRunning, type LocalActivityRun } from '../../../shared/agent-activity';

const live = vi.hoisted(() => ({ value: { data: null as unknown, error: null as string | null } }));
vi.mock('../../lib/live', () => ({ useLive: (_key: string, load: () => unknown) => { load(); return live.value; } }));
const localActivity = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({ api: { localActivity } }));
vi.mock('../../lib/router', () => ({ paths: { pull: (n: number) => `/pull/${n}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const { default: LocalActivity } = await import('./LocalActivity');

const at = new Date().toISOString();
const running: LocalActivityRun = { id: 'r1', session: 's1', startedAt: at, lastSeenAt: at, agent: { name: 'Claude Opus 5.5', owner: { name: '@owner' } },
  events: [{ id: '1', sequence: 1, at, source: 'claude-hook', kind: 'editing', path: 'src/x.ts' }] };

describe('local activity on Agents and on a pull request', () => {
  it('shows no Now box while nothing runs, while loading, or after a failed read', () => {
    for (const value of [{ data: null, error: null }, { data: { items: [] }, error: null }, { data: null, error: 'Unavailable' }]) {
      live.value = value;
      expect(renderToStaticMarkup(<LocalActivity />)).toBe('');
    }
  });
  it('shows Now with each running agent, and a pull request timeline even when it is empty', () => {
    expect(activityRunning(running)).toBe(true);
    live.value = { data: { items: [running] }, error: null };
    expect(renderToStaticMarkup(<LocalActivity />)).toContain('Claude Opus 5.5');
    live.value = { data: { items: [] }, error: null };
    expect(renderToStaticMarkup(<LocalActivity changeId="ch_0123456789abc" />)).toContain('Local activity');
    // Reads go through the repository-scoped client, which sends X-Braid-Workspace.
    expect(localActivity).toHaveBeenCalledWith(undefined);
    expect(localActivity).toHaveBeenCalledWith('ch_0123456789abc');
  });
});
