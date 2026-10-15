import { afterEach, expect, it, vi } from 'vitest';
import { api, resetWorkspaceCaches, setWorkspaceScope } from './api';

afterEach(() => { vi.unstubAllGlobals(); setWorkspaceScope(null); });

it('does not return an old member response after sign-out resets workspace caches', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'Repository not found.' }, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('private-repo', 'member');
  // Boot read the root while a deep link mounted a different screen. It has not been consumed.
  vi.stubGlobal('window', { __braidEarly: { reads: {
    'private-repo /api/repository/tree?ref=&path=': Promise.resolve(Response.json({ ref: 'member-head', entries: [{ name: 'confidential.txt' }] })),
  } } });
  resetWorkspaceCaches(); // AccountProvider.signOut uses this.
  setWorkspaceScope('private-repo', null);
  await expect(api.readTree('', '')).rejects.toMatchObject({ status: 404 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not reuse a pre-write shared-example read after the visitor obtains a personal copy', async () => {
  const fetch = vi.fn(async () => Response.json({ ref: 'personal-copy', entries: [{ name: 'visitor-file.txt' }] }));
  vi.stubGlobal('fetch', fetch);
  setWorkspaceScope('demo');
  vi.stubGlobal('window', { __braidEarly: { reads: {
    'demo /api/repository/tree?ref=&path=': Promise.resolve(Response.json({ ref: 'shared-copy', entries: [] })),
  } } });
  resetWorkspaceCaches();
  expect((await api.readTree('', '')).ref).toBe('personal-copy');
});

it('does not take an unused member snapshot into the anonymous session of a public repository', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ capabilities: { canWrite: false }, missions: [], project: { head: 'public-head' } })));
  setWorkspaceScope('public-repo', 'member');
  vi.stubGlobal('window', { __braidEarly: { reads: {
    'public-repo /api/state': Promise.resolve(Response.json({ capabilities: { canWrite: true }, missions: [{ id: 'member-only-task', intent: 'private proposal context' }], project: { head: 'member-head' } })),
  } } });
  resetWorkspaceCaches();
  setWorkspaceScope('public-repo', null);
  expect(await api.state()).toMatchObject({ capabilities: { canWrite: false }, missions: [], project: { head: 'public-head' } });
});
