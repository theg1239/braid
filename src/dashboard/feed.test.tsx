import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryListing } from '../../shared/account';
import { textOf } from '../test/fixtures';

const state = vi.hoisted(() => ({ live: { data: null as { items: RepositoryListing[]; nextCursor: string | null } | null, error: null as string | null, refreshing: false, refresh: () => Promise.resolve(null) } }));
vi.mock('../lib/live', () => ({ useLive: () => state.live }));
vi.mock('../lib/router', () => ({
  EXAMPLE_ADDRESS: { owner: 'example', repo: 'relay' },
  paths: { repo: (a: { owner: string; repo: string }) => `/${a.owner}/${a.repo}`, owner: (slug: string) => `/${slug}`, explore: () => '/explore' },
}));
vi.mock('../account/api', () => ({ accountApi: { repositories: vi.fn() } }));
vi.mock('../lib/api', () => ({ errorMessage: String }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import { Posts, Stories, usePublicRepositories } from './Feed';

function Feed({ now }: { now: number }) {
  const repos = usePublicRepositories();
  return <><Stories repos={repos} now={now} /><Posts repos={repos} now={now} empty="No other public repositories yet." /></>;
}

const now = Date.parse('2026-10-16T12:00:00Z');
const listing = (owner: string, repo: string, updatedAt: string, extra: Partial<RepositoryListing> = {}): RepositoryListing => ({ owner: { slug: owner, name: owner }, repo: { slug: repo, name: repo }, updatedAt, ...extra });
const render = () => renderToStaticMarkup(<Feed now={now} />);
beforeEach(() => { state.live = { data: null, error: null, refreshing: false, refresh: () => Promise.resolve(null) }; });

describe('dashboard feed', () => {
  it('keeps its layout while it reads', () => {
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="posts"');
  });
  it('rings only owners who pushed in the last day, once each, and links their faces to them', () => {
    state.live.data = { nextCursor: null, items: [
      listing('n8n-io', 'n8n', '2026-10-16T09:00:00Z', { owner: { slug: 'n8n-io', name: 'n8n', avatar: true } }),
      listing('n8n-io', 'docs', '2026-10-16T08:00:00Z'),
      listing('ventoy', 'Ventoy', '2026-10-10T08:00:00Z'),
    ] };
    const stories = render().match(/<ul class="stories".*?<\/ul>/)?.[0] ?? '';
    expect(stories.match(/class="story"/g)).toHaveLength(2);
    expect(stories).toMatch(/href="\/n8n-io" class="story" data-fresh="true"/);
    expect(stories).toMatch(/href="\/ventoy" class="story">/);
    expect(stories).toContain('src="/api/owners/n8n-io/avatar"');
  });
  it('shows the maintainers’ picture through Braid, the numbers, and the latest commit by its agent and owner', () => {
    state.live.data = { nextCursor: null, items: [listing('n8n-io', 'n8n', '2026-10-16T09:00:00Z', { description: 'Workflow automation', showcase: {
      cover: 'https://repository-images.githubusercontent.com/1/a', stars: 182_400, language: 'TypeScript',
      latest: { hash: 'a'.repeat(40), title: 'Fix queue retries', at: '2026-10-16T09:00:00Z', author: { kind: 'agent', id: 'x', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: { name: 'Maya Chen', github: 'maya-chen' } } },
    } })] };
    const html = render(), text = textOf(html);
    expect(html).toContain('src="/api/media?url=https%3A%2F%2Frepository-images.githubusercontent.com%2F1%2Fa"');
    expect(text).toContain('182.4K stars');
    expect(text).toContain('TypeScript');
    expect(text).toContain('Claude Opus 5.5 for @maya-chen Fix queue retries');
    expect(text).toContain('Workflow automation');
  });
  it('sets a repository without a picture in type, and never draws a stand-in face', () => {
    state.live.data = { nextCursor: null, items: [listing('ada', 'engine', '2026-10-16T09:00:00Z', { description: 'A small engine' })] };
    const html = render();
    expect(html).toContain('<span class="post__card-name">engine</span>');
    expect(html).not.toContain('/api/owners/ada/avatar');
    expect(textOf(html)).not.toMatch(/\bA\b(?! small)/);
  });
  it('leaves the recorded example to its own link and says so when nothing else is public', () => {
    state.live.data = { nextCursor: null, items: [listing('example', 'relay', '2026-10-16T09:00:00Z')] };
    expect(textOf(render())).toContain('No other public repositories yet.');
  });
});
