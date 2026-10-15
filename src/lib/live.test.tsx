import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The hooks useLive calls, with React's rules for when they run again: a callback, memo or effect
 * keeps its value while its dependencies are the same, a store is subscribed to again only when it
 * is given a different subscribe function, and a store's change renders the component again.
 */
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let slot = 0;
  let current: (() => unknown) | null = null;
  const render = () => {
    slot = 0;
    current?.();
  };
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = <T,>(create: () => T, deps: unknown[]): T => {
    const index = slot++;
    const prior = slots[index] as { value: T; deps: unknown[] } | undefined;
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = create();
    slots[index] = { value, deps };
    return value;
  };
  return {
    mount(hook: () => unknown) {
      current = hook;
      render();
    },
    render,
    useCallback: <T,>(callback: T, deps: unknown[]) => memo(() => callback, deps),
    useMemo: memo,
    useEffect: (effect: () => void, deps: unknown[]) => memo(() => effect(), deps),
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, read: () => unknown) => {
      const index = slot++;
      const prior = slots[index] as { subscribe: unknown; unsubscribe: () => void } | undefined;
      if (prior?.subscribe !== subscribe) {
        prior?.unsubscribe();
        slots[index] = { subscribe, unsubscribe: subscribe(() => queueMicrotask(render)) };
      }
      return read();
    },
  };
});
vi.mock('react', () => ({ useCallback: hooks.useCallback, useMemo: hooks.useMemo, useEffect: hooks.useEffect, useSyncExternalStore: hooks.useSyncExternalStore }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useLive', () => {
  it('keeps polling a resource whose only reader renders more often than it polls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => {} });
    const { setPublicPolling } = await import('./polling');
    const { useLive } = await import('./live');
    setPublicPolling(false);
    const read = vi.fn(async () => ({ at: Date.now() }));
    hooks.mount(() => useLive('slow', read, 60_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    // A clock on the page renders it every fifteen seconds; the minute between reads still passes.
    for (let second = 15; second <= 60; second += 15) {
      await vi.advanceTimersByTimeAsync(15_000);
      hooks.render();
    }
    expect(read).toHaveBeenCalledTimes(2);
  });
});
