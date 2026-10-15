import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Change } from '../../../shared/types';
vi.mock('../../lib/router', () => ({ paths: { pull: (number: number, options?: { tab: string }) => `/pull/${number}${options?.tab ? `/${options.tab}` : ''}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../../store/workspace', () => ({}));
import { MergeBox, sentBackDetail } from './MergeBox';

it('repeats why a pull request went back only when its rows do not already say it, by what sent it back', () => {
  expect(sentBackDetail({ status: 'revise', sentBack: 'checks', next: 'Failed: npm test' })).toBeUndefined();
  expect(sentBackDetail({ status: 'revise', sentBack: 'conflicts', next: 'Conflicts in src/router.ts.' })).toBeUndefined();
  expect(sentBackDetail({ status: 'revise', sentBack: 'review', next: 'Braid reviewer: Handle empty paths.' })).toBe('Braid reviewer: Handle empty paths.');
  // One stored before the cause was recorded reads as its words.
  expect(sentBackDetail({ status: 'revise', next: 'Failed: npm test' })).toBe('Failed: npm test');
  expect(sentBackDetail({ status: 'open', sentBack: 'review', next: 'Waiting for 1 independent review.' })).toBeUndefined();
});

const change: Change = {
  id: 'failed-check', number: 72, title: 'Use lodash for retry jitter', status: 'revise', revision: 2,
  author: { id: 'agent', name: 'GPT-6 Astra', kind: 'agent' }, additions: 3, deletions: 0,
  createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z',
  intent: '', summary: '', rationale: '', baseCommit: 'a'.repeat(40),
  files: [], reviews: [], checks: [{ label: 'Dependency review', status: 'failed', source: 'braid', revision: 2, detail: 'Vulnerable dependency' }],
  conflicts: [], overlaps: [], events: [], sentBack: 'checks',
};

it('gives a blocked merge box one direct action to inspect its failed checks', () => {
  const html = renderToStaticMarkup(<MergeBox change={change} policy={undefined} branch="main" onUpdated={() => {}} />);
  expect(html).toContain('View failed checks');
  expect(html).toContain('href="/pull/72/checks"');
});

it('does not point to failed checks from an older revision', () => {
  const html = renderToStaticMarkup(<MergeBox change={{ ...change, sentBack: 'review', checks: change.checks.map(check => ({ ...check, revision: 1 })) }} policy={undefined} branch="main" onUpdated={() => {}} />);
  expect(html).not.toContain('View failed checks');
});
