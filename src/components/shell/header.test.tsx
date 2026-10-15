import type { ReactNode } from 'react';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../../shared/account';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { AccountControls, AccountMenu } from '../../account/Masthead';
import { routeOf } from '../../lib/router';
import { LoadingShell } from '../ui/LoadingShell';
import { GlobalHeader } from './GlobalHeader';
import { RepositoryHeader } from './RepositoryHeader';
import { LandingHeader } from './LandingHeader';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() });
  return { route: {} as ReturnType<typeof routeOf>, account: null as Account | null, loading: false, needsYou: 3, ownerName: null as string | null, ownerKind: undefined as 'user' | undefined };
});
vi.mock('../../lib/router', async original => ({ ...await original<typeof import('../../lib/router')>(), useRoute: () => state.route }));
vi.mock('../../account/AccountProvider', () => ({ useAccount: () => ({ account: state.account, accounts: true, loading: state.loading, error: null, signOut: vi.fn() }) }));
vi.mock('../../account/addresses', () => ({ useRepositoryAddress: () => ({ status: 'loading' }) }));
vi.mock('../../dashboard/inbox', () => ({ useInbox: () => ({ needsYou: state.needsYou }) }));
vi.mock('../../lib/live', () => ({ useLive: () => ({ data: state.ownerName ? { owner: { name: state.ownerName, kind: state.ownerKind } } : null }) }));
vi.mock('../../lib/prefetch', () => ({ canPrefetch: () => false, prefetchHref: vi.fn() }));
vi.mock('../../store/workspace', () => ({ canWrite: () => true }));
// Render menu contents inline: portal positioning and keyboard behavior are checked in the browser.
vi.mock('@cloudflare/kumo', async original => {
  const actual = await original<typeof import('@cloudflare/kumo')>();
  const Wrapper = ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>;
  const Link = ({ children, href }: { children?: ReactNode; href: string }) => <a role="menuitem" href={href}>{children}</a>;
  return { ...actual, useKumoToastManager: () => ({ add: vi.fn() }), DropdownMenu: Object.assign(Wrapper, {
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: Wrapper, Group: Wrapper, Label: Wrapper, Separator: () => <hr />,
    LinkItem: Link, Item: ({ children }: { children: ReactNode }) => <button role="menuitem">{children}</button>,
  }) };
});

const user = { id: 'email:1', email: 'ishaan@example.test', name: 'Ishaan', username: 'theg1239', avatarUrl: null };
const account = (): Account => ({ user: { ...user }, organizations: [], provider: 'github', signupEnabled: true, methods: { github: true, email: true, passkeys: false } });
const contexts = [
  ['/', 'Dashboard'], ['/explore', 'Explore'], ['/new', 'New repository'], ['/organizations/new', 'New organization'],
  ['/settings/account', 'Settings'], ['/ishaan', 'ishaan'], ['/acmvit', 'acmvit'],
  ['/orgs/acmvit/repositories', 'acmvit'], ['/orgs/acmvit/teams', 'acmvit'], ['/orgs/acmvit/people', 'acmvit'], ['/orgs/acmvit/settings', 'acmvit'],
  ['/acmvit/relay', 'relay'], ['/acmvit/relay/pulls', 'relay'], ['/acmvit/relay/settings', 'relay'],
] as const;
async function render(node: ReactNode) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}
beforeEach(() => { state.route = routeOf('/explore'); state.account = account(); state.loading = false; state.needsYou = 3; state.ownerName = null; state.ownerKind = undefined; });

