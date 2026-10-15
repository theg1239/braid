import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shares the primed account with concurrent mounts and makes the failed attempt retryable', async () => {
  const fetch = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const { loadAccount, primeAccount } = await import('./read');
  primeAccount();
  const first = loadAccount();
  expect(loadAccount()).toBe(first);
  const failed = expect(first).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(4000);
  await failed;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);

  const account = { user: null, provider: 'github', organizations: [], signupEnabled: true, methods: { github: true, email: true, passkeys: false } };
  fetch.mockResolvedValueOnce(Response.json(account));
  await expect(loadAccount()).resolves.toEqual({ ...account, personalOwner: null, usernameSuggestion: null });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('takes over boot without issuing a second request', async () => {
  const account = { user: null, provider: 'github', organizations: [], signupEnabled: false, methods: { github: true, email: false, passkeys: false } };
  vi.stubGlobal('window', { __braidEarly: { account: Promise.resolve(Response.json(account)) } });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { loadAccount, primeAccount } = await import('./read');
  primeAccount();
  await expect(loadAccount()).resolves.toEqual({ ...account, personalOwner: null, usernameSuggestion: null });
  expect(fetch).not.toHaveBeenCalled();
});

const accountFields = { user: { id: 'u1', email: 'owner@example.com', name: 'Owner' }, provider: 'github', signupEnabled: true, methods: { github: true, email: true, passkeys: false } };
const legacyOrganization = { id: 'o1', slug: 'acme', name: 'Acme', role: 'owner', workspaces: [{ id: 'w1', teamId: 'o1', slug: 'app', name: 'App', visibility: 'private', createdAt: '2026-10-12T00:00:00Z' }] };

it.each(['request', 'boot'])('normalizes an old Worker account response for a new page through %s', async source => {
  const legacy = { ...accountFields, teams: [legacyOrganization] };
  const fetch = vi.fn().mockResolvedValue(Response.json(legacy));
  vi.stubGlobal('fetch', fetch);
  if (source === 'boot') vi.stubGlobal('window', { __braidEarly: { account: Promise.resolve(Response.json(legacy)) } });
  const { loadAccount, primeAccount } = await import('./read');
  primeAccount();
  const account = await loadAccount();
  const { teamId, ...repository } = legacyOrganization.workspaces[0];
  expect(account).toEqual({ ...accountFields, user: { ...accountFields.user, username: null, avatarUrl: null }, personalOwner: null, usernameSuggestion: null, organizations: [{ ...legacyOrganization, kind: 'organization', workspaces: [{ ...repository, organizationId: teamId }] }] });
  expect(account).not.toHaveProperty('teams');
  expect(fetch).toHaveBeenCalledTimes(source === 'boot' ? 0 : 1);
});

it('uses the canonical organizations field when both rollout keys are present', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...accountFields, organizations: [], teams: [legacyOrganization] })));
  const { loadAccount } = await import('./read');
  await expect(loadAccount()).resolves.toEqual({ ...accountFields, user: { ...accountFields.user, username: null, avatarUrl: null }, personalOwner: null, usernameSuggestion: null, organizations: [] });
});

it('rejects an invalid account payload at the boundary', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...accountFields, teams: [{ ...legacyOrganization, role: 'admin' }] })));
  const { loadAccount } = await import('./read');
  await expect(loadAccount()).rejects.toThrow();
});
