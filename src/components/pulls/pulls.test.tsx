import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { textOf } from '../../test/fixtures';
import type { Change, ChangeCheck, ChangeStatus, ChangeSummary } from '../../../shared/types';

vi.mock('../../lib/router', () => ({ paths: { pull: (n: number, options?: { tab: string }) => `/pull/${n}${options?.tab ? `/${options.tab}` : ''}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('./Proof', () => ({ Proof: () => null }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));

import { Checks, checkRows, checksSummary, mergeChecksSummary } from './Checks';
import { Conversation } from './Conversation';
import { PullRow } from './PullRow';
import { Reviewers } from './Reviewers';
import { changeStarts } from './fileNavigation';
import { filterPulls } from './filtering';
import { filterCount } from '../../lib/lists';

const change: Change = {
  id: 'test-pr', number: 7, title: 'Round refund amounts', status: 'attention', revision: 2,
  author: { id: 'agent', name: 'GPT-6 Astra', kind: 'agent', owner: { id: 'owner', github: 'maya', name: 'Maya' } },
  additions: 1, deletions: 1, createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T10:00:00Z',
  intent: 'Round fractional cents.', summary: '', rationale: '', baseCommit: 'base',
  files: [], reviews: [], checks: [], conflicts: [], overlaps: [], events: [],
};
const check = (source: ChangeCheck['source'], status: ChangeCheck['status'] = 'passed', revision = 2): ChangeCheck => ({ source, status, revision, label: `${source} tests`, detail: '' });

describe('Check summaries', () => {
  it('keeps agent reports out of the verified pass count', () => {
    expect(mergeChecksSummary([check('braid'), check('agent')])).toEqual({ state: 'passed', label: '1 check passed · 1 agent-reported' });
  });
  it('never presents an agent-only pass as verified', () => {
    expect(mergeChecksSummary([check('agent')])).toEqual({ state: 'reported', label: 'Agent-reported only' });
  });
  it('keeps a failed agent report blocking even when Braid passes', () => {
    expect(mergeChecksSummary([check('braid'), check('agent', 'failed')]).state).toBe('failed');
  });
  it('separates verified passes and reports on the Checks tab', () => {
    expect(checksSummary(checkRows({ ...change, checks: [check('braid'), check('agent')] }))).toBe('2 checks · 1 passed · 1 agent-reported');
  });
  it('omits stale checks and puts failures before passes', () => {
    const rows = checkRows({ ...change, checks: [check('braid'), check('github', 'failed'), check('ci', 'failed', 1)] });
    expect(rows.map((row) => row.label)).toEqual(['github tests', 'braid tests']);
  });
  it('condenses sandbox runs from their fields and preserves unfamiliar check details', () => {
    const detail = (seconds: number) => `Check ran in a Braid sandbox on the combined result 50930ec with 1 other change: exit 0 in ${seconds}s.\nCommand output`;
    const checks: ChangeCheck[] = [14, 4, 10].map((seconds, index) => ({ ...check('braid'), label: ['npm ci', 'npm run typecheck', 'npm test'][index], detail: detail(seconds), run: { commit: '50930ec'.padEnd(40, '0'), exitCode: 0, seconds } }));
    checks.push({ ...check('braid', 'failed'), label: 'Dependency review', detail: 'lodash@4.17.20: high severity' });
    const rendered = textOf(renderToStaticMarkup(<Checks change={{ ...change, checks }} />));
    expect(rendered.match(/Braid sandbox/g)).toHaveLength(1);
    expect(rendered).not.toContain('ran in a Braid sandbox');
    for (const seconds of [14, 4, 10]) expect(rendered).toContain(`combined 50930ec · exit 0 · ${seconds} s`);
    expect(rendered).toContain('lodash@4.17.20: high severity');
    // A check stored before runs had fields reads as its text.
    const older = textOf(renderToStaticMarkup(<Checks change={{ ...change, checks: [{ ...check('braid'), label: 'npm test', detail: detail(10) }] }} />));
    expect(older).toContain('Check ran in a Braid sandbox on the combined result 50930ec with 1 other change: exit 0 in 10s.');
    expect(older).not.toContain('combined 50930ec · exit 0');
  });
});

describe('PR states', () => {
  it.each<[ChangeStatus, string]>([['attention', 'Needs your review'], ['revise', 'Changes requested'], ['queued', 'Queued to merge'], ['landing', 'Merging'], ['landed', 'Merged'], ['closed', 'Closed']])('makes %s explicit with one state icon', (status, label) => {
    const html = renderToStaticMarkup(<PullRow change={{ ...change, files: 1, status, checkState: 'pending' }} now={Date.parse(change.createdAt)} />);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html.match(/class="pr-state"/g)).toHaveLength(1);
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(textOf(html)).toContain('Checks pending');
    expect(html).toContain('href="/pull/7/checks"');
    expect(textOf(html)).toContain('GPT-6 Astra for @maya');
  });
  it.each(['passed', 'failed', 'pending'] as const)('shows %s checks as text with only the pull request’s state icon', checkState => {
    const html = renderToStaticMarkup(<PullRow change={{ ...change, files: 1, status: 'revise', checkState }} now={Date.parse(change.createdAt)} />);
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(textOf(html)).toContain(`Checks ${checkState}`);
    expect(html).toContain('href="/pull/7/checks"');
  });
  it('does not repeat checks already named by the server label', () => {
    const html = renderToStaticMarkup(<PullRow change={{ ...change, files: 1, status: 'revise', checkState: 'failed', label: 'Checks failed' }} now={Date.parse(change.createdAt)} />);
    expect(textOf(html).match(/Checks failed/g)).toHaveLength(1);
    expect(html.match(/<svg\b/g)).toHaveLength(1);
  });
});

describe('Conversation', () => {
  it('calls a recorded update a push from its revision and base, and an older one by its text', () => {
    const event = { at: change.createdAt, type: 'revised' as const, message: 'Revision 2 based on 15e32c3.', revision: 2, base: '15e32c3a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e' };
    const rendered = textOf(renderToStaticMarkup(<Conversation change={{ ...change, events: [event] }} now={Date.parse(change.createdAt)} />));
    expect(rendered).toContain('Push 2 based on 15e32c3.');
    expect(rendered).not.toContain('Revision');
    const older = textOf(renderToStaticMarkup(<Conversation change={{ ...change, events: [{ at: event.at, type: event.type, message: event.message }] }} now={Date.parse(change.createdAt)} />));
    expect(older).toContain('Revision 2 based on 15e32c3.');
  });
  it('shows the intent only once when the summary is missing', () => {
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(change.createdAt)} />);
    expect(textOf(html).match(/Round fractional cents\./g)).toHaveLength(1);
  });
  it('omits an intent the summary restates with extra detail', () => {
    const summary = 'Logs each delivery attempt with host, attempt number and status, never the body or secret.';
    const intent = 'Log each delivery attempt with host, attempt number and status.';
    const rendered = textOf(renderToStaticMarkup(<Conversation change={{ ...change, summary, intent }} now={Date.parse(change.createdAt)} />));
    expect(rendered).toContain(summary);
    expect(rendered).not.toContain(intent);
  });
  it('retains intent that adds a different requirement', () => {
    const summary = 'Rounds fractional cents for refunds.';
    const intent = 'Round fractional cents to even to avoid cumulative bias.';
    const rendered = textOf(renderToStaticMarkup(<Conversation change={{ ...change, summary, intent }} now={Date.parse(change.createdAt)} />));
    expect(rendered).toContain(summary);
    expect(rendered).toContain(intent);
  });
  it('folds earlier activity while keeping the latest updates visible', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ at: `2026-10-12T10:0${i}:00Z`, type: 'revised' as const, message: `Update ${i}` }));
    const html = renderToStaticMarkup(<Conversation change={{ ...change, events }} now={Date.parse(change.createdAt)} />);
    expect(textOf(html)).toContain('Show 4 earlier updates');
    expect(textOf(html)).not.toContain('Update 0');
    expect(textOf(html)).toContain('Update 9');
  });
  it('keeps a duplicate warning visible when later updates are folded', () => {
    const events = [
      { at: change.createdAt, type: 'overlap' as const, message: 'Possible duplicate of #51 Add structured delivery logging.', duplicates: [{ number: 51, title: 'Add structured delivery logging' }] },
      ...Array.from({ length: 10 }, (_, i) => ({ at: `2026-10-12T10:${10 + i}:00Z`, type: 'checks' as const, message: `Check ${i}` })),
    ];
    const words = textOf(renderToStaticMarkup(<Conversation change={{ ...change, events }} now={Date.parse(change.createdAt)} />));
    expect(words).toContain('Possible duplicate of #51');
    expect(words).toContain('Show 4 earlier updates');
    expect(words).not.toContain('Check 0');
    expect(words).toContain('Check 9');
  });
});

describe('Reviewers', () => {
  it('names an authenticated reviewer by model and owner instead of a connection id', () => {
    const html = renderToStaticMarkup(<Reviewers change={{ ...change, reviews: [{ id: 'review', revision: 2, reviewer: 'agent:private-connection-id', kind: 'agent', verdict: 'revise', summary: 'Fix the rounding.', findings: [], createdAt: change.createdAt, author: change.author }] }} />);
    expect(textOf(html)).toContain('GPT-6 Astra for @maya');
    expect(html).not.toContain('private-connection-id');
  });
  it('names the check that sent work back even without a review', () => {
    const html = renderToStaticMarkup(<Reviewers change={{ ...change, status: 'revise', checks: [{ ...check('braid', 'failed'), label: 'Dependency review' }] }} />);
    expect(textOf(html)).toContain('Dependency review');
    expect(html).toContain('href="/pull/7/checks"');
    expect(textOf(html)).not.toContain('No reviews yet');
  });
  it('does not attribute a current rejection to an old check failure', () => {
    const html = renderToStaticMarkup(<Reviewers change={{ ...change, status: 'revise', checks: [check('braid', 'failed', 1)] }} />);
    expect(textOf(html)).toContain('No reviews yet');
    expect(textOf(html)).not.toContain('braid tests');
  });
});

describe('Pull request filters', () => {
  const items: ChangeSummary[] = ['attention', 'revise', 'landed', 'closed'].map((status, index) => ({ ...change, id: `pr-${index}`, number: index + 1, title: index === 3 ? 'Add delivery logging' : 'Round refund amounts', files: 1, status: status as ChangeStatus }));
  it('counts matches in both states, including sent-back and merged pull requests', () => {
    const matching = filterPulls(items, '  REFUND   @maya ');
    expect(matching.items).toHaveLength(3);
    expect(filterCount('open', matching.counts)).toBe(2);
    expect(filterCount('closed', matching.counts)).toBe(1);
    expect(filterCount('review', matching.counts)).toBe(1);
  });
  it('counts number matches and resets every count for a query with no matches', () => {
    const numbered = filterPulls(items, '#3');
    expect(filterCount('open', numbered.counts)).toBe(0);
    expect(filterCount('closed', numbered.counts)).toBe(1);
    const empty = filterPulls(items, 'missing');
    expect(empty.items).toEqual([]);
    expect(Object.values(empty.counts).every((count) => count === 0)).toBe(true);
  });
});

describe('Change navigation', () => {
  it('treats adjacent removed and added lines as one change', () => {
    expect(changeStarts([0, 1, 2, 10, 11].map((index) => ({ index }))).map((line) => line.index)).toEqual([0, 10]);
  });
  it('merges duplicated and interleaved split-view line indexes', () => {
    expect(changeStarts([0, 4, 8, 1, 4, 9].map((index) => ({ index }))).map((line) => line.index)).toEqual([0, 4, 8]);
  });
  it('handles files without text changes', () => {
    expect(changeStarts([])).toEqual([]);
  });
});
