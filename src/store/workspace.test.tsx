import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshot } from '../../shared/types';
import type { WorkspaceValue } from './workspace';

/*
 * The hooks WorkspaceProvider calls, with React's rules: state that is set to the same value renders
 * nothing, setters in one task render once, and an effect runs after a render whose dependencies changed.
 */
const react = vi.hoisted(() => {
  const slots: unknown[] = [];
  let slot = 0;
  let component: (() => unknown) | null = null;
  let scheduled = false;
  const pending: (() => void)[] = [];
  const state = { renders: 0, output: null as unknown };
  const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const render = () => {
    scheduled = false;
    slot = 0;
    state.renders++;
    state.output = component?.();
    for (const effect of pending.splice(0)) effect();
  };
  const rerender = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  };
  const memo = <T,>(create: () => T, deps: unknown[]): T => {
    const index = slot++;
    const prior = slots[index] as { value: T; deps: unknown[] } | undefined;
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = create();
    slots[index] = { value, deps };
    return value;
  };
  return {
    state,
    mount(next: () => unknown) {
      component = next;
      render();
    },
    unmount() {
      component = null;
      for (const cell of slots as { cleanup?: () => void }[]) cell?.cleanup?.();
      slots.length = 0;
      pending.length = 0;
    },
    useState<T>(initial: T | (() => T)) {
      const index = slot++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      const cell = slots[index] as { value: T; set?: (next: T | ((prior: T) => T)) => void };
      cell.set ??= (next) => {
        const value = typeof next === 'function' ? (next as (prior: T) => T)(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        rerender();
      };
      return [cell.value, cell.set] as const;
    },
    useRef<T>(initial: T) {
      return memo(() => ({ current: initial }), []);
    },
    useCallback: <T,>(callback: T, deps: unknown[]) => memo(() => callback, deps),
    useMemo: memo,
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = slot++;
      const prior = slots[index] as { deps: unknown[]; cleanup?: void | (() => void) } | undefined;
      if (prior && same(prior.deps, deps)) return;
      const cell: { deps: unknown[]; cleanup?: void | (() => void) } = { deps };
      slots[index] = cell;
      pending.push(() => {
        if (typeof prior?.cleanup === 'function') prior.cleanup();
        cell.cleanup = effect();
      });
    },
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => null,
  };
});
vi.mock('react', () => react);
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: () => {} }) }));
vi.mock('../lib/router', () => ({ setRouteRef: () => {} }));
const reads = vi.hoisted(() => ({ state: [] as (() => Promise<unknown>)[] }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api: { state: () => reads.state.shift()!() } }));

