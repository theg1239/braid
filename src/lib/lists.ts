import type { ChangeCounts, ChangeStatus, ChangeSummary, TrunkStatus } from '../../shared/types';
import type { PullFilter } from './router';

/*
 * Which statuses each pull request list shows, and how often lists and the queue are read. Kept apart from the rest
 * of the pull request vocabulary in changes.ts, so the shell that polls them carries nothing else.
 */

/** Statuses that change on their own, so screens showing them poll faster. */
function isMoving(status: ChangeStatus): boolean {
  return status === 'open' || status === 'queued' || status === 'landing';
}

/** How fast to read one pull request: every few seconds while it can change on its own. */
export function changeInterval(change: Pick<ChangeSummary, 'status'> | null): number {
  return change && isMoving(change.status) ? 3_000 : 12_000;
}

export const FILTER_STATUSES: Record<PullFilter, ChangeStatus[]> = {
  review: ['attention'],
  open: ['open', 'revise', 'attention', 'queued', 'landing'],
  closed: ['landed', 'closed'],
};

export function filterCount(filter: PullFilter, counts: ChangeCounts): number {
  return FILTER_STATUSES[filter].reduce((sum, status) => sum + counts[status], 0);
}

/** How fast to read the queue: every few seconds while something is merging or waiting, otherwise slowly. */
export function queueInterval(queue: TrunkStatus | null): number {
  if (!queue) return 6_000;
  if (queue.landing) return 2_500;
  if (queue.queued > 0 && queue.enabled && !queue.paused) return 4_000;
  return 15_000;
}

export function listInterval(page: { items: ChangeSummary[]; counts: ChangeCounts } | null): number {
  if (!page) return 6_000;
  if (page.counts.landing > 0 || page.counts.queued > 0 || page.items.some((item) => isMoving(item.status))) return 4_000;
  return 15_000;
}
