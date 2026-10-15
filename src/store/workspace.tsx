import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useKumoToastManager } from '@cloudflare/kumo';
import type { Mission, WorkspaceSnapshot } from '../../shared/types';
import { ApiError, api, errorMessage, retryDelay } from '../lib/api';
import { EXAMPLE_SESSION_LIMIT } from '../../shared/errors';
import { isMissionActive, isStopped } from '../lib/task-state';
import { shortHash } from '../lib/format';
import { onFollow, pollInterval, pollingFloored, PUBLIC_POLL_INTERVAL, setPublicPolling } from '../lib/polling';
import { setRouteRef } from '../lib/router';
import { useMirror, type MirrorSnapshot } from '../account/mirrors';

export interface WorkspaceValue {
  snapshot: WorkspaceSnapshot | null;
  /** True until the first read settles. */
  loading: boolean;
  /** Set when a read failed. With a snapshot present the UI is stale, not broken. */
  error: string | null;
  /** The HTTP status of that failure, 0 for a network error. */
  errorStatus: number | null;
  /** The failure's code, when the server gave one. */
  errorCode: string | null;
  /** When the last read before that failure succeeded. */
  lastUpdated: number | null;
  /** A read is on its way while a failure shows, for its retry control. */
  refreshing: boolean;
  refresh: () => Promise<WorkspaceSnapshot | null>;
  /** Replace a mission in the local snapshot with an authoritative copy from the server. */
  applyMission: (mission: Mission) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

const ACTIVE_INTERVAL = 2_000;
const IDLE_INTERVAL = 8_000;
const RETRY_INTERVAL = 5_000;

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const mirror = useMirror();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<{ message: string; status: number; code?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // A switch to another repository unmounts this provider; answers that arrive later are dropped.
  const alive = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<WorkspaceSnapshot | null> | null>(null);
  const revision = useRef(0);
  const previous = useRef<WorkspaceSnapshot | null>(null);
  const lastRead = useRef(0);
  // A poll that changes nothing renders nothing: its time and progress become state only while a failure shows them.
  const succeeded = useRef<number | null>(null);
  const failing = useRef(false);
  const toasts = useKumoToastManager();
  const toastManager = useRef(toasts);
  toastManager.current = toasts;

  const announce = useCallback(
    (before: WorkspaceSnapshot | null, after: WorkspaceSnapshot) => {
      if (!before) return;
      for (const mission of after.missions) {
        const old = before.missions.find((m) => m.id === mission.id);
        if (!old || old.status === mission.status) continue;
        // Only real progress is announced. A demo reset moving a mission back is not news.
        if (old.status === 'running' && mission.status === 'review') toastManager.current.add({ title: 'Agents finished', description: mission.title, variant: 'info' });
        else if ((old.status === 'merging' || old.status === 'review') && mission.status === 'merged')
          toastManager.current.add({ title: 'Merged into main', description: mission.mergeCommit ? `${mission.title} · ${shortHash(mission.mergeCommit)}` : mission.title, variant: 'success' });
        // Stopping is the owner's own action and already confirmed where they did it.
        else if (mission.status === 'failed' && !isStopped(mission)) toastManager.current.add({ title: 'Task failed', description: mission.error ?? mission.title, variant: 'error' });
      }
    },
    [],
  );

  const refresh = useCallback((): Promise<WorkspaceSnapshot | null> => {
    if (inFlight.current) return inFlight.current;
    const startedIn = revision.current;
    lastRead.current = Date.now();
    if (failing.current) setRefreshing(true);
    const promise = api
      .state()
      .then((next) => {
        if (!alive.current || startedIn !== revision.current) return null;
        // An unchanged poll returns the same snapshot object, which renders nothing new.
        if (next !== previous.current) announce(previous.current, next);
        setPublicPolling(!next.capabilities.identity);
        previous.current = next;
        setRouteRef(next.project.branch);
        setSnapshot(next);
        succeeded.current = Date.now();
        failing.current = false;
        setError(null);
        setLoading(false);
        return next;
      })
      .catch((err: unknown) => {
        if (!alive.current || startedIn !== revision.current) return null;
        failing.current = true;
        setError({ message: errorMessage(err), status: err instanceof ApiError ? err.status : 0, code: err instanceof ApiError ? err.code : undefined });
        setLastUpdated(succeeded.current);
        setLoading(false);
        return null;
      })
      .finally(() => {
        if (inFlight.current === promise) {
          inFlight.current = null;
          setRefreshing(false);
        }
      });
    inFlight.current = promise;
    return promise;
  }, [announce]);

  const applyMission = useCallback((mission: Mission) => {
    // A read sent before the write (including a shared-example 304) cannot undo its answer.
    revision.current += 1;
    inFlight.current = null;
    setSnapshot((current) => {
      if (!current) return current;
      const next = { ...current, missions: current.missions.map((m) => (m.id === mission.id ? mission : m)) };
      previous.current = next;
      return next;
    });
  }, []);

  // An import still copying, or its branches still arriving, is followed as closely as a running task.
  const importing = !!snapshot?.importing && !snapshot.importing.error;
  const copying = importing || !!snapshot?.branchCopy;
  const active = copying || !!snapshot?.missions.some(mission => isMissionActive(mission) && (mission.execution !== 'local' || mission.status === 'merging' || mission.agents.some(agent => agent.status === 'forking')));

  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      // A visitor sees no file until an import lands, and their visit started it, so it is followed past the public floor.
      const followed = importing && !error;
      const delay = Math.max(retryDelay(), followed ? ACTIVE_INTERVAL : pollInterval(error ? RETRY_INTERVAL : active ? ACTIVE_INTERVAL : IDLE_INTERVAL));
      timer.current = window.setTimeout(async () => {
        if (navigator.onLine !== false && document.visibilityState !== 'hidden' && (followed || !pollingFloored() || Date.now() - lastRead.current >= PUBLIC_POLL_INTERVAL)) await refresh();
        schedule();
      }, delay);
    };
    schedule();
    const stopFollowing = onFollow(() => { if (timer.current) window.clearTimeout(timer.current); schedule(); });
    return () => {
      cancelled = true;
      stopFollowing();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [active, importing, error, refresh, snapshot?.capabilities.identity]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (navigator.onLine !== false && document.visibilityState === 'visible' && (!pollingFloored() || Date.now() - lastRead.current >= PUBLIC_POLL_INTERVAL)) void refresh();
    };
    const onOnline = () => { void refresh(); };
    const onOffline = () => {
      failing.current = true;
      setError({ message: 'You’re offline. Reconnect to get updates.', status: 0 });
      setLastUpdated(succeeded.current);
    };
    const onExampleLimit = () => setSnapshot(current => current?.capabilities.mode === 'demo' ? { ...current, capabilities: { ...current.capabilities, canWrite: false } } : current);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('braid:example-readonly', onExampleLimit);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('braid:example-readonly', onExampleLimit);
    };
  }, [refresh]);

  const value = useMemo<WorkspaceValue>(
    () => ({ snapshot: snapshot && mirror ? { ...snapshot, mirror, capabilities: { ...snapshot.capabilities, canWrite: false } } as MirrorSnapshot : snapshot, loading, error: error?.message ?? null, errorStatus: error?.status ?? null, errorCode: error?.code ?? null, lastUpdated, refreshing, refresh, applyMission }),
    [snapshot, mirror, loading, error, lastUpdated, refreshing, refresh, applyMission],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}

