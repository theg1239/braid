import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { missionFixture, textOf } from '../../test/fixtures';
import type { TaskChange } from '../../lib/resources';

const clock = vi.hoisted(() => ({ now: Date.parse('2026-10-13T12:00:00Z') }));
const result = vi.hoisted(() => ({ change: null as TaskChange | null }));
vi.mock('../../lib/hooks', () => ({ useNow: () => clock.now }));
vi.mock('../../lib/resources', () => ({ useTaskChange: () => result.change }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({ project: { branch: 'main' } }), canWrite: () => false }));
vi.mock('../../lib/router', () => ({ paths: { merge: (id: string) => `/tasks/${id}/merge`, pull: (number: number) => `/pull/${number}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

import { TaskNext } from './TaskNext';

const css = readFileSync(new URL('../../styles/mission.css', import.meta.url), 'utf8');

describe('merged task sentence', () => {
  it.each([[0, 'just now'], [60_000, '1m ago']])('keeps the changing age last at %i ms', (elapsed, age) => {
    const mergedAt = '2026-10-13T12:00:00Z';
    clock.now = Date.parse(mergedAt) + elapsed;
    const mission = missionFixture({ status: 'merged', mergedAt, mergeCommit: 'cba4b04abcdef' });
    const html = renderToStaticMarkup(<TaskNext mission={mission} files={[]} head="cba4b04abcdef" onRestart={() => {}} />);
    expect(textOf(html).trim().replace(/\s+\./g, '.')).toBe(`Merged into main as cba4b04. Combined result ${age}`);
    expect(html).toMatch(/<p tabindex="-1" class="task-next__line">/);
    expect(html).toContain(`dateTime="${mergedAt}"`);
    expect(html).toContain('<time class="task-next__time"');
    expect(css).toMatch(/\.task-next__time \{[^}]*font-variant-numeric: tabular-nums;[^}]*white-space: nowrap;/);
    expect(html).not.toContain('min-width');
    expect(html).toMatch(/<\/time><\/span><\/p>/);
  });

  it.each(['review', 'merging'] as const)('reserves an inaccessible outcome line above the pull request while %s', status => {
    result.change = { id: 'change', number: 74, title: 'Task', status: 'queued' };
    try {
      const mission = missionFixture({ status });
      const html = renderToStaticMarkup(<TaskNext mission={mission} files={[]} head="a" onRestart={() => {}} />);
      expect(html).toMatch(/<p aria-hidden="true" class="task-next__line" style="visibility:hidden">/);
      expect(html).toContain('Pull request #74');
      expect(html.indexOf('task-next__line')).toBeLessThan(html.indexOf('class="task-pull"'));
      expect(html).not.toContain('tabindex="-1"');
    } finally { result.change = null; }
  });
});
