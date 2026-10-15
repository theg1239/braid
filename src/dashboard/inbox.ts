import { accountOwners, type Account, type AccountIdentity, type RepositoryWorkspace, type Organization } from '../../shared/account';
import type { ChangePage, ChangeSummary } from '../../shared/types';
import { ApiError, request } from '../lib/api';
import { filterCount } from '../lib/lists';
import { useLive } from '../lib/live';
import { useNow } from '../lib/hooks';

export interface InboxRepository {
  team: Organization;
  workspace: RepositoryWorkspace;
  address: { owner: string; repo: string };
}

export interface InboxItem extends InboxRepository { change: ChangeSummary }
export interface InboxData {
  items: InboxItem[];
  open: Record<string, number>;
  unavailable: InboxRepository[];
  /** Keep the server's retry time when individual repository reads are rate limited. */
  retryMessage?: string;
}
export interface InboxGroups {
  review: InboxItem[];
  returned: InboxItem[];
  merging: InboxItem[];
  merged: InboxItem[];
}

const EMPTY_INBOX: InboxData = { items: [], open: {}, unavailable: [] };
const RECENT_MERGES = 8;
const DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;
const PAGE_SIZE = 100;

/** Ownership is the authenticated connection owner's id, never a matching display name. */
export function groupInbox(items: InboxItem[], user: AccountIdentity | null, now: number): InboxGroups {
  const groups: InboxGroups = { review: [], returned: [], merging: [], merged: [] };
  for (const item of items) {
    const { change, team } = item;
    if (change.status === 'attention' && (team.role === 'owner' || item.workspace.canWrite)) groups.review.push(item);
    if (change.status === 'revise' && change.author.kind === 'agent' && user && change.author.owner?.id === `user:${user.id}`) groups.returned.push(item);
    if (change.status === 'queued' || change.status === 'landing') groups.merging.push(item);
    if (change.status === 'landed' && Date.parse(change.updatedAt) >= now - DAY) groups.merged.push(item);
  }
  const oldest = (a: InboxItem, b: InboxItem) => Date.parse(a.change.updatedAt) - Date.parse(b.change.updatedAt);
  groups.review.sort(oldest);
  groups.returned.sort(oldest);
  groups.merging.sort((a, b) => Number(b.change.status === 'landing') - Number(a.change.status === 'landing') || oldest(a, b));
  groups.merged.sort((a, b) => oldest(b, a));
  groups.merged = groups.merged.slice(0, RECENT_MERGES);
  return groups;
}

/**
 * Every repository participates. Four requests run at once, each with a deadline; active
 * requests page separately so a busy merge queue cannot bury an older question. Only the
 * latest eight merges per repository are needed for the eight-row recent list.
 */
export async function readInbox(repos: InboxRepository[]): Promise<InboxData> {
  const data: InboxData = { items: [], open: {}, unavailable: [] };
  const jobs = repos.flatMap(repo => (['attention,revise,queued,landing', 'landed'] as const).map(status => ({ repo, status })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { repo, status } = jobs[next++];
      let cursor: string | null = null;
      try {
        do {
          const query = new URLSearchParams({ status, limit: String(status === 'landed' ? RECENT_MERGES : PAGE_SIZE) });
          if (cursor) query.set('cursor', cursor);
          const page = await request<ChangePage>(`/api/changes?${query}`, {
            headers: { 'x-braid-workspace': repo.workspace.id },
            signal: AbortSignal.timeout(10_000),
          });
          data.open[repo.workspace.id] = filterCount('open', page.counts);
          data.items.push(...page.items.map(change => ({ ...repo, change })));
          cursor = status === 'landed' ? null : page.nextCursor;
        } while (cursor);
      } catch (error) {
        if (error instanceof ApiError && error.retryAt) data.retryMessage = error.message;
        if (!data.unavailable.some(item => item.workspace.id === repo.workspace.id)) data.unavailable.push(repo);
      }
    }
  }));
  // A change can move between pages while they are read. Keep its newest observed version.
  const latest = new Map<string, InboxItem>();
  for (const item of data.items) {
    const key = `${item.workspace.id}:${item.change.id}`;
    const previous = latest.get(key);
    if (!previous || item.change.updatedAt >= previous.change.updatedAt) latest.set(key, item);
  }
  data.items = [...latest.values()];
  return data;
}

/** The dashboard and account menu share this exact resource, including personal repositories. */
export function useInbox(account: Account | null) {
  const now = useNow();
  const user = account?.user ?? null;
  const repos: InboxRepository[] = accountOwners(account).flatMap(team => team.workspaces.map(workspace => ({ team, workspace, address: { owner: team.slug, repo: workspace.slug } })));
  const key = JSON.stringify([user?.id, repos.map(repo => [repo.workspace.id, repo.team.role, repo.workspace.canWrite, repo.address])]);
  const inbox = useLive(user && repos.length ? `inbox:${key}` : null, () => readInbox(repos), 30_000);
  const data = inbox.data ?? EMPTY_INBOX;
  const groups = groupInbox(data.items, user, now);
  return { ...inbox, data, groups, now, loading: !!user && !!repos.length && inbox.loading, needsYou: user ? groups.review.length + groups.returned.length : 0 };
}
