import { readStoredList, writeStored } from './storage';

/*
 * What this person opened lately, for the command menu's Recent group: pull requests, tasks and
 * files, kept in this browser per repository. Titles and hrefs only; never a credential.
 */

export type RecentKind = 'pull' | 'task' | 'file';

interface RecentItem {
  kind: RecentKind;
  /** The in-app href; also the identity, so reopening moves an item to the front. */
  href: string;
  title: string;
  at: number;
}

const LIMIT = 8;
const key = (project: string) => `braid.recent:${project}`;

export const readRecent = (project: string) => readStoredList<RecentItem>(key(project));

export function recordRecent(project: string, item: Omit<RecentItem, 'at'>) {
  if (!project) return;
  const next = [{ ...item, at: Date.now() }, ...readRecent(project).filter((known) => known.href !== item.href)].slice(0, LIMIT);
  writeStored('localStorage', key(project), JSON.stringify(next));
}
