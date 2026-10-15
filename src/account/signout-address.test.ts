import { afterEach, expect, it, vi } from 'vitest';
import { primeAddress, resetAddresses } from './addresses';
import { resetWorkspaceCaches, setWorkspaceScope } from '../lib/api';

afterEach(() => { resetAddresses(); vi.unstubAllGlobals(); setWorkspaceScope(null); });

it('does not repopulate the address cache with a private response that completes after sign-out', async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(Response.json({ error: 'Repository not found.' }, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const address = { owner: 'private-client', repo: 'ledger' };
  const before = primeAddress(address); // The early member address request is still in flight.

  resetWorkspaceCaches(); resetAddresses(); // Exact cache resets used by AccountProvider.signOut.
  finish(Response.json({ workspaceId: 'private-workspace', owner: { slug: 'private-client', name: 'Unpublished Client', kind: 'organization' },
    repo: { slug: 'ledger', name: 'Acquisition Ledger' }, visibility: 'private', canWrite: true }));
  await before;

  expect(await primeAddress(address), 'An anonymous view must reauthorize this address, not reuse private metadata').toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
