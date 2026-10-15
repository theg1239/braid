import { afterEach, expect, it, vi } from 'vitest';
import { api, changes, earlyAccount, peekState, primeState, primeWorkspaceScope, readAccount, request, resetWorkspaceCaches, setWorkspaceScope } from './api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWorkspaceScope(null);
});

it.each(['headers', 'body'])('bounds account %s and aborts the request at four seconds', async (stalled) => {
  vi.useFakeTimers();
  const fetch = vi.fn((_path: string, _init?: RequestInit) => stalled === 'headers'
    ? new Promise<Response>(() => {})
    : Promise.resolve({ ok: true, text: () => new Promise<string>(() => {}) } as Response));
  vi.stubGlobal('fetch', fetch);
  const result = expect(readAccount()).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(4000);
  await result;
  expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
});

it('bounds takeover of an early account started by an older boot script', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { __braidEarly: { account: new Promise<Response>(() => {}) } });
  const result = expect(earlyAccount()).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(4000);
  await result;
  expect(earlyAccount()).toBeNull();
});

it('clears a successful account deadline and leaves later attempts able to retry', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ user: null }));
  vi.stubGlobal('fetch', fetch);
  await expect(readAccount()).resolves.toEqual({ user: null });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(4000);
  expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
});

it('keeps comments and review writes scoped and keyed, including escaped conversation ids', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ id: 'change/1' }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('ws-comments');
  const comment = { body: 'Handle the empty case.', revision: 2, path: 'src/index.ts', line: 3, side: 'RIGHT' as const, inReplyTo: 'thread/1' };
  await changes.comment('change/1', comment, 'comment-key');
  await changes.resolveConversation('change/1', 'thread/1', true, 'resolve-key');
  await changes.approve('change/1', 2, 'Looks good.', 'approve-key');
  await changes.sendBack('change/1', 2, 'Add a check.', 'review-key');
  expect(fetch.mock.calls.map(([path, init]) => ({ path, body: JSON.parse(init!.body as string), key: new Headers(init!.headers).get('idempotency-key') }))).toEqual([
    { path: '/api/changes/change%2F1/comments', body: comment, key: 'comment-key' },
    { path: '/api/changes/change%2F1/comments/thread%2F1/resolve', body: { resolved: true }, key: 'resolve-key' },
    { path: '/api/changes/change%2F1/approve', body: { revision: 2, body: 'Looks good.' }, key: 'approve-key' },
    { path: '/api/changes/change%2F1/reviews', body: { verdict: 'revise', revision: 2, summary: 'Add a check.' }, key: 'review-key' },
  ]);
  for (const [, init] of fetch.mock.calls) {
    expect(init!.method).toBe('POST');
    expect(new Headers(init!.headers).get('x-braid-workspace')).toBe('ws-comments');
  }
});

it('reads local agent activity in the selected repository, for one pull request or all', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('ws-lecrev');
  await api.localActivity();
  await api.localActivity('ch_0123456789abc');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/local-activity', '/api/local-activity?changeId=ch_0123456789abc']);
  for (const [, init] of fetch.mock.calls) expect(new Headers(init!.headers).get('x-braid-workspace')).toBe('ws-lecrev');
});

it('reads directory commits in the selected repository, including after a workspace switch', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ entries: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetch);
  const ref = 'b'.repeat(40);
  setWorkspaceScope('ws-tree-A');
  await api.treeCommits(ref, '');
  setWorkspaceScope('ws-tree-B');
  await api.treeCommits(ref, 'dir with space/nested', '200');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    `/api/repository/tree/commits?ref=${ref}&path=`,
    `/api/repository/tree/commits?ref=${ref}&path=dir%20with%20space%2Fnested&cursor=200`,
  ]);
  expect(fetch.mock.calls.map(([, init]) => new Headers(init!.headers).get('x-braid-workspace'))).toEqual(['ws-tree-A', 'ws-tree-B']);
});

it('restarts a stopped import with the JSON body and request key the server requires', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ importing: { name: 'r', source: 'o/r', startedAt: '2026-10-12T00:00:00Z' } }, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('ws-1');
  await api.retryImport('k'.repeat(24));
  const [path, init] = fetch.mock.calls[0];
  const headers = new Headers(init!.headers);
  expect(path).toBe('/api/project/import/retry');
  expect(init).toMatchObject({ method: 'POST', body: '{}' });
  expect(headers.get('content-type')).toBe('application/json');
  expect(headers.get('idempotency-key')).toBe('k'.repeat(24));
  expect(headers.get('x-braid-workspace')).toBe('ws-1');
});