/** For screens that render only once a snapshot exists. */
export function useSnapshot(): WorkspaceSnapshot {
  const { snapshot } = useWorkspace();
  if (!snapshot) throw new Error('useSnapshot called before the workspace loaded.');
  return snapshot;
}

/** Shown on every control that would change the workspace when the signed-in person can only read it. */
const READ_ONLY_REASON = 'Only a workspace owner can make changes.';

/** The recorded example answers what needs you; everything else there is replayed, so other writes answer 409. */
export const EXAMPLE_REASON = 'This works on your own repository, not in the recorded example.';
export const EXAMPLE_REVERT = 'Revert works on your own repository, not in the recorded example.';

/** A visitor reads a public repository without signing in; a member reads one they do not own. */
function isSignedOut(snapshot: WorkspaceSnapshot): boolean {
  return !snapshot.capabilities.identity && !snapshot.capabilities.canWrite;
}

/**
 * Why a control that would change the repository is disabled for this viewer: a visitor is asked to
 * sign in, naming what they would do, and a member is told only an owner may.
 */
export function readOnlyReason(snapshot: WorkspaceSnapshot | null, action = 'make changes'): string {
  if ((snapshot as MirrorSnapshot | null)?.mirror) return `Claim this repository to ${action}.`;
  if (snapshot?.capabilities.mode === 'demo' && !snapshot.capabilities.canWrite) return EXAMPLE_SESSION_LIMIT;
  return snapshot && isSignedOut(snapshot) ? `Sign in to ${action}.` : READ_ONLY_REASON;
}

/** Why a person cannot answer a change right now, or null when they can. The recorded example accepts answers. */
export function answerBlocker(snapshot: WorkspaceSnapshot | null): string | null {
  if (!snapshot) return 'The workspace is still loading.';
  if (!canWrite(snapshot)) return readOnlyReason(snapshot, 'review pull requests');
  return null;
}

/** Why landing, simulated agents or a revert cannot be changed right now, or null when they can. */
export function liveBlocker(snapshot: WorkspaceSnapshot | null): string | null {
  if (!snapshot) return 'The workspace is still loading.';
  if (!canWrite(snapshot)) return readOnlyReason(snapshot, 'change this repository');
  if (snapshot.capabilities.mode !== 'live') return EXAMPLE_REASON;
  return null;
}

/** Members read; owners and demo visitors write. */
export function canWrite(snapshot: WorkspaceSnapshot | null): boolean {
  return !!snapshot && !(snapshot as MirrorSnapshot).mirror && snapshot.capabilities.canWrite;
}

/** Why a new task cannot start right now, or null when it can. */
export function newMissionBlocker(snapshot: WorkspaceSnapshot | null): string | null {
  if (!snapshot) return 'The workspace is still loading.';
  if (!canWrite(snapshot)) return readOnlyReason(snapshot, 'start a task');
  if (!snapshot.project.id) return 'Create or import a repository first.';
  if (snapshot.missions.some(mission => mission.status === 'merging')) return 'Main is being updated. Try again when the merge finishes.';
  return null;
}
