import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { onFollow, pollInterval, pollKey, publicPolling } from './polling';
import { ApiError, errorMessage, onWorkspaceReset, retryDelay } from './api';

/*
 * One shared poll per resource. Every screen that shows the same resource reads the
 * same entry, so a list, its badge in the top bar and a card on the home page cost one
 * request between them. Entries poll only while something subscribes, slow down when
 * their data says nothing is moving, pause in hidden tabs and catch up on return.
 */

interface LiveState<T> {
  data: T | null;
  /** Set when the last read failed. With data present the screen is stale, not broken. */
  error: string | null;
  errorStatus: number | null;
  /** True until the first read settles. */
  loading: boolean;
  refreshing: boolean;
  updatedAt: number | null;
}

export interface Live<T> extends LiveState<T> {
  refresh: () => Promise<T | null>;
}

interface Entry<T> {
  key: string;
  lastRead: number | null;
  state: LiveState<T>;
  fetcher: () => Promise<T>;
  interval: (data: T | null) => number;
  listeners: Set<() => void>;
  timer: number | null;
  promise: Promise<T | null> | null;
}

const RETRY = 5_000;
const entries = new Map<string, Entry<unknown>>();
let generation = 0;

const idle = <T,>(): LiveState<T> => ({ data: null, error: null, errorStatus: null, loading: true, refreshing: false, updatedAt: null });
const IDLE = idle<never>();

function patch<T>(entry: Entry<T>, next: Partial<LiveState<T>>) {
  entry.state = { ...entry.state, ...next };
  for (const listener of entry.listeners) listener();
}

function load<T>(entry: Entry<T>): Promise<T | null> {
  if (pollKey(entry.key) === null) return Promise.resolve(null);
  if (entry.promise) return entry.promise;
  entry.lastRead = Date.now();
  const startedIn = generation;
  patch(entry, { refreshing: true });
  const promise = entry
    .fetcher()
    .then((data) => {
      if (startedIn !== generation) return null;
      patch(entry, { data, error: null, errorStatus: null, loading: false, refreshing: false, updatedAt: Date.now() });
      return data;
    })
    .catch((err: unknown) => {
      if (startedIn !== generation) return null;
      patch(entry, { error: errorMessage(err), errorStatus: err instanceof ApiError ? err.status : 0, loading: false, refreshing: false });
      return null;
    })
    .finally(() => {
      if (entry.promise === promise) entry.promise = null;
      schedule(entry);
    });
  entry.promise = promise;
  return promise;
}

function schedule<T>(entry: Entry<T>) {
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.listeners.size || pollKey(entry.key) === null) return;
  const delay = Math.max(retryDelay(), entry.state.error ? Math.max(RETRY, entry.interval(entry.state.data)) : entry.interval(entry.state.data));
  entry.timer = window.setTimeout(() => {
    entry.timer = null;
    // A hidden tab stops here; becoming visible starts the poll again.
    if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
    void load(entry);
  }, delay);
}

/** Reads every subscribed resource that is not already on its way. */
function catchUp() {
  if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
  for (const entry of entries.values()) {
    if (!entry.listeners.size || entry.promise) continue;
    const readAt = publicPolling() ? entry.lastRead : entry.state.updatedAt;
    const age = readAt === null ? Infinity : Date.now() - readAt;
    if (publicPolling() ? age >= entry.interval(entry.state.data) : entry.timer === null || age > entry.interval(entry.state.data)) void load(entry);
  }
}

document.addEventListener('visibilitychange', catchUp);
window.addEventListener('focus', catchUp);
window.addEventListener('online', () => {
  for (const entry of entries.values()) if (entry.listeners.size) void load(entry);
});
window.addEventListener('offline', () => {
  for (const entry of entries.values()) if (entry.listeners.size) patch(entry, { error: 'You’re offline. Reconnect to get updates.', errorStatus: 0 });
});
// A visitor's own write: waiting polls shorten at once instead of after their thirty seconds.
onFollow(() => { for (const entry of entries.values()) if (entry.timer !== null) schedule(entry); });
// Another repository or another person: nothing read so far may show again.
onWorkspaceReset(() => {
  generation += 1;
  for (const [key, entry] of entries) {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.promise = null;
    entry.lastRead = null;
    if (!entry.listeners.size) {
      entries.delete(key);
      continue;
    }
    entry.state = idle();
    for (const listener of entry.listeners) listener();
    void load(entry);
  }
});

