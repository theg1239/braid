import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Change, ChangeEvent, ChangeReview } from '../../../shared/types';
import type { AgentActivityEvent } from '../../../shared/agent-activity';
import { recordedExample } from '../../../worker/changes/demo';
import { textOf } from '../../test/fixtures';
import { Conversation } from './Conversation';

vi.mock('./Proof', () => ({ Proof: () => null }));
vi.mock('./Comments', () => ({ CommentMarkdown: ({ body }: { body: string }) => <p>{body}</p>, ReviewThread: () => null }));
vi.mock('../../lib/router', () => ({ paths: { pull: (number: number) => `/example/relay/pull/${number}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const at = '2026-10-13T12:00:00Z';
const review = (id: string, createdAt = at): ChangeReview => ({ id, reviewer: id, kind: 'human', verdict: 'comment', summary: id, revision: 1, createdAt, findings: [] });
function timeline(change: Change) {
  return textOf(renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} />).split('<ol class="timeline">')[1]).replaceAll('&#x27;', "'");
}

describe('conversation chronology', () => {
  it('places the linked task’s hosted failure in the timeline with its last 40 escaped diagnostic lines', async () => {
    const change = { ...(await recordedExample()).change('51'), events: [], reviews: [], comments: [] };
    const event: AgentActivityEvent = { id: 'failed-hosted', at, sequence: 1, source: 'hosted', kind: 'failed', failure: { code: 'sandbox_unavailable', summary: 'Sandbox unavailable; retrying.', retryable: true, lines: Array.from({ length: 45 }, (_, i) => `diagnostic ${i} <script>`) } };
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} hostedAgents={[{ id: 'atlas', name: 'Atlas', model: 'claude-opus-5-5', owner: { name: '@owner' }, hostedActivity: [event] }]} />);
    const timeline = html.split('<ol class="timeline">')[1];
    expect(textOf(timeline)).toContain('Claude Opus 5.5 for @owner · Sandbox unavailable; retrying.');
    expect(timeline).toContain('diagnostic 5 &lt;script&gt;');
    expect(timeline).not.toContain('diagnostic 4 ');
    expect(timeline).not.toContain('<script>');
  });
  it.each([1, 5, 23, 36, 51])('places the GitHub reviews before the merged event on recorded pull request #%i', async number => {
    const change = (await recordedExample()).change(String(number));
    const before = structuredClone(change);
    const out = timeline(change);
    for (const reviewer of ['CodeRabbit', 'Copilot']) {
      expect(out).toContain(reviewer);
      expect(out.indexOf(reviewer)).toBeLessThan(out.indexOf('Merged as'));
    }
    expect(change).toEqual(before);
  });
  it('keeps source order among tied checks and reviews, with the merge last', async () => {
    const change = { ...(await recordedExample()).change('23'), revision: 1, comments: [], events: [
      { at, type: 'landed' as const, message: 'Merged as abc1234.' },
      { at, type: 'checks' as const, message: 'Typecheck passed.' },
      { at, type: 'checks' as const, message: 'Tests passed.' },
    ], reviews: [review('Zoe approved the scope.'), review('Alex reviewed the tests.')] };
    expect(timeline(change)).toMatch(/Typecheck passed.*Tests passed.*Zoe approved the scope.*Alex reviewed the tests.*Merged as/);
  });
  it('preserves a review or check that actually arrived after the merge', async () => {
    const change = { ...(await recordedExample()).change('23'), comments: [], events: [
      { at, type: 'landed' as const, message: 'Merged as abc1234.' },
      { at: '2026-10-13T12:00:02Z', type: 'checks' as const, message: 'Follow-up check.' },
    ], reviews: [review('Follow-up review.', '2026-10-13T12:00:01Z')] };
    expect(timeline(change)).toMatch(/Merged as.*Follow-up review.*Follow-up check/);
  });
});

describe('duplicate policy timeline', () => {
  const duplicates = (number: number) => [{ number, title: 'Add structured delivery logging' }];
  const warning = (number = 51): ChangeEvent => ({ at, type: 'overlap', message: `Possible duplicate of #${number} Add structured delivery logging.`, duplicates: duplicates(number) });
  const hold = (number = 51): ChangeEvent => ({ at, type: 'escalated', message: `This pull request's intent closely matches open pull request #${number}; a person should decide whether both are needed.`, requirement: 'duplicate', duplicates: duplicates(number) });

  it('shows one linked warning and hold on #73, preserving the superseded closure and recorded data', async () => {
    const change = (await recordedExample()).change('73');
    const before = structuredClone(change);
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} />);
    const out = textOf(html);
    expect(out).toContain('Possible duplicate of #51 Add structured delivery logging; held for review.');
    expect(out.match(/Possible duplicate/g)).toHaveLength(1);
    expect(out).not.toContain('intent closely matches');
    expect(html).toContain('href="/example/relay/pull/51"');
    expect(out).toContain('@maya-chen closed this pull request (superseded).');
    expect(html.match(/class="event"/g)).toHaveLength(3);
    expect(change).toEqual(before);
  });

  it.each([
    ['another pull request', [warning(51), hold(52)]],
    ['another hold', [warning(), { at, type: 'escalated', message: 'A protected path needs an owner.', requirement: 'protected' }]],
    ['a check between warnings', [warning(), { at, type: 'checks', message: 'Checks passed.' }, hold()]],
  ] satisfies [string, ChangeEvent[]][])('preserves distinct updates: %s', async (_, events) => {
    const change = { ...(await recordedExample()).change('73'), events, comments: [], reviews: [] };
    const out = timeline(change);
    for (const event of events) expect(out).toContain(event.message);
    expect(out).not.toContain('held for review');
  });

  it('does not consolidate across a review between the two warnings', async () => {
    const later = '2026-10-13T12:00:02Z';
    const change = { ...(await recordedExample()).change('73'), events: [warning(), { ...hold(), at: later }], comments: [], reviews: [review('Keep both?', '2026-10-13T12:00:01Z')] };
    expect(timeline(change)).toMatch(/Possible duplicate of #51.*Keep both\?.*intent closely matches/);
  });

  it('links an advisory duplicate without claiming it was held', async () => {
    const change = { ...(await recordedExample()).change('73'), events: [warning(86)], comments: [], reviews: [] };
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} />);
    expect(html).toContain('href="/example/relay/pull/86"');
    expect(textOf(html)).toContain(warning(86).message);
    expect(textOf(html)).not.toContain('held for review');
  });

  it('links every possible duplicate', async () => {
    const change = { ...(await recordedExample()).change('73'), comments: [], reviews: [], events: [{ ...warning(51), duplicates: [...duplicates(51), { number: 60, title: 'Log deliveries' }] }] };
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} />);
    expect(textOf(html)).toContain('Possible duplicate of #51 Add structured delivery logging, #60 Log deliveries.');
    expect(html).toContain('href="/example/relay/pull/60"');
  });

  it('renders events stored without their fields as their text', async () => {
    const plain = ({ duplicates: _, requirement: __, ...event }: ChangeEvent): ChangeEvent => event;
    const checks = Array.from({ length: 10 }, (_, index): ChangeEvent => ({ at: `2026-10-13T12:01:${String(index).padStart(2, '0')}Z`, type: 'checks', message: `Check ${index}.` }));
    const change = { ...(await recordedExample()).change('73'), comments: [], reviews: [], events: [plain(warning()), plain(hold())] };
    const html = renderToStaticMarkup(<Conversation change={change} now={Date.parse(at)} />);
    expect(textOf(html)).toContain(warning().message);
    expect(textOf(html)).toContain('intent closely matches open pull request #51');
    expect(textOf(html)).not.toContain('held for review');
    expect(html).not.toContain('href="/example/relay/pull/51"');
    expect(timeline({ ...change, events: [plain(warning()), ...checks] })).not.toContain('Possible duplicate');
    const escalation: ChangeEvent = { at, type: 'escalated', message: 'Braid reviewer: Refund rounding needs a person.' };
    const out = textOf(renderToStaticMarkup(<Conversation change={{ ...change, events: [escalation] }} now={Date.parse(at)} quoted="Refund rounding needs a person." />));
    expect(out).toContain(escalation.message);
  });

  it('leaves a reviewer escalation to the review, and keeps other holds that quote it', async () => {
    const summary = 'Refund rounding needs a person.';
    const events: ChangeEvent[] = [{ at, type: 'escalated', message: `Braid reviewer: ${summary}`, requirement: 'risk' }, { at, type: 'escalated', message: `Protected paths changed. ${summary}`, requirement: 'protected' }];
    const out = timeline({ ...(await recordedExample()).change('73'), comments: [], events, reviews: [review(summary)] });
    expect(out).not.toContain(`Braid reviewer: ${summary}`);
    expect(out).toContain(`Protected paths changed. ${summary}`);
  });

  it('keeps a consolidated warning visible when later updates are folded', async () => {
    const change = { ...(await recordedExample()).change('73'), comments: [], reviews: [], events: [warning(), hold(), ...Array.from({ length: 10 }, (_, index): ChangeEvent => ({ at: `2026-10-13T12:01:${String(index).padStart(2, '0')}Z`, type: 'checks', message: `Check ${index}.` }))] };
    const out = timeline(change);
    expect(out).toContain('held for review');
    expect(out).toContain('Show 4 earlier updates');
    expect(out).not.toContain('intent closely matches');
  });
});
