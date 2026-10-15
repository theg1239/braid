import type { RepositoryFile, RepositoryTree } from '../../shared/repository';
import type { FileBlame } from '../../shared/types';
import { api, ApiError, onWorkspaceReset } from './api';

/*
 * Answers that never change once read, each named by what it was read at: a file or a page of a
 * directory at a commit, a file's blame at main's head, a revision's diff. Each is read once, callers
 * at the same moment share the request, and it is kept until the repository or the person changes.
 * The warm start fills these before any screen mounts; the hooks that show them are in resources.ts.
 */

const listeners = new Set<() => void>();
const stores = new Set<Map<string, unknown>>();
let generation = 0;

/** Calls `listener` whenever any answer arrives; a reader compares its own answer and renders again only when that changed. */
export function subscribeReads(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Counts workspace resets, so an answer that arrives after one is dropped. */
export const readGeneration = () => generation;

export interface Reader<A extends unknown[], T> {
  key: (...args: A) => string;
  values: ReadonlyMap<string, T>;
  /** Reads once per key; concurrent callers share the request. */
  load: (...args: A) => Promise<T>;
  /** Starts a read ahead of the screen that shows it. That screen's own read shares it and shows a failure. */
  prime: (...args: A) => void;
  /** Keeps an answer unless the workspace changed; `replace` upgrades a pending answer already at this key. */
  put: (key: string, value: T, startedIn: number, replace?: boolean) => void;
}

export function reader<A extends unknown[], T>(key: (...args: A) => string, read: (...args: A) => Promise<T>): Reader<A, T> {
  const values = new Map<string, T>();
  const loads = new Map<string, Promise<T>>();
  stores.add(values).add(loads);
  const put = (name: string, value: T, startedIn: number, replace = false) => {
    if (startedIn !== generation || (!replace && values.has(name))) return;
    values.set(name, value);
    for (const listener of listeners) listener();
  };
  const load = (...args: A): Promise<T> => {
    const name = key(...args);
    const hit = values.get(name);
    if (hit !== undefined) return Promise.resolve(hit);
    const inFlight = loads.get(name);
    if (inFlight) return inFlight;
    const startedIn = generation;
    const promise = read(...args)
      .then((value) => {
        put(name, value, startedIn);
        return value;
      })
      .finally(() => {
        if (loads.get(name) === promise) loads.delete(name);
      });
    loads.set(name, promise);
    return promise;
  };
  return { key, values, put, load, prime: (...args) => void load(...args).catch(() => undefined) };
}

/** What a code route shows, asked for at the default branch's head before the snapshot named it: listings by path, a file and its blame. */
type Early = { trees: Map<string, Promise<RepositoryTree>>; file?: { path: string; promise: Promise<RepositoryFile> }; blame?: { path: string; promise: Promise<FileBlame> } };
let early: Early | null = null;

// Another repository or another person: nothing read for the previous one may show.
onWorkspaceReset(() => {
  generation++;
  early = null;
  for (const store of stores) store.clear();
});

/** A read the warm start already began answers a read at the commit it read; anything else is read now. */
const reuse = <T extends { ref: string }>(started: Promise<T> | undefined, ref: string, read: () => Promise<T>) => {
  if (!started || !/^[0-9a-f]{40}$/.test(ref)) return read();
  const startedIn = generation;
  return started.then((value) => (value.ref === ref ? value : read()), (error: unknown) => {
    // A failed default-branch lookup says nothing about the commit the snapshot already named.
    // Read that exact commit once, through the same API authorization, without retrying denied or throttled reads.
    if (startedIn === generation && error instanceof ApiError && error.status === 404) return read();
    throw error;
  });
};

export const files = reader(
  (path: string, ref: string, head: string) => `${head}:${ref}:${path}`,
  (path, ref, head) => reuse(path === early?.file?.path && ref === head ? early.file.promise : undefined, head, () => api.readFile(path, head || ref)),
);
export const trees = reader(
  (path: string, ref: string, cursor?: string) => `${ref}:${path}:${cursor ?? ''}`,
  (path: string, ref: string, cursor?: string) => reuse(cursor ? undefined : early?.trees.get(path), ref, () => api.readTree(path, ref, cursor)),
);
/** Main's head names the version; pending attribution can be replaced as its history arrives. */
export const blames = reader(
  (path: string, head: string) => `${head}:${path}`,
  (path, head) => reuse(path === early?.blame?.path ? early.blame.promise : undefined, head, () => api.blame(path, head)),
);

/** Starts reading a file before the screen that shows it mounts. */
export const primeFile = (path: string, head: string) => files.prime(path, head, head);

/** Starts reading a directory before the screen that lists it mounts. */
export const primeTree = (path: string, ref: string) => trees.prime(path, ref);

/** Starts reading a file's blame before the view that shows it opens. */
export const primeBlame = (path: string, head: string) => blames.prime(path, head);

/**
 * What a code route shows, asked for alongside the snapshot rather than after it: the server reads the default
 * branch's head when no commit is named, and each answer carries the commit it read, so it is cached under that
 * commit and the screen finds it once the snapshot names the same head. A screen that asks while these are still
 * on their way waits for them instead of asking again. The home reads its README after the tree names it; a path reads
 * the root for the file tree beside it, then its own listing, or its file and, on Blame, who last changed each line.
 * Where `public/boot.js` started the same reads, the API layer takes those over instead of asking again.
 */
export function primeHead(reads: { trees: string[]; file?: string; blame?: string } = { trees: [''] }) {
  const startedIn = generation;
  const listings = new Map(reads.trees.map((path) => [path, api.readTree(path, '')]));
  const file = reads.file === undefined ? undefined : { path: reads.file, promise: api.readFile(reads.file, '') };
  const blame = reads.blame === undefined ? undefined : { path: reads.blame, promise: api.blame(reads.blame, '') };
  early = { trees: listings, ...(file ? { file } : {}), ...(blame ? { blame } : {}) };
  // A failed early read is forgotten, so the screen asks again and shows the failure.
  for (const [path, promise] of listings) promise.then((page) => {
    trees.put(trees.key(path, page.ref), page, startedIn);
    if (startedIn !== generation || path || reads.file !== undefined || reads.trees.length !== 1) return;
    const readme = page.entries.find(entry => entry.kind === 'file' && /^readme(\.(md|markdown|txt))?$/i.test(entry.name));
    if (readme) primeFile(readme.path, page.ref);
  }).catch(() => { if (early?.trees.get(path) === promise) early.trees.delete(path); });
  file?.promise.then((read) => files.put(files.key(file.path, read.ref, read.ref), read, startedIn)).catch(() => { if (early?.file === file) delete early.file; });
  blame?.promise.then((read) => blames.put(blames.key(blame.path, read.ref), read, startedIn)).catch(() => { if (early?.blame === blame) delete early.blame; });
}

