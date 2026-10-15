import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimOwner } from './ClaimOwner';
import { claimOwner, ownerClaim } from './mirrors';
import { accountApi } from './api';
import { primeAddress, resetAddresses, useRepositoryAddress } from './addresses';
import { MirrorError } from '../components/repo/MirrorError';
import { canWrite, newMissionBlocker, readOnlyReason } from '../store/workspace';
import { textOf } from '../test/fixtures';
import type { MirrorSnapshot } from './mirrors';

let eligible = false, linking = false, owning = false;
vi.mock('./AccountProvider', () => ({ useAccount: () => ({ account: { user: { id: 'person', username: 'octocat', email: 'hidden@example.test' } }, refresh: vi.fn() }) }));
vi.mock('../lib/live', () => ({ useLive: () => ({ data: { claimable: eligible, link: linking, owned: owning, kind: 'user' } }) }));
vi.mock('./session', () => ({ writeSession: vi.fn() }));
vi.mock('../lib/router', () => ({ setRouteRef: vi.fn() }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));

const mirror = { source: 'https://github.com/openai/codex', syncedAt: null, importing: false, claimable: true };
const fetchAnswer = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status })));
beforeEach(() => { eligible = false; linking = false; owning = false; resetAddresses(); });
afterEach(() => { vi.unstubAllGlobals(); resetAddresses(); });

describe('GitHub mirror responses', () => {
  it('preserves mirror metadata from the address API', async () => {
    const answer = { workspaceId: 'w', owner: { slug: 'openai', name: 'openai' }, repo: { slug: 'codex', name: 'codex' }, visibility: 'public', canWrite: false, mirror };
    fetchAnswer(answer);
    expect(await primeAddress({ owner: 'openai', repo: 'codex' })).toEqual(answer);
    function Address() { const result = useRepositoryAddress({ owner: 'openai', repo: 'codex' }); return <span>{result.status === 'ready' ? result.address.mirror?.source : result.status}</span>; }
    expect(renderToStaticMarkup(<Address />)).toContain(mirror.source);
  });
  it('retains the owner mirror marker through boundary parsing', async () => {
    fetchAnswer({ owner: { slug: 'openai', name: 'OpenAI', kind: 'organization' }, mirror: true, repositories: [] });
    expect(await accountApi.owner('openai')).toMatchObject({ mirror: true });
  });
  it('checks server eligibility and posts to the same owner', async () => {
    fetchAnswer({ claimable: true });
    expect(await ownerClaim('openai')).toEqual({ claimable: true });
    expect(fetch).toHaveBeenCalledWith('/api/owners/openai/claim', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fetchAnswer({ ok: true, role: 'owner' });
    expect(await claimOwner('openai')).toEqual({ ok: true, role: 'owner' });
    expect(fetch).toHaveBeenCalledWith('/api/owners/openai/claim', expect.objectContaining({ method: 'POST' }));
  });
  it('keeps the server reason when claiming is denied', async () => {
    fetchAnswer({ error: 'Only a GitHub organization admin can claim this owner.' }, 403);
    await expect(claimOwner('openai')).rejects.toThrow('Only a GitHub organization admin can claim this owner.');
  });
  it('preserves the structured private-or-missing code regardless of wording', async () => {
    fetchAnswer({ code: 'github_not_found_or_private', error: 'Unavailable on GitHub.' }, 404);
    await primeAddress({ owner: 'openai', repo: 'codex' });
    await primeAddress({ owner: 'openai', repo: 'codex' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { message: "Not found on GitHub. If it's private, sign in with GitHub to see it.", signIn: true },
    { message: "Not found on GitHub, or you don't have access.", signIn: false },
    { message: 'Too large to mirror.', signIn: false },
  ])('keeps the next step for $message', ({ message, signIn }) => {
    const out = renderToStaticMarkup(<MirrorError message={message} signIn={signIn} address={{ owner: 'openai', repo: 'codex' }} />);
    expect(textOf(out).replaceAll('&#x27;', "'")).toContain(message);
    expect(textOf(out)).toContain(signIn ? 'Sign in with GitHub' : 'Open on GitHub');
    expect(out).toContain(signIn ? 'href="/api/auth/github"' : `href="${mirror.source}"`);
    expect(textOf(out)).not.toMatch(/Loading|Try again|hidden@example/);
  });
  it('keeps a mirror too large to copy a failure, and a 404 without a code a missing repository', async () => {
    fetchAnswer({ code: 'mirror_too_large', error: 'Too large to mirror.' }, 413);
    await primeAddress({ owner: 'openai', repo: 'codex' });
    await primeAddress({ owner: 'openai', repo: 'codex' });
    expect(fetch).toHaveBeenCalledTimes(2);
    resetAddresses();
    fetchAnswer({ error: "Not found on GitHub, or you don't have access." }, 404);
    await primeAddress({ owner: 'openai', repo: 'codex' });
    await primeAddress({ owner: 'openai', repo: 'codex' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('claim and write controls', () => {
  it('uses embedded eligibility, and never reveals an email or starts a spinner', () => {
    const out = renderToStaticMarkup(<ClaimOwner slug="openai" claimable />);
    expect(textOf(out)).toContain('Claim @openai');
    expect(out).toContain('<button');
    expect(out).not.toMatch(/hidden@example|spinner|Loading/);
    expect(renderToStaticMarkup(<ClaimOwner slug="openai" claimable={false} />)).toBe('');
  });
  it('uses the optional eligibility endpoint when mirror metadata omits claimable', () => {
    eligible = true;
    expect(textOf(renderToStaticMarkup(<ClaimOwner slug="openai" />))).toContain('Claim @openai');
    eligible = false;
    expect(renderToStaticMarkup(<ClaimOwner slug="openai" />)).toBe('');
  });
  it('never offers to claim a name the person owns, only to turn on its read-only mirrors', () => {
    eligible = true; owning = true;
    const label = textOf(renderToStaticMarkup(<ClaimOwner slug="theg1239" />)).trim();
    expect(label).toBe('Turn on Braid for @theg1239’s mirrors');
    expect(label).not.toContain('Claim');
  });
  it('offers to link a Braid organization to GitHub when that is what the owner may do', () => {
    eligible = true; linking = true;
    expect(textOf(renderToStaticMarkup(<ClaimOwner slug="acm-vit" />)).trim()).toBe('Link @acm-vit to GitHub');
    eligible = false;
    expect(renderToStaticMarkup(<ClaimOwner slug="acm-vit" />)).toBe('');
  });
  it('keeps an unclaimed mirror read only even if a stale account grants write access', () => {
    const snapshot = { mirror, project: { id: 'codex' }, missions: [], capabilities: { mode: 'live', canWrite: true } } as unknown as MirrorSnapshot;
    expect(canWrite(snapshot)).toBe(false);
    expect(readOnlyReason(snapshot, 'open a pull request')).toBe('Claim this repository to open a pull request.');
    expect(newMissionBlocker(snapshot)).toBe('Claim this repository to start a task.');
    expect(canWrite({ ...snapshot, mirror: undefined } as MirrorSnapshot)).toBe(true);
  });
});