describe.each([{ signedIn: true, username: 'theg1239' }, { signedIn: true, username: null }, { signedIn: false, username: null }])('global header: $signedIn, username: $username', ({ signedIn, username }) => {
  it.each(contexts)('uses the URL context for %s', async (href, label) => {
    state.route = routeOf(href);
    state.account!.user!.username = username;
    if (!signedIn) state.account!.user = null;
    const html = await render(<GlobalHeader />);
    const breadcrumb = html.match(/<nav class="global-head__context".*?<\/nav>/)?.[0];
    expect(breadcrumb).toContain(`>${label}</`);
    expect(html).toContain('aria-label="Braid"');
    expect(html).not.toContain(user.email);
    expect(html).not.toContain('mailto:');
    if (signedIn) {
      // The name carries the visible text, shortcut hint included (2.5.3); aria-keyshortcuts carries the key itself.
      expect(html).toMatch(/aria-label="Search (⌘K|Ctrl K)" aria-keyshortcuts="(Meta|Control)\+K"/);
      expect(html).toContain('aria-label="Create"');
      expect(html).toContain('Inbox: 3 pull requests need you');
      expect(html).toContain(username ? 'Account: @theg1239' : 'Account: Ishaan');
      expect(html).not.toContain('>Sign in</');
    } else {
      expect(html).toContain('>Sign in</');
      expect(html).toContain('aria-label="Site"');
      expect(html).toContain('href="/explore"');
      expect(html).toContain('href="/example/relay"');
      expect(html).not.toContain('aria-label="Create"');
      expect(html).not.toContain('header-account-button');
    }
  });
});

describe('account menu', () => {
  it('shows the username and name, profile, organizations, Settings, and sign out', () => {
    const html = renderToStaticMarkup(<AccountMenu />);
    for (const label of ['@theg1239', 'Ishaan', 'Your profile', 'Your organizations', 'Settings', 'Sign out']) expect(html).toContain(label);
    for (const href of ['/theg1239', '/settings/organizations', '/settings/account']) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('Pick a username');
    expect(html).not.toContain(user.email);
    expect(html).not.toContain('<img');
    expect(html).toContain('<svg');
  });
  it('shows a name and the username flow while a username has not been picked', () => {
    state.account!.user!.username = null;
    const html = renderToStaticMarkup(<AccountMenu />);
    expect(html).toContain('Account: Ishaan');
    expect(html).toContain('href="/account/username"');
    expect(html).toContain('Pick a username');
    expect(html).not.toContain('Your profile');
    expect(html).not.toContain(user.email);
  });
  it.each([null, 'theg1239'])('does not expose an email stored as the old display name (username %s)', username => {
    state.account!.user = { ...user, name: user.email, username };
    const html = renderToStaticMarkup(<AccountMenu />);
    expect(html).not.toContain(user.email);
    expect(html).not.toContain('gmail.com');
    expect(html).toContain(username ? 'Account: @theg1239' : 'Account: Your account');
  });
  it('shows a display name that merely contains an @', () => {
    state.account!.user = { ...user, name: '@maya-chen', username: null };
    expect(renderToStaticMarkup(<AccountMenu />)).toContain('Account: @maya-chen');
  });
  it('uses a linked GitHub avatar for an account that signed in with email', () => {
    state.account!.user!.avatarUrl = 'https://avatars.githubusercontent.com/u/123?s=64';
    const html = renderToStaticMarkup(<AccountMenu />);
    expect(html).toContain('<img');
    expect(html).toContain('src="https://avatars.githubusercontent.com/u/123?s=64"');
    expect(html).not.toContain(user.email);
  });
  it('uses a neutral icon when GitHub has been unlinked', () => {
    state.account!.user = { ...user, id: 'github:123', avatarUrl: null };
    expect(renderToStaticMarkup(<AccountMenu />)).not.toContain('<img');
  });
  it('offers creation and the same inbox count in the phone menu', () => {
    const html = renderToStaticMarkup(<AccountControls />);
    const mobile = html.match(/<div class="global-head__mobile">.*?<\/div>/)?.[0];
    for (const label of ['Inbox', 'New repository', 'Import repository', 'New organization']) expect(mobile).toContain(label);
    for (const href of ['/', '/new', '/new?import=1', '/organizations/new']) expect(mobile).toContain(`href="${href}"`);
    expect(mobile).toContain('>3</span>');
    expect(html).toContain('Inbox: 3 pull requests need you');
  });
  it('keeps an empty inbox reachable without showing a zero badge', () => {
    state.needsYou = 0;
    const html = renderToStaticMarkup(<AccountControls />);
    expect(html).toContain('aria-label="Inbox"');
    expect(html).not.toContain('global-head__count');
  });
  it('renders no account controls when signed out', () => {
    state.account!.user = null;
    expect(renderToStaticMarkup(<AccountControls />)).toBe('');
    expect(renderToStaticMarkup(<AccountMenu />)).toBe('');
  });
});

