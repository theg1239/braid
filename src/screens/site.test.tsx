import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { Account } from '../../shared/account';

vi.mock('../components/shell/GlobalHeader', () => ({ GlobalHeader: () => <header /> }));
vi.mock('../lib/router', () => ({
  EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' },
  addressPath: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`,
  isAppPath: (href?: string) => !!href && href.startsWith('/'),
  navigate: () => undefined,
  useRoute: () => ({ query: new URLSearchParams() }),
  paths: { repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`, owner: (slug: string) => `/${slug}`, signin: () => '/signin', newOrganization: () => '/organizations/new', site: () => '/', explore: () => '/explore', newRepository: (team?: string) => (team ? `/new?team=${team}` : '/new') },
}));
vi.mock('../lib/api', () => ({ request: () => new Promise(() => undefined), errorMessage: (e: unknown) => String(e), resetWorkspaceCaches: () => undefined }));
vi.mock('../lib/live', () => ({ useLive: () => live }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ account, refresh: async () => account, pendingInvite: null, pendingConnect: null }) }));
vi.mock('../account/addresses', () => ({ resetAddresses: () => undefined }));
vi.mock('../account/session', () => ({ formatConnectCode: (c: string) => c, writeSession: () => undefined, readSession: () => null }));

let account: Account;
let live: { data: unknown; loading: boolean; error: string | null; refreshing: boolean; refresh: () => Promise<null> } = { data: null, loading: true, error: null, refreshing: false, refresh: async () => null };

const base = (organizations: Account['organizations'], signupEnabled = true): Account => ({
  user: { id: 'u1', email: 'ishaan@example.com', name: 'Ishaan Samdani' },
  provider: 'github',
  signupEnabled,
  methods: { github: true, email: true, passkeys: false },
  organizations,
});
const workspace = (id: string, organizationId: string, slug: string, visibility: 'public' | 'private') => ({ id, organizationId, name: slug, slug, visibility, createdAt: '2026-10-02T09:10:00Z' });
const organizations: Account['organizations'] = [
  { id: 't1', name: 'ACM VIT', slug: 'acmvit', role: 'owner', workspaces: [workspace('w1', 't1', 'examcooker', 'public'), workspace('w2', 't1', 'code2create', 'private')] },
  { id: 't2', name: 'Conclave', slug: 'conclave', role: 'member', workspaces: [workspace('w3', 't2', 'conclave', 'public')] },
];


describe('The dashboard', async () => {
  const { DashboardScreen } = await import('./DashboardScreen');
  const html = () => renderToStaticMarkup(<DashboardScreen />);

  it('shows what needs the person, recent activity and the repositories by team, with one New repository', () => {
    account = base(organizations);
    const out = html();
    const words = textOf(out);
    expect(out).toContain('<h1 class="dash__title">Dashboard</h1>');
    expect(out.match(/href="\/new"/g)?.length).toBe(1);
    // The inbox loads as one skeleton; dashboard.test.tsx covers its sections once loaded.
    expect(out).toContain('Loading inbox');
    expect(words).toContain('Repositories 3');
    expect(words).toContain('ACM VIT');
    expect(words).toContain('Conclave Member');
    expect(out).toContain('href="/acmvit/examcooker"');
    expect(out).toContain('href="/acmvit/code2create"');
    expect(out).toContain('href="/conclave/conclave"');
    expect(words).toContain('Private');
    expect(out).toContain('href="/example/relay"');
    expect(words).not.toMatch(/✨|trunk|lane|autonomy/);
  });

  it('offers New repository first, with the example beside it, when there is nothing yet', () => {
    account = base([{ id: 't1', name: 'ACM VIT', slug: 'acmvit', role: 'owner', workspaces: [] }]);
    const out = html();
    expect(textOf(out)).toContain('Create your first repository');
    expect(out).toContain('href="/new"');
    expect(out).toContain('href="/example/relay"');
  });

  it('allows a personal repository when organization signup is closed', () => {
    account = base([], false);
    account.personalOwner = { id: 'personal', kind: 'user', name: 'Ishaan', slug: 'ishaan', role: 'owner', workspaces: [] };
    const out = html();
    expect(textOf(out)).toContain('Create your first repository');
    expect(out).toContain('href="/new"');
    expect(out).toContain('href="/example/relay"');
  });
});

describe('Explore', async () => {
  const { ExploreScreen } = await import('./ExploreScreen');
  const html = () => renderToStaticMarkup(<ExploreScreen />);

  it('pins the labelled example over the public repositories, newest first, with Load more and no subtitle', () => {
    account = base(organizations);
    live = { data: { items: [{ owner: { slug: 'acmvit', name: 'ACM VIT' }, repo: { slug: 'examcooker', name: 'ExamCooker' }, description: 'Past papers', updatedAt: '2026-10-11T07:12:00Z' }], nextCursor: 'page2' }, loading: false, error: null, refreshing: false, refresh: async () => null };
    const out = html();
    const words = textOf(out);
    expect(words).toContain('Explore');
    expect(words).not.toContain('Public repositories on Braid');
    expect(out.indexOf('href="/example/relay"')).toBeLessThan(out.indexOf('href="/acmvit/examcooker"'));
    expect(words).toContain('recorded example');
    expect(words).toContain('Past papers');
    expect(words).toContain('Load more');
  });

  it('has one calm line when the example is the only public repository', () => {
    live = { data: { items: [], nextCursor: null }, loading: false, error: null, refreshing: false, refresh: async () => null };
    const words = textOf(html());
    expect(words).toContain('No other public repositories yet.');
    expect(words).not.toContain('Load more');
  });
});

describe('Sign-in', async () => {
  const { SignIn } = await import('../account/SignIn');

  it('leads with GitHub, offers the email code, and links the example without the agent guides', () => {
    account = base([]);
    account.user = null;
    const out = renderToStaticMarkup(<SignIn next="/acmvit/examcooker" />);
    const words = textOf(out);
    expect(words).toContain('Sign in to Braid');
    expect(out).toContain('href="/api/auth/github"');
    expect(words).toContain('Continue with GitHub');
    expect(words).toContain('Email me a code');
    expect(out).toContain('href="/example/relay"');
    expect(words).toContain('Explore the example');
    expect(words).not.toMatch(/setup prompt|setup\.md|auth\.md|llms\.txt/i);
    expect(out).not.toContain('gate__card');
  });
});
