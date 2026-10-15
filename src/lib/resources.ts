import type { RepositoryFile, RepositoryTree } from '../../shared/repository';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent, FileChange, IntegrationPreview, Mission } from '../../shared/types';
import { changeIdentity } from '../../shared/tasks';
import { ApiError, api, changes as changeApi, errorMessage, onWorkspaceReset } from './api';
import { changeInterval } from './lists';
import { taskChange } from './derive';
import { useLive } from './live';
import { blames, files, reader, readGeneration, subscribeReads, trees, type Reader } from './reads';

/* ---------- The change a task became ---------- */

/**
 * A task that landed through the queue is a change now. Its status is read live, under the
 * same key the change page and the home rows use, so the task page says "waiting to land",
 * "landing" and "landed" as the change does rather than as the snapshot last saw it.
 */
export type TaskChange = NonNullable<Agent['change']> & { title?: string };

export function useTaskChange(mission: Mission | null): TaskChange | null {
  const link = mission ? taskChange(mission) ?? null : null;
  const number = link?.number;
  const live = useLive(number ? `changes:item:${number}` : null, () => changeApi.get(String(number)), changeInterval);
  if (!link || !mission) return null;
  const fresh = live.data && live.data.id === link.id ? live.data : null;
  const status = mission.status === 'merged' ? 'landed' : fresh ? fresh.status : link.status;
  return fresh ? { ...link, status, title: fresh.title } : { ...link, status };
}

/*
 * Moving between tabs and files shows the last known content at once and revalidates behind it,
 * instead of collapsing into a loading state. A render reads the answers in reads.ts directly and
 * subscribes to its own, so an answer that arrives just after a render renders it again, and no
 * other reader on the page renders for it.
 */

/** An answer for `args`, read when missing: the answer, an error with a retry, or neither while it loads. */
export function useRead<A extends unknown[], T>(source: Reader<A, T>, args: A | null) {
  const key = args ? source.key(...args) : null;
  const value = useSyncExternalStore(subscribeReads, () => (key === null ? undefined : source.values.get(key)));
  const [failure, setFailure] = useState<{ key: string; message: string; status: number | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!args || key === null || source.values.has(key)) return;
    let cancelled = false;
    source.load(...args).catch((err: unknown) => {
      if (!cancelled) setFailure({ key, message: errorMessage(err), status: err instanceof ApiError ? err.status : null });
    });
    return () => {
      cancelled = true;
    };
    // The key names every argument.
  }, [source, key, attempt]);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [retry]);
  return { key, value, error: value === undefined && key !== null && failure?.key === key ? failure.message : null, errorStatus: value === undefined && key !== null && failure?.key === key ? failure.status : null, retry };
}

/* ---------- Integration preview ---------- */

interface PreviewEntry {
  key: string;
  preview?: IntegrationPreview;
  promise?: Promise<IntegrationPreview>;
}

const previews = new Map<string, PreviewEntry>();
onWorkspaceReset(() => previews.clear());

/**
 * Anything that changes what the server would compose or fingerprint. The evidence an agent
 * submits is part of it, so a resubmission with the same files but new checks or a new
 * explanation replaces the cached preview too.
 */
function compositionKey(mission: Mission, head: string): string {
  return JSON.stringify([
    mission.status,
    mission.baseCommit,
    mission.mergeCommit,
    head,
    mission.agents.map((a) => [
      a.status,
      a.commit,
      a.revision,
      a.previousCommit,
      a.summary,
      a.rationale,
      a.checks.map((check) => [check.label, check.status, check.detail]),
      a.changes.map((change) => [change.path, changeIdentity(change)]),
    ]),
    mission.collisions.map((c) => [c.id, c.resolution?.agentId, c.resolution?.reason]),
  ]);
}

/** One request per composition; concurrent callers share it. */
function loadPreview(missionId: string, key: string): Promise<IntegrationPreview> {
  const entry = previews.get(missionId);
  if (entry?.key === key && entry.promise) return entry.promise;
  const startedIn = readGeneration();
  const promise = api.integration(missionId).then((preview) => {
    const current = previews.get(missionId);
    if (readGeneration() === startedIn && current?.key === key) current.preview = preview;
    return preview;
  });
  previews.set(missionId, { key, promise });
  promise.catch(() => {
    if (previews.get(missionId)?.promise === promise) previews.delete(missionId);
  });
  return promise;
}