afterEach(() => { react.unmount(); reads.state.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('workspace store', () => {
  it.each(['snapshot', 'failure'])('never reverses an applied choice when a pre-write %s arrives late', async (answer) => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });
    const { WorkspaceProvider } = await import('./workspace');
    const { missionFixture } = await import('../test/fixtures');
    const mission = missionFixture({ id: 'choice', collisions: [{ id: 'file', path: 'src/limits.ts', agentIds: ['a', 'b'] }] });
    const snapshot = { capabilities: {}, project: { branch: 'main' }, missions: [mission] } as WorkspaceSnapshot;
    const chosen = { ...mission, collisions: [{ ...mission.collisions[0], resolution: { agentId: 'a', reason: 'Keep deliveries', resolvedAt: new Date().toISOString() } }] };
    const value = () => (react.state.output as { props: { value: WorkspaceValue } }).props.value;
    reads.state.push(async () => snapshot);
    react.mount(() => WorkspaceProvider({ children: null }));
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (next: WorkspaceSnapshot) => void, reject!: (reason: Error) => void;
    reads.state.push(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const stale = value().refresh();
    value().applyMission(chosen);
    await vi.advanceTimersByTimeAsync(0);
    expect(value().snapshot?.missions[0]).toEqual(chosen);

    // Refresh after POST must start a new read, rather than join the pre-write poll.
    const current = { ...snapshot, missions: [chosen] };
    reads.state.push(async () => current);
    const fresh = value().refresh();
    expect(fresh).not.toBe(stale);
    await fresh;
    if (answer === 'snapshot') resolve(snapshot); else reject(new Error('Old request failed'));
    await stale;
    await vi.advanceTimersByTimeAsync(0);
    expect(value()).toMatchObject({ snapshot: current, error: null, refreshing: false });

    // A later authoritative read is still allowed to change the choice.
    reads.state.push(async () => snapshot);
    await value().refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(value().snapshot).toBe(snapshot);
  });

  it('renders nothing for a poll that changes nothing, and still says when updates stopped', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const events = new Map<string, () => void>();
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: (name: string, listener: () => void) => events.set(name, listener), removeEventListener: () => {} });
    const { WorkspaceProvider, readOnlyReason } = await import('./workspace');
    const { setPublicPolling } = await import('../lib/polling');
    const snapshot = { capabilities: { identity: { id: 'u1' } }, project: { branch: 'main' }, missions: [] } as unknown as WorkspaceSnapshot;
    const value = () => (react.state.output as { props: { value: WorkspaceValue } }).props.value;
    reads.state.push(async () => snapshot);
    react.mount(() => WorkspaceProvider({ children: null }));
    await vi.advanceTimersByTimeAsync(0);
    setPublicPolling(false);
    expect(value()).toMatchObject({ snapshot, loading: false, error: null, refreshing: false });
    const settled = react.state.renders;

    // The next poll answers with the same snapshot, as a 304 does.
    reads.state.push(async () => snapshot);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reads.state).toHaveLength(0);
    expect(react.state.renders).toBe(settled);

    // A failed poll shows when the last read succeeded, and a retry shows its progress.
    const lastSuccess = Date.now();
    reads.state.push(async () => { throw new Error('offline'); });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(value()).toMatchObject({ error: 'offline', lastUpdated: lastSuccess, refreshing: false });
    let answer!: (next: WorkspaceSnapshot) => void;
    reads.state.push(() => new Promise((resolve) => { answer = resolve; }));
    const retried = value().refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(value().refreshing).toBe(true);
    answer(snapshot);
    await retried;
    await vi.advanceTimersByTimeAsync(0);
    expect(value()).toMatchObject({ error: null, refreshing: false, snapshot });
    // Background reads pause offline; coming back reads immediately, without a reload.
    vi.stubGlobal('navigator', { onLine: false });
    const next = { ...snapshot, capabilities: { ...snapshot.capabilities, mode: 'demo' as const, canWrite: true } };
    reads.state.push(async () => next);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reads.state).toHaveLength(1);
    vi.stubGlobal('navigator', { onLine: true });
    events.get('online')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(value().snapshot).toBe(next);
    events.get('braid:example-readonly')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(value().snapshot?.capabilities.canWrite).toBe(false);
    expect(readOnlyReason(value().snapshot)).toBe("This network has used today's example sessions. You can still read everything.");
  });

  it('follows an import every two seconds for a visitor, then keeps the public floor once the copy lands', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });
    const { WorkspaceProvider } = await import('./workspace');
    const { setPublicPolling } = await import('../lib/polling');
    setPublicPolling(true);
    const importing = { capabilities: {}, project: { branch: 'main' }, missions: [], importing: { name: 'oss-scanner', source: 'https://github.com/anthropics/oss-scanner', startedAt: new Date().toISOString() } } as unknown as WorkspaceSnapshot;
    const landed = { capabilities: {}, project: { id: 'repo', branch: 'main', head: 'a'.repeat(40) }, missions: [] } as unknown as WorkspaceSnapshot;
    const value = () => (react.state.output as { props: { value: WorkspaceValue } }).props.value;
    reads.state.push(async () => importing);
    react.mount(() => WorkspaceProvider({ children: null }));
    await vi.advanceTimersByTimeAsync(0);
    reads.state.push(async () => importing, async () => landed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads.state).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value().snapshot).toBe(landed);
    reads.state.push(async () => landed);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reads.state).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(reads.state).toHaveLength(0);
  });
});
