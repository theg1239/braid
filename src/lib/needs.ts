import type { WorkspaceSnapshot } from '../../shared/types';
import { changes } from './api';
import { filterCount, listInterval } from './lists';
import { useLive } from './live';
import { publicPolling } from './polling';

/** The list every screen with a review count reads, so the header costs no extra request. */
export const ATTENTION_KEY = 'changes:list:attention';
export const attentionList = () => changes.list({ status: 'attention', limit: 50 });

/** The latest merge, for the Code page's commit bar. Every list carries the counts of every state, so a visitor's tabs read this one. */
export const LATEST_KEY = 'changes:list:latest';
export const latestList = () => changes.list({ status: 'landed', limit: 1 });

/** The newest pull requests in every state, which ⌘K and the pull list's filter box search, a page at a time. */
export const SEARCH_KEY = 'changes:list:search';
export const SEARCH_PAGE = 100;
export const searchList = () => changes.list({ limit: SEARCH_PAGE });

/** What the merge queue is merging and what waits behind it. */
export const QUEUE_LIST_KEY = 'changes:list:queue';
export const queueList = () => changes.list({ status: 'queued,landing', limit: 50 });

/**
 * For the tabs, as GitHub counts open items: open pull requests for everyone, how many need the viewer's review, and
 * open tasks. Nothing waits for a visitor's review.
 */
/** The tab counts: null until known, so the header can hold their place while they load and show nothing for a known zero. */
export function useHeaderCounts(snapshot: WorkspaceSnapshot | null): { open: number | null; review: number; tasks: number | null } {
  const visitor = publicPolling();
  const list = useLive(snapshot?.project.id ? (visitor ? LATEST_KEY : ATTENTION_KEY) : null, visitor ? latestList : attentionList, listInterval);
  const counts = list.data?.counts;
  const tasks = snapshot ? snapshot.missions.filter((mission) => mission.status !== 'merged' && mission.status !== 'failed').length : null;
  // A repository without a project yet has no pull requests to count.
  const open = counts ? filterCount('open', counts) : snapshot && !snapshot.project.id ? 0 : null;
  return { open, review: visitor ? 0 : counts?.attention ?? 0, tasks };
}
