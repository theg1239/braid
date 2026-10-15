import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { RepositoryPage } from '../../shared/repositories';
import type { Live } from '../lib/live';

vi.mock('../lib/router', () => ({
  EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' }, navigate: vi.fn(),
  useRoute: () => ({ query }),
  paths: { explore: () => '/explore', owner: (slug: string) => `/${slug}`, repo: (address: { owner: string; repo: string }) => `/${address.owner}/${address.repo}` },
}));
vi.mock('../lib/live', () => ({ useLive: () => live }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T10:00:00Z') }));
vi.mock('../lib/api', () => ({ errorMessage: (error: unknown) => String(error) }));
vi.mock('../account/api', () => ({ accountApi: { repositories: vi.fn() } }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, ...props }: { children: React.ReactNode; href: string; className?: string }) => <a {...props}>{children}</a> }));

import { ExploreScreen } from './ExploreScreen';

let query: URLSearchParams;
let live: Live<RepositoryPage>;
beforeEach(() => {
  query = new URLSearchParams();
  live = { data: { items: [{ owner: { slug: 'acmvit', name: 'ACM VIT' }, repo: { slug: 'examcooker', name: 'ExamCooker' }, description: 'Past papers', updatedAt: '2026-10-11T10:00:00Z' }], nextCursor: null }, error: null, errorStatus: null, loading: false, refreshing: false, updatedAt: 1, refresh: vi.fn() };
});
const html = () => renderToStaticMarkup(<ExploreScreen />);

describe('Explore filters', () => {
  it('has accessible search and sort controls, a labelled example, and no idle result count', () => {
    const out = html();
    expect(out).toContain('aria-label="Search repositories"');
    expect(out).toContain('aria-label="Sort repositories"');
    expect(textOf(out)).toContain('Recently updated');
    expect(out).toContain('href="/example/relay"');
    expect(textOf(out)).toContain('Recorded');
    expect(out).not.toContain('class="explore__count"');
  });

  it('restores shared search and sort from the URL and counts all matches across pages', () => {
    query = new URLSearchParams('q=past+papers&sort=name');
    live.data!.total = 42;
    live.data!.nextCursor = 'next-page';
    const out = html();
    expect(out).toContain('value="past papers"');
    expect(textOf(out)).toContain('Name');
    expect(textOf(out)).toContain('42 repositories');
    expect(textOf(out)).toContain('Load more');
    expect(out).not.toContain('href="/example/relay"');
    expect(out).toContain('href="/acmvit"');
    expect(out).toContain('href="/acmvit/examcooker"');
  });

  it('uses a singular count for one search result', () => {
    query.set('q', 'papers'); live.data!.total = 1;
    expect(textOf(html())).toContain('1 repository');
  });

  it('gives no matches one quiet line with a zero count and no Load more', () => {
    query.set('q', 'missing');
    live.data = { items: [], total: 0, nextCursor: null };
    const out = html();
    expect(textOf(out)).toContain('0 repositories');
    expect(textOf(out).match(/No repositories match your search\./g)).toHaveLength(1);
    expect(textOf(out)).not.toContain('Load more');
    expect(out).not.toContain('href="/example/relay"');
  });

  it('does not show zero results while loading or after a failed first request', () => {
    query.set('q', 'papers');
    live = { ...live, data: null, loading: true };
    expect(html()).toContain('aria-busy="true"');
    expect(textOf(html())).not.toContain('No repositories');
    live = { ...live, loading: false, error: 'Try again shortly.' };
    expect(textOf(html())).toContain('Couldn’t load repositories');
    expect(textOf(html())).not.toMatch(/No repositories|0 repositories/);
  });

  it('deduplicates overlapping rows and the pinned example', () => {
    live.data!.items.push(live.data!.items[0], { owner: { slug: 'example', name: 'Example' }, repo: { slug: 'relay', name: 'Relay' }, updatedAt: '2026-10-11T10:00:00Z' });
    const out = html();
    // Each post links its picture and its name, once per repository.
    expect(out.match(/<li class="post"/g)).toHaveLength(2);
    expect(out.match(/href="\/acmvit\/examcooker"/g)).toHaveLength(2);
    expect(out.match(/href="\/example\/relay"/g)).toHaveLength(2);
  });
});
