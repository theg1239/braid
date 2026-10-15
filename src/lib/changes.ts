import type { BatchSummary, Change, ChangeAuthor, ChangeCheck, ChangeEvent, ChangeReview, ChangeStatus, ChangeSummary, MergeConflictKind } from '../../shared/types';
import { progressOf, reviewerName } from '../../shared/labels';
import { modelName } from '../../shared/models';
import { personHandle } from '../../shared/people';
import type { BadgeTone } from './derive';
import { joinNames, plural } from './format';

/* ---------- Vocabulary: GitHub's words for where a pull request is ---------- */

/** Open, merged or closed, as GitHub shows a pull request. */
type PullState = 'open' | 'merged' | 'closed';

export function pullState(status: ChangeStatus): PullState {
  return status === 'landed' ? 'merged' : status === 'closed' ? 'closed' : 'open';
}

export const PULL_STATE: Record<PullState, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'success' },
  merged: { label: 'Merged', tone: 'purple' },
  closed: { label: 'Closed', tone: 'error' },
};

/** One or two words: merged, closed, or what an open pull request waits for. */
export function statusLabel(change: Pick<ChangeSummary, 'status'>): { label: string; tone: BadgeTone } {
  const state = pullState(change.status);
  if (state !== 'open') return PULL_STATE[state];
  return { label: progressOf(change.status), tone: change.status === 'attention' ? 'warning' : change.status === 'revise' ? 'error' : 'info' };
}

/** The tone of a list label: a pull request that needs the viewer, or one that went back to its author. */
export function labelTone(status: ChangeStatus): 'warning' | 'danger' | 'neutral' {
  return status === 'attention' ? 'warning' : status === 'revise' ? 'danger' : 'neutral';
}

/* ---------- Reviews and checks, summarised for a row, a merge box or a commit ---------- */

export type ReviewState = 'needed' | 'changes' | 'approved' | 'pending' | 'none';

/** Where review stands, from the status and the current revision's reviews. */
export function reviewState(change: Pick<ChangeSummary, 'status' | 'revision'> & { reviews?: ChangeReview[] }): { state: ReviewState; label: string } {
  if (change.status === 'attention') return { state: 'needed', label: 'Needs your review' };
  if (change.status === 'revise') return { state: 'changes', label: 'Changes requested' };
  if (change.status === 'queued' || change.status === 'landing' || change.status === 'landed') return { state: 'approved', label: 'Approved' };
  if (change.status === 'closed') return { state: 'none', label: 'Closed' };
  const approved = (change.reviews ?? []).some((review) => review.revision === change.revision && review.verdict === 'approve');
  return approved ? { state: 'approved', label: 'Approved' } : { state: 'pending', label: 'Review required' };
}

export type CheckState = 'passed' | 'failed' | 'warning' | 'reported' | 'none';

/** What the checks of one revision add up to. Agent-reported results never count as a pass. */
export function checkState(checks: ChangeCheck[]): { state: CheckState; label: string } {
  if (!checks.length) return { state: 'none', label: 'No checks' };
  const failed = checks.filter((check) => check.status === 'failed');
  if (failed.length) return { state: 'failed', label: failed.length <= 2 ? `${joinNames(failed.map((check) => check.label))} failed` : `${failed.length} of ${checks.length} checks failed` };
  const ran = checks.filter((check) => check.source !== 'agent');
  if (!ran.length) return { state: 'reported', label: 'Agent-reported only' };
  const warnings = ran.filter((check) => check.status === 'warning');
  if (warnings.length) return { state: 'warning', label: warnings.length === 1 && checks.length === 1 ? `${warnings[0].label}: warning` : `${warnings.length} of ${checks.length} checks with warnings` };
  return { state: 'passed', label: checks.length === 1 ? '1 check passed' : `All ${checks.length} checks passed` };
}

/**
 * Where a result comes from, as the Checks tab groups it the way GitHub groups by app. Braid
 * ran the repository's commands and Dependency review on the combined result; GitHub covers
 * Actions, CodeQL and review apps; CI is a status the repository's own CI reported through the
 * merge queue's webhook; an agent's own report is never a verified pass.
 */
export type CheckGroup = 'braid' | 'github' | 'ci' | 'agent';
export const CHECK_GROUPS: { group: CheckGroup; label: string; detail: string }[] = [
  { group: 'braid', label: 'Braid', detail: 'Run on main with this pull request applied.' },
  { group: 'github', label: 'GitHub', detail: 'On the merge queue’s pull request on GitHub.' },
  { group: 'ci', label: 'CI', detail: 'Reported by the repository’s CI for the merge queue’s commit.' },
  { group: 'agent', label: 'Agent-reported', detail: 'Reported by the agent. Braid did not run it.' },
];
export function checkGroup(source: ChangeCheck['source']): CheckGroup {
  return source === 'agent' ? 'agent' : source === 'braid' ? 'braid' : source === 'ci' ? 'ci' : 'github';
}

