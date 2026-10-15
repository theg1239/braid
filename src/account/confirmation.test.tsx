import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../../shared/account';
import { routeOf } from '../lib/address';
import { AccountGate } from './AccountGate';

const state = vi.hoisted(() => ({ account: null as Account | null, href: '', supported: true }));
vi.mock('./AccountProvider', () => ({ useAccount: () => ({ account: state.account, accounts: true, loading: false, error: null, pendingInvite: null, pendingConnect: null }) }));
vi.mock('../lib/router', () => ({
  useRoute: () => routeOf(state.href, 'https://braid.test'), navigate: vi.fn(),
  isAppPath: (href: string) => href.startsWith('/') && !href.startsWith('//'),
  EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' },
  paths: { accountSettings: () => '/settings/account', repo: () => '/example/relay' },
}));
vi.mock('../components/shell/GlobalHeader', () => ({ GlobalHeader: () => <header /> }));
vi.mock('../components/ui/LoadingShell', () => ({ LoadingShell: () => <div>Loading</div> }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => state.supported, startAuthentication: vi.fn() }));

beforeEach(() => {
  state.href = '/signin?confirm=1&next=%2Fsettings%2Faccount';
  state.supported = true;
  state.account = { user: { id: 'email:owner', name: 'Owner', email: 'owner@example.test', username: 'owner', avatarUrl: null }, organizations: [], provider: 'github', signupEnabled: true, methods: { github: false, email: true, passkeys: true } };
});
async function render() {
  const stream = await renderToReadableStream(<AccountGate><p>Destination</p></AccountGate>);
  await stream.allReady;
  return new Response(stream).text();
}

it.each([true, false])('shows email confirmation even when signed in: %s', async signedIn => {
  if (!signedIn) state.account!.user = null;
  const html = await render();
  expect(html).toMatch(/<h1[^>]*>Confirm it’s you<\/h1>/);
  expect(html).toContain('Email me a code');
  expect(html).not.toContain('Continue with GitHub');
  expect(html).not.toContain('Destination');
});

it('still offers email when the browser cannot use passkeys', async () => {
  state.supported = false;
  const html = await render();
  expect(html).toContain('Email me a code');
  expect(html).not.toContain('Sign in with a passkey');
});

it('offers GitHub only when configured', async () => {
  state.account!.methods.github = true;
  expect(await render()).toContain('Continue with GitHub');
});

it('leaves ordinary sign-in redirects to the router', async () => {
  state.href = '/signin?next=%2Fsettings%2Faccount';
  expect(await render()).toBe('<p>Destination</p>');
});
