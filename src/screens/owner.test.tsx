import type { ReactNode } from 'react';
import { Toasty } from '@cloudflare/kumo';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { Account } from '../../shared/account';
import type { OwnerRepositories } from '../../shared/owners';
import type { Live } from '../lib/live';
vi.mock('../lib/router', () => ({
  useRoute: () => route, navigate: vi.fn(),
  paths: { owner: (slug: string) => `/${slug}`, repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`, explore: () => '/explore', globalSearch: (query?: string) => `/search${query ? `?q=${encodeURIComponent(query)}` : ''}`, newRepository: (org: string, importing?: boolean) => `/new?org=${org}${importing ? '&import=1' : ''}`, organization: (org: string, tab: string) => `/orgs/${org}/${tab}` },
}));
vi.mock('../lib/live', () => ({ useLive: () => live }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T10:00:00Z') }));
vi.mock('../account/api', () => ({ accountApi: { owner: vi.fn() } }));
vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ account: { organizations, user } }) }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, ...props }: { children: ReactNode; href: string; className?: string }) => <a {...props}>{children}</a> }));
vi.mock('../account/OrganizationPeople', () => ({ OrganizationPeople: () => <div>Organization people</div> }));
vi.mock('../account/OrganizationSettings', () => ({ OrganizationSettings: () => <div>Organization settings</div> }));
vi.mock('./OrganizationTeams', () => ({ OrganizationTeams: () => <div>Organization teams</div> }));
import { OwnerScreen } from './OwnerScreen';
const repo = (slug: string, visibility: 'public' | 'private' = 'public') => ({ slug, name: slug, description: 'Past papers', visibility, updatedAt: '2026-10-11T10:00:00Z' });
let live: Live<OwnerRepositories>;
let organizations: Account['organizations'];
let user: Account['user'];
let route: { screen: string; id: string; sub: string | null; path: string; query: URLSearchParams };
beforeEach(() => {
  organizations = []; user = null;
  route = { screen: 'owner', id: 'acmvit', sub: null, path: '', query: new URLSearchParams() };
  live = { data: { owner: { slug: 'acmvit', name: 'ACM VIT' }, repositories: [repo('examcooker')] }, error: null, errorStatus: null, loading: false, refreshing: false, updatedAt: 1, refresh: vi.fn() };
});
const html = () => renderToStaticMarkup(<OwnerScreen />);
function member(role: 'owner' | 'member' = 'owner') { organizations = [{ id: 'o1', name: 'ACM VIT', slug: 'acmvit', role, workspaces: [] }]; }
describe('organization pages', () => {
  it('shows visitors only Overview and Repositories, with no people counts or creation', () => {
    const out = html(); expect(textOf(out)).toContain('Overview Repositories 1');
    expect(textOf(out)).not.toMatch(/Teams|People|Settings|New repository/);
    expect(out).toContain('href="/acmvit/examcooker"');
  });
  it('labels an unclaimed mirror and keeps it read only even for a matching username', () => {
    user = { id: 'person', name: 'OpenAI', email: 'hidden@example.test', username: 'openai' };
    live.data = { owner: { slug: 'openai', name: 'OpenAI', kind: 'user' }, mirror: true, repositories: [repo('codex')] };
    const out = renderToStaticMarkup(<Toasty><OwnerScreen /></Toasty>);
    expect(out).toContain('href="https://github.com/openai"');
    expect(textOf(out)).toContain('Mirrored from github.com/openai');
    expect(textOf(out)).not.toMatch(/New repository|Settings|hidden@example/);
  });
  it('shows member tabs and counts while keeping Settings and creation for owners', () => {
    member('member'); live.data!.memberCount = 3;
    expect(textOf(html())).toMatch(/Teams People.*3 people/);
    expect(textOf(html())).not.toMatch(/Settings|New repository/);
    member(); expect(textOf(html())).toMatch(/Teams People Settings/);
    expect(html().match(/href="\/new\?org=acmvit"/g)).toHaveLength(1);
  });
  it('offers New repository and Import on an empty organization', () => {
    member(); live.data!.repositories = [];
    const out = html(); expect(textOf(out)).toContain('No repositories yet.');
    expect(out).toContain('href="/new?org=acmvit"'); expect(out).toContain('href="/new?org=acmvit&amp;import=1"');
  });
  it('always offers repository search, visibility filtering and sorting', () => {
    route = { ...route, screen: 'organization', sub: 'repositories' };
    const out = html(); for (const label of ['Find a repository', 'Repository type', 'Sort repositories']) expect(out).toContain(label);
  });
  it.each(['teams', 'people', 'settings'])('does not render a restricted %s route to visitors', sub => {
    route = { ...route, screen: 'organization', sub };
    const out = html();
    expect(textOf(out)).toContain('Page not found'); expect(textOf(out)).not.toContain('ACM VIT');
    expect(out.match(/<h1\b/g)).toHaveLength(1);
  });
  it('does not render Settings to an organization member', () => {
    member('member'); route = { ...route, screen: 'organization', sub: 'settings' };
    const out = html();
    expect(textOf(out)).toContain('Page not found');
    expect(out.match(/<h1\b/g)).toHaveLength(1);
  });
  it('discards stale private content on 404', () => {
    live = { ...live, errorStatus: 404, error: 'Owner not found.' };
    expect(textOf(html())).toContain('Page not found'); expect(textOf(html())).not.toContain('examcooker');
  });
  it('shows the address once when the name is the address', () => {
    expect(html()).toContain('class="owner__address" href="/acmvit">acmvit</a>');
    live.data = { owner: { slug: 'testtt', name: 'testtt' }, repositories: [] };
    const out = html();
    expect(out).toContain('<h1 class="owner__title">testtt</h1>');
    expect(out).not.toContain('owner__address');
  });
  it('uses the shared skeleton until the organization loads', () => {
    live = { ...live, data: null, loading: true }; expect(html()).toContain('aria-label="Loading profile"'); expect(textOf(html())).not.toContain('No repositories');
  });
  it('offers retry without exposing stale membership after a failed read', () => {
    live = { ...live, error: 'Try again shortly.', errorStatus: 503 };
    const out = html();
    expect(textOf(out)).toContain('Couldn’t load profile'); expect(textOf(out)).not.toContain('examcooker');
    expect(out.match(/<h1\b/g)).toHaveLength(1);
  });
});

describe('personal profiles', () => {
  it('shows a visitor only the profile and repository tabs with a neutral icon', () => {
    live.data = { owner: { slug: 'maya', name: 'Maya Chen', kind: 'user', avatarUrl: null }, repositories: [repo('public-app')] };
    const out = html(); expect(textOf(out)).toContain('@maya'); expect(out).toContain('aria-label="Profile"');
    expect(out).toContain('href="/maya?tab=repositories"'); expect(textOf(out)).not.toMatch(/Teams|People|Settings|New repository/);
    expect(out).not.toContain('<img');
  });
  it('shows private repositories and creation to the person with no organization management', () => {
    user = { id: 'maya', email: 'maya@example.com', name: 'Maya Chen', username: 'maya' };
    live.data = { owner: { slug: 'maya', name: 'Maya Chen', kind: 'user', avatarUrl: '/api/owners/maya/avatar' }, repositories: [repo('private-app', 'private')] };
    const out = html(); expect(textOf(out)).toContain('Private'); expect(textOf(out)).toContain('New repository');
    expect(out).toContain('src="/api/owners/maya/avatar"'); expect(textOf(out)).not.toMatch(/Teams|People|Settings|maya@example.com/);
  });
  it('opens the personal repository search tab and rejects organization management routes', () => {
    live.data = { owner: { slug: 'maya', name: 'Maya', kind: 'user' }, repositories: [] };
    route.query.set('tab', 'repositories'); expect(html()).toContain('Find a repository');
    route = { ...route, screen: 'organization', sub: 'people' }; expect(textOf(html())).toContain('Page not found');
  });
});