/** Code security rows on the Checks tab, named as GitHub names its scans. */
export const GUARD_CHECK: Record<NonNullable<Change['guards']>[number]['kind'], string> = { secrets: 'Secret scanning', tests: 'Test changes', dependencies: 'Dependency downgrade', instructions: 'Instruction check' };

export const VERDICT: Record<ChangeReview['verdict'], { label: string; tone: BadgeTone }> = {
  approve: { label: 'Approved', tone: 'success' },
  revise: { label: 'Changes requested', tone: 'warning' },
  escalate: { label: 'Escalated', tone: 'warning' },
  reject: { label: 'Rejected', tone: 'error' },
  comment: { label: 'Commented', tone: 'neutral' },
};

export const CONFLICT_KIND: Record<MergeConflictKind, string> = {
  content: 'The same lines changed on main.',
  'add-add': 'Main added this file with different contents.',
  'modify-delete': 'Main deleted this file.',
  'delete-modify': 'Main edited this file.',
  binary: 'A binary file changed on both sides.',
  mode: 'The file mode changed on both sides.',
  type: 'The entry changed type on one side.',
};

/* ---------- People, agents and reviewers ---------- */

/*
 * An agent is a model run by a person's tool, so it reads as the model plus whose agent it is:
 * "Claude Opus 5.5 for @maya-chen". A person reads as themselves. There are no invented names.
 */

export const isAgentAuthor = (author: Pick<ChangeAuthor, 'kind'>) => author.kind === 'agent' || author.kind === 'simulated';

/** An agent as people see it: its model, a simulated one as Simulated rather than its generated id. */
export function authorName(author: ChangeAuthor): string {
  return author.kind === 'simulated' || author.model === 'simulated' ? modelName('simulated') : author.name;
}

/** Who made a change, in one line: the model and its owner, or the person. */
export function authorLine(author: ChangeAuthor): string {
  if (author.kind === 'bot') return author.name;
  const owner = author.owner ? personHandle(author.owner) : null;
  if (!isAgentAuthor(author)) return owner ?? author.name;
  return owner ? `${authorName(author)} for ${owner}` : authorName(author);
}

/** Who produced a review: a readable name and where it comes from. */
export function reviewerLabel(review: Pick<ChangeReview, 'reviewer' | 'kind' | 'model' | 'author'>): { name: string; detail: string | null; simulated: boolean } {
  if (review.author) return { name: authorLine(review.author), detail: review.author.tool ?? null, simulated: review.author.kind === 'simulated' };
  const id = review.reviewer;
  if (id === 'simulated-reviewer') return { name: 'Simulated reviewer', detail: null, simulated: true };
  if (id === 'example-visitor') return { name: 'You', detail: null, simulated: false };
  if (id.startsWith('braid-reviewer')) return { name: 'Braid reviewer', detail: review.model ?? (id.slice('braid-reviewer:'.length) || null), simulated: false };
  if (id.startsWith('github:')) return { name: reviewerName(id), detail: 'GitHub app', simulated: false };
  if (id.startsWith('user:')) return { name: reviewerName(id).replace(/^user:/, ''), detail: null, simulated: false };
  return { name: reviewerName(id), detail: review.kind === 'human' ? null : review.model ?? 'agent', simulated: false };
}

export function reviewsFor(reviews: ChangeReview[], revision: number): ChangeReview[] {
  return reviews.filter((review) => review.revision === revision);
}

export function checksFor(checks: ChangeCheck[], revision: number): ChangeCheck[] {
  return checks.filter((check) => check.revision === revision);
}

/* ---------- The merge queue ---------- */

/** The pull requests a failed batch put back in the queue. */
export function retried(batch: BatchSummary): number[] {
  return (batch.requeued ?? []).map((item) => item.number);
}

/** What one queue entry did, in GitHub's words. */
export function batchSentence(batch: BatchSummary): string {
  if (batch.status === 'landed') return `Merged ${plural(batch.landed.length, 'pull request')}`;
  if (batch.status === 'failed') {
    if (batch.ejected.length) return `Removed ${batch.ejected.map((item) => `#${item.number}`).join(', ')} from the queue`;
    const count = retried(batch).length;
    return count ? `Did not merge ${plural(count, 'pull request')}` : 'Did not merge';
  }
  return batch.status === 'pushing' ? 'Merging' : batch.status === 'verifying' ? 'Running checks' : 'Merging with main';
}

/** A pull request's own story reads oldest first. */
export function eventsInOrder(events: ChangeEvent[]): ChangeEvent[] {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
