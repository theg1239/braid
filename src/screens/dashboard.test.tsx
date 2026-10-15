import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { Account } from '../../shared/account';
import type { ChangeSummary } from '../../shared/types';
import type { InboxData, InboxItem } from '../dashboard/inbox';

vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ account }) }));
vi.mock('../account/ClaimOwner', () => ({ ClaimOwner: () => <button>Claim account</button> }));
vi.mock('../dashboard/Feed', () => ({ Posts: () => null, Stories: () => null, usePublicRepositories: () => ({}) }));
vi.mock('../lib/live', () => ({ useLive: vi.fn() }));
vi.mock('../lib/api', () => ({ request: vi.fn() }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T12:00:00Z') }));
vi.mock('../lib/router', () => ({
  EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' },
  addressPath: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`,
  paths: { repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`, owner: (slug: string) => `/${slug}`, newRepository: () => '/new', explore: () => '/explore' },
}));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => <a href={href} className={className}>{children}</a> }));

import { useLive } from '../lib/live';
import { DashboardScreen } from './DashboardScreen';

const account: Account = {
  user: { id: 'github:1', email: 'maya@example.com', name: 'Maya Chen' }, provider: 'github', signupEnabled: true,
  methods: { github: true, email: true, passkeys: true },
  organizations: [{ id: 't1', slug: 'acme', name: 'Acme', role: 'owner', workspaces: [
    { id: 'w1', organizationId: 't1', slug: 'relay', name: 'Relay', visibility: 'private', createdAt: '2026-10-01T12:00:00Z' },
    { id: 'w2', organizationId: 't1', slug: 'api', name: 'API', visibility: 'public', createdAt: '2026-10-01T12:00:00Z' },
  ] }],
};
const item = (number: number, status: ChangeSummary['status'], repo = 0): InboxItem => ({
  team: account.organizations[0], workspace: account.organizations[0].workspaces[repo], address: { owner: 'acme', repo: account.organizations[0].workspaces[repo].slug },
  change: { id: String(number), number, title: `Pull request ${number}`, status,
    author: { id: 'agent:1', kind: 'agent', name: 'Claude Opus 5.5', owner: { id: 'user:github:1', name: 'Maya Chen', github: 'maya-chen' } },
    revision: 1, files: 1, additions: 2, deletions: 1, createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T11:55:00Z' },
});
const data = (): InboxData => ({ items: [item(1, 'attention'), item(2, 'revise', 1), item(3, 'queued'), item(4, 'landing', 1), item(5, 'landed')], open: { w1: 2, w2: 2 }, unavailable: [] });
const live = (value: InboxData | null, loading = false) => ({ data: value, loading, refreshing: false, error: null, errorStatus: null, updatedAt: null, refresh: vi.fn() });
const html = () => renderToStaticMarkup(<DashboardScreen />);
beforeEach(() => { account.user!.username = undefined; vi.mocked(useLive).mockReturnValue(live(data())); });

describe('Dashboard inbox rendering', () => {
  it('keeps the optional claim control in the header, without a reserved gap above the inbox', () => {
    account.user!.username = 'maya';
    const out = html();
    expect(out.indexOf('Claim account')).toBeLessThan(out.indexOf('</header>'));
    expect(out).toContain('class="dash__main"><section');
  });

  it('renders the four sections with counts in action order, plus the repositories', () => {
    const out = html();
    expect(textOf(out)).toMatch(/Needs your review 1.*Returned to you 1.*Merging 2.*Recently merged 1.*Last 24 hours.*Repositories 2/);
    for (const key of ['review', 'returned', 'merging', 'merged']) expect(out).toContain(`aria-labelledby="inbox-${key}"`);
    expect(out.match(/href="\/new"/g)).toHaveLength(1);
  });

  it('keeps title, repository, number and model for owner in each row main, with time', () => {
    const out = html();
    const rows = out.match(/<li class="pr"[\s\S]*?<\/li>/g)!;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatch(/class="pr__main"[\s\S]*class="pr__title"[\s\S]*Pull request/);
      expect(row).toMatch(/class="pr__repo">acme\/(relay|api) <span class="pr__num">#\d/);
      expect(row).toContain('class="dash__author">Claude Opus 5.5 for @maya-chen');
      expect(row).toContain('dateTime="2026-10-12T11:55:00Z"');
      expect(textOf(row)).toContain('5m ago');
      expect(row).not.toMatch(/hidden|aria-hidden="true"[^>]*class="pr__main"/);
    }
    expect(out).toContain('href="/acme/api/pull/2"');
  });

  it('names the state only where the section does not: queued against merging', () => {
    const out = html();
    expect(out.match(/class="dash__state"/g)).toHaveLength(2);
    expect(textOf(out)).toContain('Queued to merge');
    expect(textOf(out)).not.toContain('Changes requested');
  });

  it('shows the reason label once and visibly labels simulated authors', () => {
    const value = data();
    value.items[0].change.label = 'Choice required';
    value.items[4].change.author.kind = 'simulated';
    vi.mocked(useLive).mockReturnValue(live(value));
    const out = html();
    expect(out.match(/Choice required/g)).toHaveLength(1);
    expect(textOf(out)).toContain('Simulated for @maya-chen');
    expect(out.match(/simulated/gi)).toHaveLength(1);
  });

  it('shows a loading state without zero counts or an empty-inbox claim', () => {
    vi.mocked(useLive).mockReturnValue(live(null, true));
    const out = html();
    expect(out).toContain('aria-busy="true"');
    expect(textOf(out)).not.toContain('Needs your review 0');
    expect(textOf(out)).not.toContain('No pull requests need your review');
    expect(textOf(out)).not.toContain('Recently merged');
    expect(out).toContain('Loading inbox');
  });

  it('gives an empty inbox one calm line, with no empty groups', () => {
    vi.mocked(useLive).mockReturnValue(live({ items: [], open: {}, unavailable: [] }));
    const out = html();
    expect(textOf(out)).toContain('You’re all caught up.');
    expect(out).not.toContain('aria-labelledby="inbox-');
    expect(out.match(/class="dash__calm"/g)).toHaveLength(1);
  });

  it('drops empty groups when other work is present', () => {
    vi.mocked(useLive).mockReturnValue(live({ items: [item(1, 'attention')], open: {}, unavailable: [] }));
    const out = textOf(html());
    expect(out).toContain('Needs your review 1');
    expect(out).not.toMatch(/Returned to you|Merging|Recently merged|all caught up/);
  });

  it('does not claim an empty inbox when a repository could not be read', () => {
    vi.mocked(useLive).mockReturnValue(live({ items: [], open: {}, unavailable: [item(1, 'attention')] }));
    expect(textOf(html())).not.toContain('all caught up');
  });

  it('keeps loaded work beside an explicit failed-repository link and retry', () => {
    const value = data();
    value.unavailable = [value.items[1]];
    vi.mocked(useLive).mockReturnValue(live(value));
    const out = html();
    expect(out).toContain('role="alert"');
    expect(out).toContain('href="/acme/api/pulls"');
    expect(textOf(out)).toContain('Try again');
    expect(textOf(out)).toContain('Pull request 1');
  });

  it('counts the whole review section and scrolls it in place, with no Show more', () => {
    vi.mocked(useLive).mockReturnValue(live({ items: Array.from({ length: 11 }, (_, i) => item(i, 'attention')), open: { w1: 11 }, unavailable: [] }));
    const out = html();
    expect(textOf(out)).toContain('Needs your review 11');
    expect(out.match(/<li class="pr"/g)).toHaveLength(11);
    expect(out).toMatch(/class="scroll-area__viewport" style="max-height:407px" tabindex="0" role="region" aria-label="Needs your review"/);
    expect(textOf(out)).not.toContain('Show more');
  });

  it('shows when to retry a rate-limited inbox without claiming it is empty', () => {
    const retryMessage = 'Too many requests. Try again after 6:30:00 PM.';
    vi.mocked(useLive).mockReturnValue(live({ items: [], open: {}, unavailable: [item(1, 'attention')], retryMessage }));
    const out = textOf(html());
    expect(out).toContain(retryMessage);
    expect(out).not.toMatch(/all caught up|429|Loading/);
  });

  it('keys cached inbox data by viewer, repository address and role', () => {
    html();
    const key = vi.mocked(useLive).mock.lastCall![0];
    expect(key).toContain('github:1');
    expect(key).toContain('owner');
    expect(key).toContain('relay');
    expect(key).toContain('api');
  });
});
