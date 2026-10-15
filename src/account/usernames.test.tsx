import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../shared/account';
import { accountOwners } from '../../shared/account';
import { routeOf, isRepositoryScreen } from '../lib/address';
import { textOf } from '../test/fixtures';

vi.mock('@cloudflare/kumo', async original => ({ ...(await original<typeof import('@cloudflare/kumo')>()), useKumoToastManager: () => ({ add: vi.fn() }) }));
vi.mock('../components/ui/LoadingShell', () => ({ LoadingShell: () => <div>Loading</div> }));
vi.mock('../lib/router', () => ({ navigate: vi.fn(), useRoute: () => routeOf('/new', 'https://braid.example'), EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' }, paths: {
  pickUsername: () => '/account/username', newRepository: () => '/new', repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`,
} }));
vi.mock('./AccountProvider', () => ({ useAccount: () => ({ account, refresh: vi.fn() }) }));
vi.mock('./api', () => ({ accountApi: { username: vi.fn() } }));
vi.mock('./addresses', () => ({ resetAddresses: vi.fn() }));
vi.mock('../components/shell/GlobalHeader', () => ({ GlobalHeader: () => <header>Global header</header> }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
import { needsUsername } from './AccountGate';
import { PickUsername, usernameError } from './Username';
import { NewRepositoryScreen } from '../screens/NewRepositoryScreen';

let account: Account;
beforeEach(() => {
  account = { user: { id: 'alice', email: 'alice@example.com', name: 'Alice', username: null, avatarUrl: null }, personalOwner: null, usernameSuggestion: 'alice-2', organizations: [], provider: 'github', signupEnabled: true, methods: { github: true, email: true, passkeys: true } };
});

describe('first-run username selection', () => {
  it.each(['/', '/signin', '/new', '/organizations/new', '/settings/account'])('asks existing accounts without a username on %s', path => {
    expect(needsUsername(account, routeOf(path, 'https://braid.example'))).toBe(true);
  });
  it.each(['/example/relay', '/example/relay/pulls', '/explore', '/alice', '/acme/public-repo', '/orgs/acme/repositories'])('does not gate the example or public page %s', path => {
    expect(needsUsername(account, routeOf(path, 'https://braid.example'))).toBe(false);
  });
  it('does not ask again after choosing and does not gate visitors', () => {
    account.user!.username = 'alice';
    expect(needsUsername(account, routeOf('/', 'https://braid.example'))).toBe(false);
    account.user = null;
    expect(needsUsername(account, routeOf('/', 'https://braid.example'))).toBe(false);
  });
  it('renders one field with the available suggestion and a link to the example, with no email', () => {
    const html = renderToStaticMarkup(<PickUsername />);
    expect(textOf(html)).toContain('Pick a username'); expect(html).toContain('value="alice-2"');
    expect(html).toContain('href="/example/relay"'); expect(html).not.toContain('alice@example.com');
    expect((html.match(/<input/g) ?? []).length).toBe(1); expect(textOf(html)).toContain('Global header');
  });
  it('uses the same format and reserved-word rules before submitting', () => {
    expect(usernameError('Alice-2')).toBeNull(); expect(usernameError('API')).toMatch(/reserved/);
    expect(usernameError('alice--2')).toMatch(/single hyphens/);
  });
  it('keeps personal settings and username routes outside repositories', () => {
    for (const [path, screen] of [['/settings/account', 'account'], ['/settings/organizations', 'organizations'], ['/account/username', 'username']]) {
      const route = routeOf(path, 'https://braid.example'); expect(route.screen).toBe(screen); expect(route.repo).toBeNull(); expect(isRepositoryScreen(route.screen)).toBe(false);
    }
    expect(routeOf('/alice/app/settings/account', 'https://braid.example').screen).toBe('settings');
    expect(routeOf('/settings/account', 'https://braid.example').id).toBe('account');
  });
  it('defaults new repositories to the personal owner before organizations', () => {
    vi.stubGlobal('window', { location: { host: 'braid.example' } });
    account.user!.username = 'alice';
    account.personalOwner = { id: 'personal', kind: 'user', name: 'Alice', slug: 'alice', role: 'owner', workspaces: [] };
    account.organizations = [{ id: 'org', kind: 'organization', name: 'Acme', slug: 'acme', role: 'owner', workspaces: [] }];
    expect(accountOwners(account).map(owner => owner.slug)).toEqual(['alice', 'acme']);
    const html = renderToStaticMarkup(<NewRepositoryScreen />);
    expect(textOf(html)).toContain('@alice (you)'); expect(textOf(html)).not.toContain('Create an organization');
    vi.unstubAllGlobals();
  });
});
