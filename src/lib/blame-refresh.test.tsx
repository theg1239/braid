import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileBlame } from '../../shared/types';

// The same subscription/effect lifecycle as React, including cleanup when the pending key disappears.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void; subscribe?: unknown };
  const slots: Slot[] = [];
  let slot = 0, current: (() => void) | null = null;
  const render = () => { slot = 0; current?.(); };
  const memo = <T,>(create: () => T, deps: unknown[]): T => {
    const index = slot++, prior = slots[index];
    if (prior?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, prior.deps![i]))) return prior.value as T;
    prior?.cleanup?.();
    const value = create(); slots[index] = { value, deps }; return value;
  };
  return {
    mount(hook: () => void) { current = hook; render(); },
    unmount() { current = null; for (const item of slots) item?.cleanup?.(); slots.length = 0; },
    useCallback: <T,>(callback: T, deps: unknown[]) => memo(() => callback, deps),
    useMemo: memo,
    useRef: <T,>(value: T) => memo(() => ({ current: value }), []),
    useState: <T,>(initial: T) => {
      const index = slot++;
      const entry = slots[index] ??= { value: initial };
      return [entry.value, (value: T | ((old: T) => T)) => { entry.value = typeof value === 'function' ? (value as (old: T) => T)(entry.value as T) : value; queueMicrotask(render); }];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = slot;
      memo(() => effect(), deps);
      slots[index].cleanup = slots[index].value as (() => void) | undefined;
    },
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, read: () => unknown) => {
      const index = slot++, prior = slots[index];
      if (prior?.subscribe !== subscribe) { prior?.cleanup?.(); slots[index] = { subscribe, cleanup: subscribe(() => queueMicrotask(render)) }; }
      return read();
    },
  };
});
vi.mock('react', () => hooks);

const head = 'a'.repeat(40), path = 'README.md';
const coarse: FileBlame = { path, ref: head, lines: 3, ranges: [{ start: 1, lines: 3, provenance: { commit: head, kind: 'human', confidence: 'inferred', at: '2026-10-01', subject: 'Import' } }], pending: true };
const final: FileBlame = { ...coarse, pending: undefined, ranges: [coarse.ranges[0], { ...coarse.ranges[0], start: 2, lines: 1 }] };
const events = new Map<string, () => void>();
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); events.clear();
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => events.set(name, fn) });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: (name: string, fn: () => void) => events.set(name, fn), removeEventListener: () => {} });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { hooks.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function mount(publicViewer = true) {
  const { api, resetWorkspaceCaches } = await import('./api');
  const { blames, readGeneration } = await import('./reads');
  const { setPublicPolling, followOwnWrite } = await import('./polling');
  const { useBlame } = await import('./resources');
  setPublicPolling(publicViewer);
  blames.put(blames.key(path, head), coarse, readGeneration());
  const read = vi.spyOn(api, 'blame').mockResolvedValue(final);
  let shown: ReturnType<typeof useBlame>;
  hooks.mount(() => { shown = useBlame(path, head); });
  return { read, blames, resetWorkspaceCaches, followOwnWrite, shown: () => shown! };
}

describe('open blame refresh', () => {
  it('replaces a coarse public answer at the thirty-second floor, then stops without a reload', async () => {
    const f = await mount();
    expect(f.shown().blame).toBe(coarse);
    for (let i = 0; i < 3; i++) { events.get('focus')?.(); events.get('visibilitychange')?.(); }
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.shown().blame).toBe(final);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(path, head);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each(['member', 'own write'])('follows %s results within two seconds and stops at a terminal coarse note', async kind => {
    const f = await mount(kind !== 'member');
    const limited = { ...final, note: 'This repository was imported without its earlier history.' };
    f.read.mockResolvedValue(limited);
    if (kind === 'own write') f.followOwnWrite();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.shown().blame).toBe(limited);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it('pauses while hidden and keeps the coarse lines through a failed poll', async () => {
    const f = await mount();
    Object.assign(document, { visibilityState: 'hidden' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read).not.toHaveBeenCalled();
    f.read.mockRejectedValueOnce(new Error('temporarily offline'));
    Object.assign(document, { visibilityState: 'visible' }); events.get('visibilitychange')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.shown().blame).toBe(coarse); expect(f.shown().error).toBeNull();
    events.get('focus')?.();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.shown().blame).toBe(final);
  });

  it('restores the public floor after the follow-own-write minute when history is still pending', async () => {
    const f = await mount();
    f.read.mockResolvedValue(coarse); f.followOwnWrite();
    await vi.advanceTimersByTimeAsync(60_000);
    const calls = f.read.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.read).toHaveBeenCalledTimes(calls);
    f.read.mockResolvedValue(final);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.shown().blame).toBe(final);
    expect(f.read).toHaveBeenCalledTimes(calls + 1);
  });

  it('stops when the page closes and drops late results across a workspace change', async () => {
    const f = await mount(false);
    let finish!: (value: FileBlame) => void;
    f.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(2_000);
    hooks.unmount(); f.resetWorkspaceCaches(); finish(final);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.blames.values.size).toBe(0);
  });
});