it('takes over the reads boot.js started for its scope and path, once each, and reads its own after that', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ project: { id: 'read' }, ref: 'read' }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { __braidEarly: { reads: {
    'demo /api/state': Promise.resolve(Response.json({ project: { id: 'early' } })),
    'demo /api/repository/tree?ref=&path=': Promise.resolve(Response.json({ ref: 'early', path: '', entries: [], nextCursor: null })),
    ' /api/repos/acme/relay': Promise.resolve(Response.json({ workspaceId: 'ws-2' })),
  } } });
  setWorkspaceScope('ws-1');
  expect((await api.state()).project.id).toBe('read');
  setWorkspaceScope('demo');
  expect((await api.state()).project.id).toBe('early');
  expect((await api.readTree('', '')).ref).toBe('early');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await api.state()).project.id).toBe('read');
  expect((await api.readTree('', '')).ref).toBe('read');
  // A read without a scope, as the address lookup is, and a write never take anything over.
  setWorkspaceScope(null);
  expect(await request<{ workspaceId: string }>('/api/repos/acme/relay')).toEqual({ workspaceId: 'ws-2' });
  await request('/api/repos/acme/relay', { method: 'POST', body: '{}' });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(window.__braidEarly!.reads).toEqual({});
});

it('shares a scope\'s first snapshot read between the warm start and the workspace, whichever asks first, and polls anew after it', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ project: { id: 'read' } }, { headers: { etag: '"1"' } }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('ws-1');
  const workspace = api.state(), primed = primeState();
  expect(await primed).toBe(await workspace);
  expect(fetch).toHaveBeenCalledTimes(1);
  await api.state();
  expect(fetch).toHaveBeenCalledTimes(2);
  // The warm start first, then the workspace even after the answer arrived; another repository forgets it.
  setWorkspaceScope('ws-2');
  const early = await primeState();
  expect(await api.state()).toBe(early);
  expect(fetch).toHaveBeenCalledTimes(3);
  await api.state();
  expect(fetch).toHaveBeenCalledTimes(4);
  primeState();
  setWorkspaceScope('ws-3');
  await api.state();
  expect(new Headers(fetch.mock.calls.at(-1)![1]!.headers).get('x-braid-workspace')).toBe('ws-3');
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('fails a read boot.js started that never reached the workspace as its own read would', async () => {
  vi.stubGlobal('window', { __braidEarly: { reads: { 'demo /api/state': Promise.reject(new TypeError('offline')) } } });
  setWorkspaceScope('demo');
  await expect(api.state()).rejects.toMatchObject({ status: 0 });
});

it('primes a scope only while none is known, leaving the account layer to confirm it', async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({}));
  vi.stubGlobal('fetch', fetch);
  primeWorkspaceScope('ws-first');
  primeWorkspaceScope('ws-second');
  await api.readTree('', '');
  expect(new Headers(fetch.mock.calls[0][1]!.headers).get('x-braid-workspace')).toBe('ws-first');
});

it('answers the account read boot.js started as a request would, errors included', async () => {
  vi.stubGlobal('window', { __braidEarly: { account: Promise.resolve(Response.json({ error: 'Sign in again.' }, { status: 401 })) } });
  await expect(earlyAccount()).rejects.toMatchObject({ status: 401, message: 'Sign in again.' });
  expect(earlyAccount()).toBeNull();
});

it('lets intent reads use only the current session snapshot without making another request', async () => {
  const value = { project: { id: 'prefetch', head: 'a'.repeat(40) } };
  const fetch = vi.fn(async () => Response.json(value, { headers: { etag: 'snapshot-a' } }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('ws-prefetch', 'owner');
  expect(peekState()).toBeUndefined();
  await api.state();
  expect(peekState()).toEqual(value);
  expect(fetch).toHaveBeenCalledOnce();
  setWorkspaceScope('ws-prefetch', 'another-viewer');
  expect(peekState()).toBeUndefined();
  await api.state();
  setWorkspaceScope('another-repository', 'another-viewer');
  expect(peekState()).toBeUndefined();
  await api.state();
  resetWorkspaceCaches();
  expect(peekState()).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(3);
});
