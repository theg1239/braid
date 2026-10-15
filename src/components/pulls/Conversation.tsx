import { Fragment, lazy, Suspense, useState } from 'react';
import { Badge, Button } from '@cloudflare/kumo';
import {
  ArrowCounterClockwiseIcon,
  ArrowUUpLeftIcon,
  EyeIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitMergeIcon,
  IntersectIcon,
  ListChecksIcon,
  ProhibitIcon,
  QueueIcon,
  SealCheckIcon,
  SealWarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { Agent, Change, ChangeEvent, ChangeReview } from '../../../shared/types';
import type { AgentActivityEvent } from '../../../shared/agent-activity';
import { HostedActivity } from '../agents/HostedActivity';
import { VERDICT, eventsInOrder, reviewerLabel } from '../../lib/changes';
import { shortHash } from '../../lib/format';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { BADGE } from '../ui/Status';
import { AuthorChip } from './Bits';
import { Proof } from './Proof';
import { CommentMarkdown, ReviewThread } from './Comments';
import { RelativeTime } from '../ui/Time';
const LocalActivity = lazy(() => import('../agents/LocalActivity'));

const ICONS: Record<ChangeEvent['type'], Icon> = {
  submitted: GitCommitIcon,
  revised: ArrowCounterClockwiseIcon,
  reviewed: EyeIcon,
  approved: SealCheckIcon,
  queued: QueueIcon,
  conflict: GitDiffIcon,
  landed: GitMergeIcon,
  closed: ProhibitIcon,
  reverted: ArrowUUpLeftIcon,
  checks: ListChecksIcon,
  escalated: SealWarningIcon,
  overlap: IntersectIcon,
};

const RISK = { low: 'low risk', medium: 'medium risk', high: 'high risk' } as const;

type Item = { at: string; order: number; key: string; node: React.ReactNode; keepVisible?: boolean; event?: ChangeEvent };

/** A summary may restate an intent ("Logs…" / "Log…") and then add detail. */
function coversIntent(summary: string, intent: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').replace(/^([a-z]+)s\b/, '$1');
  const description = normalize(summary), purpose = normalize(intent);
  return description === purpose || (description.startsWith(purpose) && /^[\s,;:]/.test(description.slice(purpose.length)));
}

/**
 * GitHub's conversation: the description as the first comment, then what happened in order.
 * Reviews appear as comments. `quoted` is text the merge box already shows, so it is not repeated.
 */
export function Conversation({ change, now, quoted, localActivity = false, hostedAgents = [], onUpdated = () => {} }: { change: Change; now: number; quoted?: string; localActivity?: boolean; hostedAgents?: (Pick<Agent, 'id' | 'name' | 'model' | 'owner'> & { hostedActivity?: AgentActivityEvent[] })[]; onUpdated?: (change: Change) => void }) {
  const [expanded, setExpanded] = useState(false);
  const reviews = change.reviews;
  const said = (text: string) => !!quoted && quoted.includes(text);
  const items: Item[] = [
    ...hostedAgents.flatMap(agent => (agent.hostedActivity ?? []).map((event): Item => ({ at: event.at, order: 0, key: `hosted-${agent.id}-${event.id}`, keepVisible: event.kind === 'failed', node: <HostedActivity agent={agent} event={event} now={now} /> }))),
    ...eventsInOrder(change.events)
      // A reviewer's escalation is their review, which the timeline shows as a comment.
      .filter((event) => event.type !== 'reviewed' && !said(event.message) && !(event.type === 'escalated' && event.requirement === 'risk'))
      .map((event, index): Item => ({ at: event.at, order: event.type === 'landed' ? 1 : 0, key: `event-${index}`, event, node: <EventLine event={event} now={now} />, keepVisible: event.type === 'overlap' && !!event.duplicates })),
    ...reviews.map((review): Item => ({ at: review.createdAt, order: 0, key: review.id, node: <ReviewComment review={review} now={now} quoted={said(review.summary)} stale={review.revision !== change.revision} /> })),
    ...(change.comments ?? []).filter(comment => !comment.inReplyTo).map((comment): Item => ({ at: comment.createdAt, order: 0, key: comment.id, node: <ReviewThread change={change} root={comment} onUpdated={onUpdated} /> })),
    // Reviews and checks precede a merge at the same instant; stable sort keeps other ties in source order.
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order).reduce<Item[]>((timeline, item) => {
    const previous = timeline.at(-1);
    const held = item.event?.type === 'escalated' && item.event.requirement === 'duplicate' ? item.event.duplicates?.[0] : undefined;
    // Coalesce only the adjacent warning and its duplicate-policy hold. Reviews,
    // comments, other holds and the person's later closing event keep their place.
    if (held && previous?.event?.type === 'overlap' && previous.event.duplicates?.[0]?.number === held.number) {
      const event = { ...previous.event, at: item.at };
      timeline[timeline.length - 1] = { ...previous, at: item.at, node: <EventLine event={event} now={now} held />, keepVisible: true };
    } else timeline.push(item);
    return timeline;
  }, []);
  const recent = items.filter((item, index) => item.keepVisible || index >= items.length - 6);
  const earlier = items.length - recent.length;
  const intent = coversIntent(change.summary, change.intent) ? '' : change.intent;
  const paragraphs = [...new Set([change.summary || change.intent, intent, change.rationale].filter(Boolean))];

  return (
    <div className="conversation">
      <article className="comment" aria-label="Description">
        <header className="comment__head">
          <AuthorChip author={change.author} detail />
          <span className="comment__when">
            opened{' '}
            <RelativeTime at={change.createdAt} now={now} />
          </span>
        </header>
        <div className="comment__body">
          {paragraphs.map((text, index) => <p key={text} className={index ? 'comment__muted' : undefined}>{text}</p>)}
        </div>
      </article>
      <Proof change={change} />
      {localActivity ? <Suspense fallback={<div style={{ height: 190 }} />}><LocalActivity changeId={change.id} /></Suspense> : null}
      {items.length ? (
        <ol className="timeline">
          {earlier ? <li className="timeline__more"><Button size="sm" variant="secondary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide earlier updates' : `Show ${earlier} earlier updates`}</Button></li> : null}
          {(expanded ? items : recent).map((item) => (
            <li key={item.key} className="timeline__item">
              {item.node}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function EventLine({ event, now, held = false }: { event: ChangeEvent; now: number; held?: boolean }) {
  const EventIcon = held ? SealWarningIcon : ICONS[event.type];
  const duplicates = event.type === 'overlap' ? event.duplicates : undefined;
  return (
    <div className="event" data-type={held ? 'escalated' : event.type}>
      <EventIcon size={15} className="event__icon" aria-hidden="true" />
      <span className="event__text">
        {duplicates ? <>Possible duplicate of {duplicates.map((duplicate, index) => <Fragment key={duplicate.number}>{index ? ', ' : ''}<RouterLink className="text-link" href={paths.pull(duplicate.number)}>#{duplicate.number}</RouterLink> {duplicate.title}</Fragment>)}{held ? '; held for review.' : '.'}</>
          : event.type === 'revised' && event.revision !== undefined && event.base ? `Push ${event.revision} based on ${shortHash(event.base)}.` : event.message}
      </span>
      <RelativeTime at={event.at} now={now} className="event__time" />
    </div>
  );
}

/** One review as a comment: who, the verdict once as a badge, and its findings. A summary the merge box quotes is not repeated. */
function ReviewComment({ review, now, quoted, stale }: { review: ChangeReview; now: number; quoted: boolean; stale: boolean }) {
  const who = reviewerLabel(review);
  const verdict = VERDICT[review.verdict];
  return (
    <article className="comment comment--review" data-verdict={review.verdict} data-stale={stale || undefined}>
      <header className="comment__head">
        {review.author ? <AuthorChip author={review.author} /> : <span className="comment__name">{who.name}</span>}
        {who.detail ? (
          <span className="comment__detail" data-simulated={who.simulated || undefined}>
            {who.detail}
          </span>
        ) : null}
        <Badge variant={BADGE[verdict.tone]} className="comment__verdict">
          {verdict.label}
        </Badge>
        {review.risk ? (
          <span className="risk" data-risk={review.risk}>
            {RISK[review.risk]}
          </span>
        ) : null}
        {stale ? <span className="comment__stale">earlier push</span> : null}
        <RelativeTime at={review.createdAt} now={now} className="comment__when" />
      </header>
      {(review.summary && !quoted) || review.findings.length ? (
        <div className="comment__body">
          {review.summary && !quoted ? <CommentMarkdown body={review.summary} /> : null}
          {review.findings.length ? (
            <ul className="findings" aria-label={`Findings from ${who.name}`}>
              {review.findings.map((finding, index) => (
                <li key={index} className="finding" data-severity={finding.severity}>
                  <span className="finding__body">
                    {finding.path ? (
                      <span className="finding__where mono">
                        {finding.path}
                        {finding.line ? `:${finding.line}` : ''}
                      </span>
                    ) : null}
                    <span className="finding__text">{finding.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