describe('header continuity', () => {
  it.each(contexts)('renders its context before any account data: %s', (href, label) => {
    state.route = routeOf(href);
    state.account = null;
    state.loading = true;
    const html = renderToStaticMarkup(<LoadingShell />);
    expect(html).toContain(`>${label}</`);
    expect(html.match(/class="global-head"/g)).toHaveLength(1);
  });
  it('uses loaded names while retaining canonical repository links and tabs', async () => {
    state.route = routeOf('/acmvit/relay/pulls');
    state.account!.organizations = [{ id: 'org', name: 'ACM VIT', slug: 'acmvit', role: 'owner', workspaces: [] }];
    const snapshot = { project: { id: 'repo', name: 'Relay Service' }, capabilities: {} } as WorkspaceSnapshot;
    const html = await render(<RepositoryHeader snapshot={snapshot} screen="pulls" address={state.route.repo} counts={{ open: 4, tasks: 2 }} />);
    expect(html).toContain('>ACM VIT</a>');
    expect(html).toContain('>Relay Service</a>');
    for (const suffix of ['', '/pulls', '/agents', '/settings']) expect(html).toContain(`href="/acmvit/relay${suffix}"`);
    expect(html).toContain('aria-label="Repository"');
  });
  it('replaces an owner URL label with the page’s shared loaded name', async () => {
    state.route = routeOf('/acmvit');
    state.ownerName = 'ACM VIT';
    const html = await render(<GlobalHeader />);
    expect(html).toContain('>ACM VIT</a>');
    expect(html).toContain('href="/acmvit"');
  });
  it('shows a person by their username, as the address does, on their repository and profile', async () => {
    const breadcrumb = (html: string) => html.match(/<nav class="global-head__context".*?<\/nav>/)?.[0] ?? '';
    state.route = routeOf('/theg1239/relay/pulls');
    state.account!.personalOwner = { id: 'p1', name: 'Ishaan', slug: 'theg1239', role: 'owner', kind: 'user', workspaces: [] };
    const snapshot = { project: { id: 'repo', name: 'relay' }, capabilities: {} } as WorkspaceSnapshot;
    const repository = breadcrumb(await render(<RepositoryHeader snapshot={snapshot} screen="pulls" address={state.route.repo} counts={{ open: 0, tasks: 0 }} />));
    expect(repository).toContain('>theg1239</a>');
    expect(repository).not.toContain('Ishaan');
    state.route = routeOf('/theg1239');
    state.ownerName = 'Ishaan';
    state.ownerKind = 'user';
    const profile = breadcrumb(await render(<GlobalHeader />));
    expect(profile).toContain('>theg1239</a>');
    expect(profile).not.toContain('Ishaan');
  });
  it('keeps the landing masthead separate', async () => {
    state.route = routeOf('/');
    state.account!.user = null;
    const html = await render(<LandingHeader />);
    expect(html).toContain('class="site-head site-head--landing"');
    expect(html).toContain('Get started');
    expect(html).toContain('>Tour<');
    // Links may point at the recorded repository; the words never call it an example.
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\bexample\b/i);
    expect(html).not.toContain('global-head');
    // It starts on the sky, not floating, and marks where the page begins so it knows when to float.
    expect(html).toContain('<span class="site-head__top" aria-hidden="true"></span>');
    expect(html).not.toContain('data-floating');
    for (const label of ['Tour', 'Explore', 'Docs', 'Get started']) expect(html).toContain(`>${label}</a>`);
    expect(html).not.toContain('>Sign in<');
  });
});
