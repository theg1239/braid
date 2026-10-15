import { useSyncExternalStore } from 'react';
import { readStoredList, writeStored } from './storage';

/*
 * Which files of a revision this person has marked as viewed, as GitHub remembers it. The
 * mark is a reading aid, not a credential, so it lives in this browser's localStorage, keyed
 * by change and revision: a new revision starts unviewed.
 */

const EMPTY: ReadonlySet<string> = new Set();
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const storageKey = (changeId: string, revision: number) => `braid.viewed:${changeId}:${revision}`;

function read(key: string): ReadonlySet<string> {
  const known = sets.get(key);
  if (known) return known;
  const set: ReadonlySet<string> = new Set(readStoredList<string>(key));
  sets.set(key, set);
  return set;
}

/** Every path marked as viewed on one revision. The set is replaced, never mutated, when a mark changes. */
export function useViewed(changeId: string, revision: number): ReadonlySet<string> {
  const key = storageKey(changeId, revision);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(key),
    () => EMPTY,
  );
}

export function setViewed(changeId: string, revision: number, path: string, viewed: boolean) {
  const key = storageKey(changeId, revision);
  const next = new Set(read(key));
  if (viewed) next.add(path);
  else next.delete(path);
  sets.set(key, next);
  writeStored('localStorage', key, next.size ? JSON.stringify([...next]) : null);
  for (const listener of listeners) listener();
}