function entryFor<T>(key: string, fetcher: () => Promise<T>, interval: (data: T | null) => number, initial?: T): Entry<T> {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = { key, lastRead: null, state: idle(), fetcher, interval, listeners: new Set(), timer: null, promise: null };
    if (initial !== undefined) {
      entry.lastRead = Date.now();
      entry.state = { ...entry.state, data: initial, loading: false, updatedAt: entry.lastRead };
    }
    entries.set(key, entry as Entry<unknown>);
  }
  entry.fetcher = fetcher;
  entry.interval = interval;
  return entry;
}

/**
 * Subscribes to a polled resource. `key` names it across the app; `interval` is a number
 * of milliseconds or a function of the latest data, so a queue that is landing can be read
 * every few seconds and a quiet one every half minute. Pass a null key to read nothing.
 * `initial` seeds a read already made by the screen, so the first background read respects its interval.
 */
export function useLive<T>(key: string | null, fetcher: () => Promise<T>, interval: number | ((data: T | null) => number), initial?: T): Live<T> {
  const tick = typeof interval === 'number' ? () => interval : interval;
  key = pollKey(key);
  const entry = key === null ? null : entryFor(key, fetcher, data => pollInterval(tick(data)), initial);
  // One subscription per entry: a new function each render would make React subscribe again on every
  // render, restarting a lone reader's timer so that a poll slower than its re-renders never ran.
  const subscribe = useCallback((listener: () => void) => {
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    if (!entry.state.updatedAt && !entry.promise) void load(entry);
    else if (entry.timer === null && !entry.promise) schedule(entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer !== null) {
        window.clearTimeout(entry.timer);
        entry.timer = null;
      }
    };
  }, [entry]);
  const read = useCallback(() => (entry ? entry.state : (IDLE as LiveState<T>)), [entry]);
  const state = useSyncExternalStore(subscribe, read, read);

  // The latest data decides the next delay; re-arm when it changes.
  useEffect(() => {
    if (entry && entry.listeners.size && !entry.promise) schedule(entry);
  }, [entry, state.data]);

  return useMemo(() => ({ ...state, refresh: () => (entry ? load(entry) : Promise.resolve(null)) }), [state, entry]);
}

/**
 * Starts reading a resource before anything shows it, so the screen that will mounts onto a
 * request already in flight. A fresh answer is reused; a stale one is read again.
 */
export function primeLive<T>(key: string, fetcher: () => Promise<T>, interval: number | ((data: T | null) => number)) {
  const tick = typeof interval === 'number' ? () => interval : interval;
  if (pollKey(key) === null) return;
  const entry = entryFor(key, fetcher, data => pollInterval(tick(data)));
  const readAt = publicPolling() ? entry.lastRead : entry.state.updatedAt;
  const age = readAt === null ? Infinity : Date.now() - readAt;
  if (!entry.promise && age > entry.interval(entry.state.data)) void load(entry);
}

/** Reads an existing answer without fetching or subscribing. */
export function peekLive<T>(key: string): T | undefined {
  return (entries.get(key) as Entry<T> | undefined)?.state.data ?? undefined;
}

/** Puts an authoritative answer from a write into the shared entry, so every screen shows it at once. */
export function setLive<T>(key: string, data: T) {
  const entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) return;
  patch(entry, { data, error: null, errorStatus: null, loading: false, updatedAt: Date.now() });
}

/** Re-reads every subscribed resource whose key starts with `prefix`, after a write changed what they show. */
export function refreshLive(prefix: string) {
  for (const [key, entry] of entries) if (key.startsWith(prefix) && entry.listeners.size) void load(entry);
}
