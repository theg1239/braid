import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Change, ChangeReference, ChangeSummary } from '../../../shared/types';
import { textOf } from '../../test/fixtures';
vi.mock('../../lib/router', () => ({ paths: { pull: (n: number) => `/pull/${n}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({}), answerBlocker: () => null, liveBlocker: () => null, EXAMPLE_REASON: 'Recorded example' }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));
import { MergeBox } from './MergeBox';
import { StackLinks } from './Stack';
import { PullRow } from './PullRow';
import { QueueStacks } from '../queue/Stacks';
const parent: ChangeReference = { id: 'parent', number: 51, status: 'queued' };
const child: ChangeReference = { id: 'child', number: 73, status: 'open' };
const pull: ChangeSummary = { ...child, title: 'Dependent feature', revision: 1, author: { id: 'agent', kind: 'agent', name: 'GPT-6 Astra', model: 'gpt-6-astra', owner: { name: 'Maya', github: 'maya' } }, files: 1, additions: 3, deletions: 0, createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T10:00:00Z', dependsOn: [parent], requiredBy: [{ id: 'next', number: 74, status: 'open' }], waitingOn: [parent], stack: { position: 2, total: 3 } };
describe('stack presentation', () => {
  const detail: Change = { ...pull, files: [], intent: '', summary: '', rationale: '', baseCommit: '', reviews: [], checks: [], conflicts: [], overlaps: [], events: [] };
  it('shows the waiting dependency in the merge box', () => {
    const html = renderToStaticMarkup(<MergeBox change={detail} policy={undefined} branch="main" onUpdated={() => {}} />);
    expect(textOf(html)).toContain('Waiting on #51'); expect(html).toContain('href="/pull/51"');
  });
  it('asks for a revision or closure when a prerequisite closed, without offering an approval that cannot merge', () => {
    const html = renderToStaticMarkup(<MergeBox change={{ ...detail, status: 'attention', waitingOn: [{ ...parent, status: 'closed' }], next: '#51 closed without merging.' }} policy={undefined} branch="main" onUpdated={() => {}} />);
    expect(textOf(html)).toContain('Dependency closed'); expect(textOf(html)).toContain('#51 closed without merging.');
    expect(textOf(html)).toContain('Request changes'); expect(textOf(html)).toContain('Close pull request'); expect(textOf(html)).not.toContain('Approve');
  });
  it('names the landed commit control by its hash', () => {
    const html = renderToStaticMarkup(<MergeBox change={{ ...detail, status: 'landed', landedCommit: 'c'.repeat(40) }} policy={undefined} branch="main" onUpdated={() => {}} />);
    expect(html).toContain('aria-label="Copy commit hash ccccccc"');
  });
  it('links both directions and labels the stack position', () => {
    const html = renderToStaticMarkup(<StackLinks change={pull} />);
    expect(textOf(html)).toContain('Depends on #51'); expect(textOf(html)).toContain('Required by #74');
    expect(html).toContain('href="/pull/51"'); expect(html).toContain('href="/pull/74"'); expect(html).toContain('Stack: 2 of 3');
    // The badge's words sit on a role that can carry a name; a bare span's aria-label is ignored by screen readers.
    expect(html).toMatch(/<span class="pr-stack" role="img"[^>]*aria-label="Stack: 2 of 3"/);
  });
  it('marks the list row and names the prerequisite instead of generic review progress', () => {
    const html = renderToStaticMarkup(<PullRow change={pull} now={Date.parse(pull.createdAt)} />);
    expect(textOf(html)).toContain('2 of 3'); expect(textOf(html)).toContain('Waiting on #51'); expect(textOf(html)).toContain('for @maya');
  });
  it('renders ordered queue links and leaves independent pull requests unmarked', () => {
    const html = renderToStaticMarkup(<QueueStacks stacks={[[parent, child]]} />);
    expect(html).toContain('<ol'); expect(html.indexOf('href="/pull/51"')).toBeLessThan(html.indexOf('href="/pull/73"'));
    expect(renderToStaticMarkup(<StackLinks change={{ ...pull, dependsOn: [], requiredBy: [] }} />)).toBe('');
    expect(renderToStaticMarkup(<QueueStacks stacks={[]} />)).toBe('');
  });
  it('shows a short outdated reason and a restack action', () => {
    const change = { ...detail, status: 'revise' as const, outdated: [parent], next: '#51 changed since this was built. Restack this pull request.' };
    const html = renderToStaticMarkup(<MergeBox change={change} policy={undefined} branch="main" onUpdated={() => {}} />);
    expect(textOf(html).match(/#51 changed since this was built/g)).toHaveLength(1);
    expect(textOf(html)).toContain('Restack');
    expect(textOf(renderToStaticMarkup(<PullRow change={{ ...pull, outdated: [parent] }} now={0} />))).toContain('#51 changed since this was built');
  });
  it('offers next and previous stack pages', () => {
    const html = renderToStaticMarkup(<QueueStacks stacks={[[parent, child]]} onNext={() => {}} />);
    expect(html).toContain('Stack pages'); expect(textOf(html)).toContain('Previous'); expect(textOf(html)).toContain('Next');
  });

});
