import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalActivityRun } from '../../../shared/agent-activity';
import { ActivityRows, ActivitySummary } from './ActivitySummary';
vi.mock('../../lib/router', () => ({ paths: { pull: (n: number) => `/pull/${n}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const now = Date.parse('2026-10-14T12:00:00Z');
const run: LocalActivityRun = { id: 'r1', session: 's1', startedAt: new Date(now - 30_000).toISOString(), lastSeenAt: new Date(now).toISOString(), agent: { name: 'Claude Opus 5.5', owner: { name: '@owner' } }, changeNumber: 7, events: [
  { id: '1', sequence: 1, at: new Date(now - 20_000).toISOString(), source: 'claude-hook', kind: 'editing', path: 'src/x.ts' },
  { id: '2', sequence: 2, at: new Date(now - 10_000).toISOString(), source: 'claude-hook', kind: 'command', command: 'npm test', exitCode: 1 },
] };
describe('reported activity UI', () => {
  it('groups edits and test failures into one timeline row with model and owner', () => {
    const html = renderToStaticMarkup(<ActivityRows runs={[run]} now={now} />);
    for (const value of ['Claude Opus 5.5', 'for @owner', 'editing src/x.ts', 'ran npm test, failed (exit 1)', 'Local activity timeline']) expect(html).toContain(value);
    expect(html.match(/class="local-activity__row"/g)).toHaveLength(1);
    expect(html).not.toMatch(/<svg|spinner|status-dot/);
  });
  it('updates Now in a fixed row and marks stale reporting without inventing a failure', () => {
    expect(renderToStaticMarkup(<ActivityRows runs={[run]} now={now} live />)).toContain('ran npm test, failed');
    expect(renderToStaticMarkup(<ActivityRows runs={[run]} now={now + 60_000} live />)).toContain('updates paused');
    const ended = { ...run, events: [...run.events, { id: '3', sequence: 3, at: new Date(now).toISOString(), source: 'process' as const, kind: 'finished' as const, exitCode: 0 }] };
    expect(renderToStaticMarkup(<ActivityRows runs={[ended]} now={now} live />)).toContain('No local agents running');
    const css = readFileSync(new URL('./activity.css', import.meta.url), 'utf8');
    expect(css).toMatch(/height: 144px; overflow: auto/);
    expect(css).toContain('height: 72px');
  });
  it('renders shared hosted summaries literally', () => {
    const html = renderToStaticMarkup(<ActivitySummary event={{ id: 'x', sequence: 1, at: new Date(now).toISOString(), source: 'hosted', kind: 'failed', failure: { code: 'container', summary: '<script>failed</script>', retryable: true, lines: [] } }} />);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
