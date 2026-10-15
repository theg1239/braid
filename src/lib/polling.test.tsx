import { afterEach, describe, expect, it, vi } from 'vitest';
import { followOwnWrite, onFollow, pollInterval, setPublicPolling } from './polling';
import { resetWorkspaceCaches } from './api';

const subscriptions = vi.hoisted(() => [] as (() => void)[]);
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useEffect: (effect: () => unknown) => effect(),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => { subscriptions.push(subscribe(() => {})); return snapshot(); },
}));

afterEach(() => { subscriptions.splice(0).forEach(unsubscribe => unsubscribe()); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('public background polling', () => {
  it('skips attention and clamps active, idle and retry polls to thirty seconds while members keep their intervals', async () => {
    vi.useFakeTimers();
    const events = new Map<string, () => void>();
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (name: string, listener: () => void) => events.set(name, listener) });
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: (name: string, listener: () => void) => events.set(name, listener) });
    const { useLive, primeLive } = await import('./live');
    setPublicPolling(true);
    const attention = vi.fn(async () => ({})), active = vi.fn(async () => ({})), failing = vi.fn(async () => { throw new Error('Preparing'); });
    useLive('changes:list:attention', attention, 15000);
    primeLive('changes:list:attention', attention, 15000);
    useLive('public-active', active, 2000);
    useLive('public-retry', failing, 2000);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i++) { events.get('focus')!(); events.get('visibilitychange')!(); await vi.advanceTimersByTimeAsync(0); }
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29998);
    expect(attention).not.toHaveBeenCalled(); expect(active).toHaveBeenCalledTimes(1); expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(active).toHaveBeenCalledTimes(2); expect(failing).toHaveBeenCalledTimes(2);
    expect(pollInterval(8000)).toBe(30000); expect(pollInterval(60000)).toBe(60000);
    setPublicPolling(false);
    const member = vi.fn(async () => ({}));
    useLive('member-active', member, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(member).toHaveBeenCalledTimes(2); expect(pollInterval(8000)).toBe(8000);
    useLive('changes:list:attention', attention, 15000);
    await vi.advanceTimersByTimeAsync(0);
    expect(attention).toHaveBeenCalledTimes(1);
    const reconnecting = vi.fn(async () => ({ at: Date.now() }));
    useLive('reconnect', reconnecting, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.stubGlobal('navigator', { onLine: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconnecting).toHaveBeenCalledTimes(1);
    vi.stubGlobal('navigator', { onLine: true });
    events.get('online')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnecting).toHaveBeenCalledTimes(2);
    expect(attention).toHaveBeenCalledTimes(2);
    // A different repository can be public even while this person remains signed in.
    resetWorkspaceCaches();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollInterval(2000)).toBe(30000);
    expect(attention).toHaveBeenCalledTimes(2);
  });
  it('follows a visitor\'s own write closely for a minute, then keeps the thirty-second floor again', () => {
    vi.useFakeTimers();
    setPublicPolling(true);
    const follow = vi.fn();
    const stop = onFollow(follow);
    expect(pollInterval(2000)).toBe(30000);
    followOwnWrite();
    expect(follow).toHaveBeenCalledTimes(1);
    expect(pollInterval(2000)).toBe(2000);
    vi.advanceTimersByTime(60_000);
    expect(pollInterval(2000)).toBe(30000);
    stop();
    followOwnWrite();
    expect(follow).toHaveBeenCalledTimes(1);
  });
});
