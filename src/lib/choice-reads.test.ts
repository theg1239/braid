import { afterEach, expect, it, vi } from 'vitest';
import { api, primeState, setWorkspaceScope } from './api';

afterEach(() => { setWorkspaceScope(null); vi.unstubAllGlobals(); });

it('discards unused shared-example startup reads after the actual choice write succeeds', async () => {
  setWorkspaceScope('demo');
  const fetch = vi.fn(async (path: string) => Response.json(path.endsWith('/resolve') ? { id: 'choice' } : { ref: 'personal', project: { head: 'personal' } }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { __braidEarly: { reads: {
    'demo /api/state': Promise.resolve(Response.json({ project: { head: 'shared' } })),
    'demo /api/repository/tree?ref=&path=': Promise.resolve(Response.json({ ref: 'shared' })),
  } } });
  await primeState();
  await api.resolveCollision('choice', { collisionId: 'file', agentId: 'a' });
  expect((await api.state()).project.head).toBe('personal');
  expect((await api.readTree('', '')).ref).toBe('personal');
});

it('does not reinstall a pre-write snapshot validator after the choice response', async () => {
  setWorkspaceScope('demo');
  let finish!: (response: Response) => void;
  const fetch = vi.fn((_path: string, _init?: RequestInit): Promise<Response> => Promise.resolve(Response.json({})));
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const stale = api.state();
  await api.resolveCollision('choice', { collisionId: 'file', agentId: 'a' });
  finish(Response.json({ project: { head: 'shared' } }, { headers: { etag: '"shared"' } }));
  await stale;
  await api.state();
  expect(new Headers(fetch.mock.calls.at(-1)![1]?.headers).has('if-none-match')).toBe(false);
});
