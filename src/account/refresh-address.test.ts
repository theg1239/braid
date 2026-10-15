import { afterEach, expect, it, vi } from 'vitest';
import type { MirrorAddress } from './mirrors';
import { primeAddress, refreshOwnerAddresses, resetAddresses } from './addresses';
import { resetWorkspaceCaches, setWorkspaceScope } from '../lib/api';

const address = { owner: 'openai', repo: 'codex' };
const mirror: MirrorAddress = { workspaceId: 'codex', owner: { slug: 'openai', name: 'OpenAI', kind: 'organization' }, repo: { slug: 'codex', name: 'codex' }, visibility: 'public', canWrite: false,
  mirror: { source: 'https://github.com/openai/codex', syncedAt: null, importing: true, claimable: false } };
afterEach(() => { resetAddresses(); resetWorkspaceCaches(); vi.unstubAllGlobals(); setWorkspaceScope(null); });

it('refreshes from the server when boot finishes late, keeping the current address until the new answer arrives', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(mirror)).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  expect(await primeAddress(address)).toEqual(mirror);
  // On a warm WebKit start, async boot can finish after the application has already read the address.
  vi.stubGlobal('window', { __braidEarly: { reads: { ' /api/repos/openai/codex': Promise.resolve(Response.json(mirror)) } } });
  const refreshing = refreshOwnerAddresses('openai');
  expect(await primeAddress(address)).toEqual(mirror);
  expect(fetch).toHaveBeenCalledTimes(2);
  const ready = { ...mirror, mirror: { ...mirror.mirror!, importing: false, syncedAt: '2026-10-14T10:00:00Z' } };
  finish(Response.json(ready));
  await refreshing;
  expect(await primeAddress(address)).toEqual(ready);
  expect(window.__braidEarly?.reads?.[' /api/repos/openai/codex']).toBeUndefined();
});

it('asks again for an address that was missing, as after its owner is linked to GitHub', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Repository not found.' }, { status: 404 })).mockResolvedValueOnce(Response.json(mirror));
  vi.stubGlobal('fetch', fetch);
  expect(await primeAddress(address)).toBeNull();
  expect(await primeAddress(address)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  await refreshOwnerAddresses('openai');
  expect(await primeAddress(address)).toEqual(mirror);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not restore an owner response when the session resets during its refresh', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(mirror))
    .mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(Response.json(mirror)));
  await primeAddress(address);
  const refreshing = refreshOwnerAddresses('openai');
  resetAddresses(); resetWorkspaceCaches();
  finish(Response.json({ ...mirror, canWrite: true, mirror: undefined }));
  await refreshing;
  expect(await primeAddress(address)).toEqual(mirror);
});
