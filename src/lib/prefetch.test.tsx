import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchHref, prefetchLikelyScreens, warmStart } from './prefetch';
import { primeAccount } from '../account/read';
import { primeAddress } from '../account/addresses';
import { prefetchScreen } from '../screens';
import { api, peekState, primeState, primeWorkspaceScope, setWorkspaceScope } from './api';
import { primeLive } from './live';
import { primeBlame, primeFile, primeHead, primeTree } from './reads';
import type { WorkspaceSnapshot } from '../../shared/types';

vi.mock('../account/read', () => ({ primeAccount: vi.fn() }));
vi.mock('../account/addresses', () => ({ primeAddress: vi.fn(async () => null) }));
vi.mock('../account/session', () => ({ DEMO_SCOPE: 'demo', readAccountsHint: () => true, readSession: () => null }));
vi.mock('../components/code/viewer', () => ({ prefetchCode: vi.fn(), prefetchMarkdown: vi.fn() }));
vi.mock('../screens', () => ({ prefetchLanding: vi.fn(), prefetchScreen: vi.fn() }));
vi.mock('./api', () => ({ api: { branches: vi.fn(), commits: vi.fn(), commit: vi.fn(), compare: vi.fn() }, changes: {}, peekState: vi.fn(), setWorkspaceScope: vi.fn(), primeWorkspaceScope: vi.fn(), primeState: vi.fn(async () => ({ project: { head: 'main' } })) }));
vi.mock('./live', () => ({ primeLive: vi.fn() }));
vi.mock('./reads', () => ({ primeBlame: vi.fn(), primeFile: vi.fn(), primeHead: vi.fn(), primeTree: vi.fn() }));
vi.mock('./router', async () => {
  const address = await import('./address');
  return { ...address, setRouteBase: vi.fn(), isAppPath: (href?: string) => !!href?.startsWith('/') && !href.startsWith('//'), routeOf: (href: string) => address.routeOf(href, 'https://braid.test') };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL('https://braid.test/example/relay') });
  vi.mocked(peekState).mockReturnValue({ project: { head: 'a'.repeat(40), branch: 'main' } } as WorkspaceSnapshot);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('targeted prefetching', () => {
  it('warms only the next Code or Pull requests tab, with no speculative data or settings chunks', async () => {
    prefetchLikelyScreens('code');
    await vi.runAllTimersAsync();
    expect(vi.mocked(prefetchScreen).mock.calls.map(([screen]) => screen)).toEqual(['pulls']);
    expect(primeLive).not.toHaveBeenCalled();
  });

  it('cancels queued work when leaving a page', async () => {
    const cancel = prefetchLikelyScreens('pulls');
    await vi.advanceTimersByTimeAsync(1200);
    cancel();
    await vi.runAllTimersAsync();
    expect(vi.mocked(prefetchScreen).mock.calls).toEqual([['code']]);
  });

  it.each([{ saveData: true }, { effectiveType: 'slow-2g' }, { effectiveType: '2g' }, { effectiveType: '3g' }])('respects connection preferences for idle and intent reads: %j', async (connection) => {
    vi.stubGlobal('navigator', { connection });
    prefetchLikelyScreens('code');
    prefetchHref('/example/relay/pull/23');
    await vi.runAllTimersAsync();
    expect(prefetchScreen).not.toHaveBeenCalled();
    expect(primeLive).not.toHaveBeenCalled();
    // The current page still opens immediately, even with data saving enabled.
    warmStart();
    expect(primeAccount).toHaveBeenCalledOnce();
    expect(prefetchScreen).toHaveBeenCalledWith('code');
  });

  it('stops queued prefetches when the connection starts saving data', async () => {
    prefetchLikelyScreens('code');
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    await vi.runAllTimersAsync();
    expect(prefetchScreen).not.toHaveBeenCalled();
  });

  it('primes an addressed repository the moment the server names its scope, and nothing for one it does not know', async () => {
    const address = { workspaceId: 'ws-9', owner: { slug: 'acme', name: 'Acme' }, repo: { slug: 'relay', name: 'Relay' }, visibility: 'public' as const, canWrite: false };
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL('https://braid.test/acme/relay/blame/main/src/a.ts') });
    vi.mocked(primeAddress).mockResolvedValueOnce(address);
    warmStart();
    expect(setWorkspaceScope).toHaveBeenCalledWith(null);
    expect(primeState).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    expect(primeWorkspaceScope).toHaveBeenCalledWith('ws-9');
    expect(primeHead).toHaveBeenCalledWith({ trees: [''], file: 'src/a.ts', blame: 'src/a.ts' });
    expect(primeLive).toHaveBeenCalledWith('changes:list:latest', expect.any(Function), expect.any(Function));
    expect(primeState).toHaveBeenCalledOnce();
    await Promise.resolve(); await Promise.resolve();
    expect(primeFile).toHaveBeenCalledWith('src/a.ts', 'main');
    expect(primeBlame).toHaveBeenCalledWith('src/a.ts', 'main');
    vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL('https://braid.test/acme/gone') });
    warmStart();
    await Promise.resolve(); await Promise.resolve();
    expect(primeWorkspaceScope).not.toHaveBeenCalled();
    expect(primeHead).not.toHaveBeenCalled();
    expect(primeState).not.toHaveBeenCalled();
  });

  it('reads the home, a directory or a file at a named commit as the example opens', async () => {
    warmStart();
    expect(primeHead).toHaveBeenCalledWith();
    vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL('https://braid.test/example/relay/tree/main/src') });
    warmStart();
    expect(primeHead).toHaveBeenCalledWith({ trees: ['', 'src'] });
    vi.clearAllMocks();
    const commit = 'f'.repeat(40);
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL(`https://braid.test/example/relay/blob/${commit}/src/a.ts`) });
    warmStart();
    expect(primeHead).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    expect(primeFile).toHaveBeenCalledWith('src/a.ts', commit);
  });

  it('warms an intended link without reading another repository in this workspace scope', () => {
    prefetchHref('/example/relay/pull/23');
    expect(prefetchScreen).toHaveBeenLastCalledWith('pull');
    expect(primeLive).toHaveBeenCalledWith('changes:item:23', expect.any(Function), expect.any(Function));
    vi.mocked(primeLive).mockClear();
    vi.stubGlobal('window', { location: new URL('https://braid.test/acme/relay-next') });
    prefetchHref('/acme/relay/pull/23');
    expect(prefetchScreen).toHaveBeenLastCalledWith('pull');
    expect(primeLive).not.toHaveBeenCalled();
  });

  it('starts a file and its parent directories on intent, without reading another snapshot', () => {
    prefetchHref('/example/relay/blob/main/src/billing/ledger.ts');
    expect(primeFile).toHaveBeenCalledWith('src/billing/ledger.ts', 'a'.repeat(40));
    expect(vi.mocked(primeTree).mock.calls).toEqual([['', 'a'.repeat(40)], ['src', 'a'.repeat(40)], ['src/billing', 'a'.repeat(40)]]);
    expect(primeState).not.toHaveBeenCalled();
  });

  it('pins a non-default branch or commit and warms blame only when requested', () => {
    const hash = 'b'.repeat(40);
    prefetchHref(`/example/relay/blame/${hash}/src/a.ts`);
    expect(primeFile).toHaveBeenCalledWith('src/a.ts', hash);
    expect(primeBlame).toHaveBeenCalledWith('src/a.ts', hash);
    prefetchHref('/example/relay/tree/release%2Fnext/src');
    expect(primeTree).toHaveBeenCalledWith('src', 'release/next');
    expect(primeFile).toHaveBeenCalledTimes(1);
  });

  it('does not start repository content reads before a snapshot or across repositories', () => {
    prefetchHref('/acme/other/blob/main/src/a.ts');
    vi.mocked(peekState).mockReturnValue(undefined);
    prefetchHref('/example/relay/blob/main/src/a.ts');
    expect(primeTree).not.toHaveBeenCalled();
    expect(primeFile).not.toHaveBeenCalled();
    expect(primeState).not.toHaveBeenCalled();
  });

  it.each([
    ['/example/relay/branches', 'repository:branches', 'branches', []],
    ['/example/relay/commits/main/src/a.ts?cursor=older&cursor=oldest', 'commits:["main","src/a.ts","oldest"]', 'commits', ['main', 'src/a.ts', 'oldest']],
    ['/example/relay/commit/abcdef1', 'commit:abcdef1', 'commit', ['abcdef1']],
    ['/example/relay/compare/main...release%2Fnext', 'repository:compare:["main","release/next"]', 'compare', ['main', 'release/next']],
  ] as const)('starts the destination read for %s using its screen cache key', async (href, key, method, args) => {
    prefetchHref(href);
    const call = vi.mocked(primeLive).mock.calls.find(([name]) => name === key);
    expect(call).toBeDefined();
    await call![1]();
    expect(api[method]).toHaveBeenCalledWith(...args);
    expect(primeState).not.toHaveBeenCalled();
  });
});