/** Starts loading a preview without rendering it, so the Merge tab opens on fresh data. The tab reads it again and shows a failure. */
export function prefetchPreview(mission: Mission, head: string) {
  void loadPreview(mission.id, compositionKey(mission, head)).catch(() => undefined);
}

interface PreviewState {
  preview: IntegrationPreview | null;
  error: string | null;
  /** True when the preview changed after it was first shown here. */
  changed: boolean;
  reload: () => Promise<IntegrationPreview | null>;
  acknowledge: () => void;
}

/**
 * A preview is only shown on mount if it matches the current composition. While
 * mounted, a newer composition replaces it in place and is flagged as changed.
 */
export function useIntegrationPreview(mission: Mission, head: string, enabled = true): PreviewState {
  const key = compositionKey(mission, head);
  const fresh = (() => {
    const entry = previews.get(mission.id);
    return entry?.key === key ? entry.preview ?? null : null;
  })();
  const [preview, setPreview] = useState<IntegrationPreview | null>(fresh);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const shown = useRef<string | null>(fresh?.fingerprint ?? null);

  const accept = useCallback((next: IntegrationPreview) => {
    if (shown.current && shown.current !== next.fingerprint) setChanged(true);
    shown.current = next.fingerprint;
    setPreview(next);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    previews.delete(mission.id);
    try {
      const next = await loadPreview(mission.id, key);
      accept(next);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [mission.id, key, accept]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadPreview(mission.id, key)
      .then((next) => {
        if (!cancelled) accept(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, mission.id, accept]);

  const acknowledge = useCallback(() => {
    setChanged(false);
    shown.current = preview?.fingerprint ?? null;
  }, [preview]);

  return { preview, error, changed, reload, acknowledge };
}

/* ---------- Proposed file contents ---------- */

/*
 * A proposal's text lives outside the workspace snapshot. Each stored version is immutable
 * and addressed by its content reference, so a loaded version is kept until the repository
 * or session changes. A proposal that was replaced gets a new reference, which re-keys
 * everything below without any invalidation.
 */
const versions = reader(
  (missionId: string, agentId: string, change: FileChange) => `${missionId}\0${agentId}\0${change.path}\0${change.contentRef ?? ''}`,
  // The snapshot's metadata stays authoritative; the server adds the text and hashes.
  (missionId, agentId, change) => api.missionDiff(missionId, agentId, change.path, change.contentRef!).then((full): FileChange => ({ ...change, ...full, contentRef: change.contentRef })),
);

export type ChangeResult =
  | { status: 'ready'; change: FileChange }
  | { status: 'loading' }
  /** `changed` means the proposal was replaced since the snapshot; the next poll re-keys this. */
  | { status: 'error'; message: string; changed: boolean };

interface ChangeEntry {
  agentId: string;
  change: FileChange;
}

/**
 * The full text of each listed version. A version whose text is already in the snapshot is
 * ready at once; the rest load on demand and never render their empty placeholders as code.
 * The list may change length between renders, so this is one hook rather than one per entry.
 */
export function useFileChanges(missionId: string, entries: ChangeEntry[]): { results: ChangeResult[]; retry: () => void } {
  const keys = entries.map((entry) => versions.key(missionId, entry.agentId, entry.change));
  // Renders again when one of these versions arrives, and for nothing else read meanwhile.
  useSyncExternalStore(subscribeReads, () => keys.reduce((loaded, key) => loaded + (versions.values.has(key) ? 1 : 0), 0));
  const signature = keys.join('\n');
  const latest = useRef(entries);
  latest.current = entries;
  const [failures, setFailures] = useState<Map<string, { message: string; changed: boolean }>>(() => new Map());
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // A sign-in or repository switch empties the cache; anything still on screen is read again under the new session.
  useEffect(() => onWorkspaceReset(retry), [retry]);

  useEffect(() => {
    let cancelled = false;
    for (const entry of latest.current) {
      if (!entry.change.contentRef) continue;
      const key = versions.key(missionId, entry.agentId, entry.change);
      if (versions.values.has(key)) continue;
      versions.load(missionId, entry.agentId, entry.change).catch((err: unknown) => {
        if (cancelled) return;
        const changed = err instanceof ApiError && err.status === 409;
        setFailures((prev) => new Map(prev).set(key, { message: errorMessage(err), changed }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [missionId, signature, attempt]);

  const results = entries.map((entry, index): ChangeResult => {
    if (!entry.change.contentRef) return { status: 'ready', change: entry.change };
    const hit = versions.values.get(keys[index]);
    if (hit) return { status: 'ready', change: hit };
    const failed = failures.get(keys[index]);
    if (failed) return { status: 'error', message: failed.message, changed: failed.changed };
    return { status: 'loading' };
  });

  return { results, retry };
}

/** One version's full text, loaded on demand. */
export function useFileChange(missionId: string, agentId: string, change: FileChange): ChangeResult & { retry: () => void } {
  const { results, retry } = useFileChanges(missionId, [{ agentId, change }]);
  return { ...results[0], retry };
}

/* ---------- Pull request diffs ---------- */

/*
 * Diffs load when a file comes into view and stay cached per revision, since a revision never
 * changes once submitted. A comparison with an earlier revision is its own entry, and so is the
 * list of files that differ between two revisions.
 */
const initialDiffs = new Map<string, { revision: number; path: string | undefined; promise: ReturnType<typeof changeApi.diff> }>();
onWorkspaceReset(() => initialDiffs.clear());

/** Start a Files route's first diff alongside its detail, then bind it to the immutable revision key. */
export function readFilesPull(reference: string, path: string | null) {
  const startedIn = readGeneration();
  const first = changeApi.diff(reference, path ?? '');
  // The Files tab takes this read over and shows a failure.
  void first.catch(() => undefined);
  return changeApi.get(reference).then(change => {
    if (startedIn === readGeneration()) {
      initialDiffs.set(change.id, { revision: change.revision, path: path || change.files.map(file => file.path).sort()[0], promise: first });
      void first.then(diff => diffs.put(diffs.key(change.id, diff.revision, diff.path), diff, startedIn), () => {
        if (initialDiffs.get(change.id)?.promise === first) initialDiffs.delete(change.id);
      });
    }
    return change;
  });
}

const diffs = reader(
  (changeId: string, revision: number, path: string, since?: number) => `${changeId}:${revision}:${since ?? ''}:${path}`,
  (changeId: string, revision: number, path: string, since?: number) => {
    const first = since === undefined ? initialDiffs.get(changeId) : undefined;
    const read = () => changeApi.diff(changeId, path, revision, since);
    return first?.revision === revision && first.path === path
      ? first.promise.then(diff => diff.revision === revision && diff.path === path ? diff : read())
      : read();
  },
);
const comparisons = reader((changeId: string, revision: number, since: number) => `${changeId}:${revision}:${since}`, (changeId, revision, since) => changeApi.compare(changeId, revision, since));

/** A pointer on a file row starts its diff, so scrolling to it finds the text ready. */
export function prefetchDiff(changeId: string, revision: number, path: string, since?: number) {
  diffs.prime(changeId, revision, path, since);
}

/** Optional review analysis shares the visible diff's immutable read and in-flight request. */
export function readChangeDiff(changeId: string, revision: number, path: string, since?: number) {
  return diffs.load(changeId, revision, path, since);
}

/** One file's diff for one revision, against main or since an earlier revision: the texts, an error with retry, or neither while it loads. */
export function useChangeDiff(changeId: string, revision: number, path: string, since?: number) {
  const { key, value, error, retry } = useRead(diffs, [changeId, revision, path, since]);
  return { key: key!, diff: value, error, retry };
}

/** The files that differ since an earlier revision, with their line counts: the list, an error with retry, or neither while it loads. */
export function useChangeComparison(changeId: string, revision: number, since: number | undefined) {
  const { value, error, retry } = useRead(comparisons, since ? [changeId, revision, since] : null);
  return { comparison: value, error, retry };
}

/* ---------- Repository files ---------- */

type FileResult = { status: 'loading' } | ({ status: 'ready' } & RepositoryFile) | { status: 'error'; message: string; httpStatus?: number };

/**
 * Cached file reads. A cached file renders on the same frame; an uncached one reports
 * loading so the screen can retain its previous panel with the matching path and controls.
 * A placeholder, such as the copy in the workspace snapshot, shows while the read revalidates.
 */
export function useRepositoryFile(path: string, ref: string, head: string, placeholder?: string) {
  const { value: hit, error: failed, errorStatus, retry } = useRead(files, [path, ref, head]);
  const result: FileResult =
    hit !== undefined
      ? { ...hit, status: 'ready' }
      : failed
        ? { status: 'error', message: failed, httpStatus: errorStatus ?? undefined }
        : placeholder !== undefined
          ? { status: 'ready', content: placeholder, path, ref }
          : { status: 'loading' };
  return { result, pending: hit === undefined && !failed, retry };
}

/* ---------- Blame ---------- */

/** Who last changed each line of a file on main: the blame, an error with retry, or neither while it loads. */
export function useBlame(path: string, head: string) {
  const { value: blame, error, retry } = useRead(blames, [path, head]);
  // Keep the coarse answer in place. Shared polling pauses off screen, honours the public floor
  // and follows the viewer's own write; a completed answer stops the subscription altogether.
  useLive(blame?.pending ? `blame:${head}:${path}` : null, async () => {
    const startedIn = readGeneration();
    const next = await api.blame(path, head);
    blames.put(blames.key(path, head), next, startedIn, true);
    return next;
  }, 2_000, blame);
  return { blame, error, retry };
}

/* ---------- Directories ---------- */

/**
 * Whether a path is a directory, when something already read says so: the path's own read or a
 * page of its parent's listing. Opening a row from a listing therefore needs no request to know it.
 */
export function knownDirectory(path: string, ref: string): boolean | null {
  const read = files.values.get(files.key(path, ref, ref));
  if (read) return read.kind === 'dir';
  const parent = `${ref}:${path.slice(0, Math.max(0, path.lastIndexOf('/')))}:`;
  for (const [key, page] of trees.values) {
    const entry = key.startsWith(parent) ? page.entries.find((item) => item.path === path) : undefined;
    if (entry) return entry.kind === 'dir';
  }
  return null;
}

/** Complete directory metadata at an immutable commit, paged independently of file content. */
export function useRepositoryTree(path: string, ref: string, enabled = true) {
  const key = `${ref}:${path}`;
  const priorKey = useRef(key);
  const [shown, setShown] = useState<{ key: string; tree: RepositoryTree } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const retry = () => setAttempt(n => n + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
  useEffect(() => {
    if (!enabled || !ref) return;
    let cancelled = false;
    if (priorKey.current !== key) setError(null);
    priorKey.current = key;
    setPending(true);
    trees
      .load(path, ref)
      .then((tree) => {
        if (!cancelled) { setShown({ key, tree }); setError(null); }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, ref, path, key, attempt]);
  const tree = shown?.key === key ? shown.tree : trees.values.get(trees.key(path, ref)) ?? null;
  const more = async () => {
    if (pending || !tree?.nextCursor) return;
    const startedIn = readGeneration();
    setPending(true);
    setError(null);
    try {
      const page = await trees.load(path, ref, tree.nextCursor);
      if (readGeneration() === startedIn) setShown((prior) => (prior?.key === key ? { key, tree: { ...page, entries: [...prior.tree.entries, ...page.entries] } } : prior));
    } catch (err) {
      if (readGeneration() === startedIn) setError(errorMessage(err));
    } finally {
      if (readGeneration() === startedIn) setPending(false);
    }
  };
  useEffect(
    () =>
      onWorkspaceReset(() => {
        setShown(null);
        setError(null);
        setAttempt((n) => n + 1);
      }),
    [],
  );
  return {
    tree,
    error,
    pending,
    more,
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
}
