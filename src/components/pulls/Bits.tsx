import type { ReactNode } from 'react';
import { Badge } from '@cloudflare/kumo';
import { ChatCircleIcon, CheckCircleIcon, CircleDashedIcon, EyeIcon, GitMergeIcon, GitPullRequestIcon, MinusCircleIcon, QueueIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import type { ChangeAuthor, ChangeReview, ChangeStatus, ChangeSummary } from '../../../shared/types';
import { personHandle } from '../../../shared/people';
import { PULL_STATE, VERDICT, authorName, isAgentAuthor, pullState, statusLabel, type CheckState, type ReviewState } from '../../lib/changes';
import { BADGE } from '../ui/Status';

/** One state icon per row, including what an open pull request is waiting for. */
export function PullStateIcon({ status }: { status: ChangeStatus }) {
  const state = pullState(status);
  const props = { size: 16, className: 'pr-state', 'data-state': state, 'data-status': status, role: 'img' as const, 'aria-label': statusLabel({ status }).label, weight: 'bold' as const };
  if (status === 'attention') return <EyeIcon {...props} />;
  if (status === 'revise') return <XCircleIcon {...props} />;
  if (status === 'queued') return <QueueIcon {...props} />;
  return status === 'landed' || status === 'landing' ? <GitMergeIcon {...props} /> : <GitPullRequestIcon {...props} />;
}

export function PullStateBadge({ status }: { status: ChangeStatus }) {
  const state = pullState(status);
  const { label, tone } = PULL_STATE[state];
  const Icon = state === 'merged' ? GitMergeIcon : GitPullRequestIcon;
  return (
    <Badge variant={BADGE[tone]} className="state-badge" data-state={state}>
      <Icon size={14} weight="bold" aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** Merged, closed, or what an open pull request waits for. */
export function StatusBadge({ change }: { change: Pick<ChangeSummary, 'status'> }) {
  const { label, tone } = statusLabel(change);
  return (
    <Badge variant={BADGE[tone]} className="status-badge">
      {label}
    </Badge>
  );
}

/** An icon with a label stands alone; without one it decorates the text beside it. */
const named = (label: string) => (label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const });

export function ReviewStateIcon({ state, label }: { state: ReviewState; label: string }) {
  if (state === 'none') return null;
  const props = { size: 16, className: 'review-state', 'data-state': state, ...named(label) };
  if (state === 'approved') return <CheckCircleIcon {...props} weight="fill" />;
  if (state === 'changes') return <XCircleIcon {...props} weight="fill" />;
  if (state === 'needed') return <EyeIcon {...props} weight="fill" />;
  return <CircleDashedIcon {...props} weight="bold" />;
}

/** A reviewer's verdict as GitHub marks it beside the name: approved, changes requested, or only a comment. */
export function VerdictIcon({ verdict, size = 16 }: { verdict: ChangeReview['verdict']; size?: number }) {
  const props = { size, className: 'verdict', 'data-verdict': verdict, role: 'img' as const, 'aria-label': VERDICT[verdict].label };
  if (verdict === 'approve') return <CheckCircleIcon {...props} weight="fill" />;
  if (verdict === 'comment') return <ChatCircleIcon {...props} weight="fill" />;
  if (verdict === 'escalate') return <WarningCircleIcon {...props} weight="fill" />;
  return <XCircleIcon {...props} weight="fill" />;
}

export function CheckStateIcon({ state, label, size = 16 }: { state: CheckState; label: string; size?: number }) {
  const props = { size, className: 'check-state', 'data-state': state, ...named(label) };
  if (state === 'passed') return <CheckCircleIcon {...props} weight="fill" />;
  if (state === 'failed') return <XCircleIcon {...props} weight="fill" />;
  if (state === 'warning') return <WarningCircleIcon {...props} weight="fill" />;
  if (state === 'reported') return <CheckCircleIcon {...props} weight="regular" />;
  return <MinusCircleIcon {...props} weight="bold" />;
}

/** A label, as on a GitHub pull request: warning when it waits for the viewer, danger when it went back to its author. */
export function Label({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'danger' | 'simulated' }) {
  return (
    <span className="label" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * Who opened a pull request: an agent as its model and whose agent it is ("Claude Opus 5.5 for @maya-chen"),
 * a person as themselves. `detail` adds the tool the agent ran in, quietly.
 */
export function AuthorChip({ author, detail = false }: { author: ChangeAuthor; detail?: boolean }) {
  const agent = isAgentAuthor(author);
  const owner = author.owner ? personHandle(author.owner) : null;
  const name = authorName(author);
  return (
    <span className="author" data-kind={author.kind}>
      <span className="author__name">{agent || author.kind === 'bot' ? name : owner ?? name}</span>
      {agent && owner ? <span className="author__owner">for {owner}</span> : null}
      {detail && agent && author.tool ? (
        <span className="author__detail" title={author.session ? `Session ${author.session}` : undefined}>
          {author.tool}
        </span>
      ) : null}
    </span>
  );
}
