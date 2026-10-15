import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { CommitPage } from '../../shared/history';
import { CommitsScreen } from './CommitsScreen';

const state = vi.hoisted(() => ({
  route: { ref: null as string | null, path: '', query: new URLSearchParams() },
  data: null as CommitPage | null,
  error: null as string | null,
  loading: false,
  read: vi.fn(),
}));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay', name: 'Relay', branch: 'main' } }) }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T15:00:00Z') }));
vi.mock('../lib/live', () => ({ useLive: (key: string, read: () => unknown) => { state.read(key, read); return { data: state.data, error: state.error, loading: state.loading, refreshing: false, refresh: async () => null }; } }));
vi.mock('../lib/api', () => ({ api: { commits: vi.fn() } }));
vi.mock('../lib/router', () => ({
  useRoute: () => state.route, navigate: vi.fn(), isPlainLeftClick: () => true, routeOf: vi.fn(),
  paths: { commits: (ref: string, path?: string) => `/commits/${encodeURIComponent(ref)}${path ? `/${path}` : ''}`, commit: (sha: string) => `/commit/${sha}`, pull: (number: number) => `/pull/${number}`, code: (_path: string, options: { ref: string }) => `/tree/${options.ref}` },
}));
vi.mock('../components/code/BranchMenu', () => ({ BranchMenu: ({ current }: { current: string }) => <button>{current}</button> }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

const commit = (hash: string, at: string, title: string) => ({ hash: hash.repeat(40), at, title, author: { kind: 'human' as const, id: hash, name: 'Maya Chen' } });
const html = () => renderToStaticMarkup(<CommitsScreen />);
beforeEach(() => {
  state.route = { ref: null, path: '', query: new URLSearchParams() };
  state.data = null;
  state.error = null;
  state.loading = false;
  state.read.mockClear();
});

describe('commit history rendering', () => {
  it('renders automation by its bot name even when a human co-author is known', () => {
    state.data = { ref: 'a'.repeat(40), path: '', nextCursor: null, items: [{
      ...commit('a', '2026-10-12T10:00:00Z', 'Bump dependencies'),
      author: { kind: 'bot', id: 'dependabot', name: 'Dependabot', tool: 'dependabot[bot]', owner: { name: 'Maya', github: 'maya-chen' } },
    }] };
    expect(html()).toContain('data-kind="bot"');
    expect(textOf(html())).toContain('Dependabot');
    expect(textOf(html())).not.toMatch(/for @|maya-chen/);
  });

  it('groups rows by day and shows agent ownership, a pull request and a copyable short hash', () => {
    state.data = { ref: 'a'.repeat(40), path: '', nextCursor: 'older', items: [
      { ...commit('a', '2026-10-12T10:00:00Z', 'Limit delivery retries'), author: { kind: 'agent', id: 'agent:1', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: { name: 'Maya', github: 'maya-chen' } }, pullRequest: 12 },
      commit('b', '2026-10-12T09:00:00Z', 'Improve the timeout'),
      commit('c', '2026-10-10T10:00:00Z', 'Start Relay'),
    ] };
    const out = html();
    expect(out.match(/<h2>/g)).toHaveLength(2);
    expect(textOf(out)).toContain('Commits on Oct 12');
    expect(textOf(out)).toContain('Claude Opus 5.5 for @maya-chen');
    expect(textOf(out)).toContain('Maya Chen');
    expect(textOf(out)).toContain('5h ago');
    expect(out).toContain('href="/pull/12"');
    // Each copy control carries its visible hash, so thirty rows get thirty names and "click aaaaaaa" works.
    expect(out).toContain('aria-label="Copy commit hash aaaaaaa"');
    expect(out).toContain('aaaaaaa');
    expect(out).toMatch(/disabled=""[^>]*><span[^>]*>Newer/);
    expect(out).not.toMatch(/disabled=""[^>]*><span[^>]*>Older/);
    expect(out).not.toMatch(/avatar|sparkle|status-dot/i);
  });

  it('uses the branch and path from the route, offers clearing the filter, and reads its own page', async () => {
    state.route = { ref: 'feature/login', path: 'src/login.ts', query: new URLSearchParams() };
    const out = html();
    expect(textOf(out)).toContain('feature/login');
    expect(textOf(out)).toContain('src/login.ts');
    expect(out).toContain('href="/commits/feature%2Flogin"');
    expect(out).toContain('Clear path filter');
    const { api } = await import('../lib/api');
    state.read.mock.calls[0][1]();
    expect(api.commits).toHaveBeenCalledWith('feature/login', 'src/login.ts', null);
  });

  it('shows loading, empty, sparse-page and retry states without invented history', () => {
    state.loading = true;
    const pending = html();
    expect(pending).toContain('aria-label="Loading commits"');
    expect(pending).not.toContain('Commit history pages');
    state.loading = false;
    state.data = { ref: 'a'.repeat(40), path: '', nextCursor: null, items: [] };
    expect(textOf(html())).toContain('No commits found');
    state.data.nextCursor = 'continue';
    expect(textOf(html())).toContain('No matching commits on this page');
    state.data = null;
    state.error = 'Repository revision not found.';
    const failed = html();
    expect(failed).toContain('role="alert"');
    expect(textOf(failed)).toContain('Repository revision not found.');
    expect(textOf(failed)).toContain('Try again');
  });

  it('labels simulated work and links an unmapped commit to its commit page', () => {
    state.data = { ref: 'a'.repeat(40), path: '', nextCursor: null, items: [{ ...commit('a', '2026-10-12T10:00:00Z', 'Add a recorded test'), author: { kind: 'simulated', id: 'sim:1', name: 'Simulated agent', model: 'simulated' } }] };
    const out = html();
    expect(textOf(out)).toContain('Simulated');
    expect(out).toContain(`href="/commit/${'a'.repeat(40)}"`);
    expect(out).not.toContain('Pull request #');
  });

  it('restores the shared page from its URL and preserves Newer and Older links after a reload', async () => {
    state.route = { ref: 'feature/login', path: 'src/login.ts', query: new URLSearchParams([['cursor', 'page+2='], ['cursor', 'page/3=']]) };
    state.data = { ref: 'a'.repeat(40), path: 'src/login.ts', nextCursor: 'page4', items: [] };
    const out = html();
    expect(out).toContain('href="/commits/feature%2Flogin/src/login.ts?cursor=page%2B2%3D"');
    expect(out).toContain('href="/commits/feature%2Flogin/src/login.ts?cursor=page%2B2%3D&amp;cursor=page%2F3%3D&amp;cursor=page4"');
    const { api } = await import('../lib/api');
    state.read.mock.calls[0][1]();
    expect(api.commits).toHaveBeenCalledWith('feature/login', 'src/login.ts', 'page/3=');
  });
});
