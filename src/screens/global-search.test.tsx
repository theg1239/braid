import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSearch } from '../../shared/search';
import { RESERVED_OWNERS } from '../../shared/routes';
import { isRepositoryScreen, parsePath, routeOf } from '../lib/address';
import { textOf } from '../test/fixtures';
import { GlobalSearchScreen } from './GlobalSearchScreen';

const state = vi.hoisted(() => ({ query: new URLSearchParams(), data: null as GlobalSearch | null, loading: false, error: null as string | null, user: null as { id: string } | null, read: vi.fn(), request: vi.fn() }));
vi.mock('../lib/live', () => ({ useLive: (key: string | null, read: () => unknown) => { state.read(key, read); return { data: state.data, loading: state.loading, error: state.error, refresh: vi.fn() }; } }));
vi.mock('../lib/api', () => ({ request: (...args: unknown[]) => state.request(...args) }));
vi.mock('../account/AccountProvider', () => ({ useAccount: () => ({ account: { user: state.user } }) }));
vi.mock('../lib/router', () => ({ useRoute: () => ({ query: state.query }), navigate: vi.fn(), paths: {
  globalSearch: (q?: string) => `/search${q ? `?q=${encodeURIComponent(q)}` : ''}`, repo: (repo: { owner: string; repo: string }) => `/${repo.owner}/${repo.repo}`,
} }));
vi.mock('../store/workspace', () => ({ useSnapshot: vi.fn() }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
const result = (): GlobalSearch => ({ repositories: [], searched: [], unavailable: [], matchCount: 0, truncated: false });
const html = () => renderToStaticMarkup(<GlobalSearchScreen />);
beforeEach(() => { state.query = new URLSearchParams({ q: 'needle' }); state.data = null; state.loading = false; state.error = null; state.user = null; state.read.mockClear(); state.request.mockClear(); });

describe('global code search', () => {
  it('reserves a site route beside addressed repository search', () => {
    expect(parsePath('/search')).toMatchObject({ screen: 'global-search', repo: null });
    expect(isRepositoryScreen('global-search')).toBe(false);
    expect(parsePath('/search/repository')).toMatchObject({ screen: 'not-found' });
    expect(parsePath('/acme/app/search')).toMatchObject({ screen: 'search', repo: { owner: 'acme', repo: 'app' } });
    expect(routeOf('/search?q=org%3Aacme', 'https://braid.test').query.get('q')).toBe('org:acme');
    expect(RESERVED_OWNERS.has('search')).toBe(true);
  });
  it('groups files by repository, deduplicates filename matches and pins line links to the searched commit', () => {
    const repository = { owner: 'acme', name: 'app', visibility: 'private' as const };
    state.data = { ...result(), searched: [repository], matchCount: 1, repositories: [{ ...repository, ref: 'b'.repeat(40), truncated: false, matchCount: 1,
      files: [{ path: 'src/needle.ts', highlights: [{ start: 4, end: 10 }] }], results: [{ path: 'src/needle.ts', matches: [{ line: 3, content: 'const needle = 1;', highlights: [{ start: 6, end: 12 }] }] }],
    }] };
    const out = html();
    expect(out).toContain('aria-label="acme/app"'); expect(textOf(out)).toContain('acme / app Private 1 file');
    expect(out.match(/<article/g)).toHaveLength(1); expect(out).toContain('src/<mark>needle</mark>.ts');
    expect(out).toContain(`href="/acme/app/blob/${'b'.repeat(40)}/src/needle.ts#L3"`);
    expect(textOf(out)).toContain('1 repository searched'); expect(out).not.toMatch(/status-dot|sparkle|gradient/i);
  });
  it('renders removable qualifier chips without dropping quoted phrases', () => {
    state.query.set('q', 'org:acme "a b" path:src/ language:typescript');
    const out = html();
    expect(out).toContain('aria-label="Remove org:acme"'); expect(out).toContain('aria-label="Remove path:src/"');
    expect(out).toContain('href="/search?q=org%3Aacme%20%22a%20b%22%20%20language%3Atypescript"');
  });
  it('offers an explicit recorded example to visitors and does not request empty queries', () => {
    state.query = new URLSearchParams();
    const out = html(); expect(textOf(out)).toContain('Use repo:, org: or user: to search public repositories.');
    expect(textOf(out)).toContain('Search the recorded example'); expect(state.read.mock.calls[0][0]).toBeNull();
  });
  it('uses a viewer-specific key and a site API request with no workspace header', () => {
    state.user = { id: 'alice' }; state.query.set('q', 'org:acme needle'); html();
    expect(state.read.mock.calls[0][0]).toContain('alice'); state.read.mock.calls[0][1]();
    expect(state.request).toHaveBeenCalledWith('/api/search?q=org%3Aacme+needle');
  });
  it('labels loading, unavailable repositories, truncation and recorded code', () => {
    state.loading = true; expect(html()).toContain('aria-label="Searching repositories"'); state.loading = false;
    const repo = { owner: 'example', name: 'relay', visibility: 'public' as const, recorded: true };
    state.data = { ...result(), truncated: true, searched: [repo], unavailable: [{ owner: 'acme', name: 'unavailable', visibility: 'public' }], repositories: [{ ...repo, ref: 'a'.repeat(40), files: [{ path: 'code.ts', highlights: [] }], results: [], matchCount: 0, truncated: true }] };
    const out = textOf(html()); expect(out).toContain('Recorded example'); expect(out).toContain('Results limited'); expect(out).toContain('1 repository unavailable');
  });
  it('hides stale results on errors and escapes code and paths', () => {
    state.data = { ...result(), repositories: [{ owner: 'acme', name: 'app', visibility: 'public', ref: 'a'.repeat(40), files: [], matchCount: 1, truncated: false, results: [{ path: '<a> #1.ts', matches: [{ line: 1, content: '<script>bad</script>', highlights: [{ start: 1, end: 7 }] }] }] }] };
    expect(html()).not.toContain('<script>'); expect(html()).toContain('%3Ca%3E%20%231.ts');
    state.error = 'Sign in again.'; const out = html(); expect(out).toContain('role="alert"'); expect(textOf(out)).toContain('Try again'); expect(out).not.toContain('acme / app');
  });
  it('keeps identical filenames under their respective repositories', () => {
    const repositories = ['web', 'api'].map(name => ({ owner: 'acme', name, visibility: 'private' as const, ref: 'b'.repeat(40), files: [{ path: 'src/index.ts', highlights: [] }], results: [], matchCount: 0, truncated: false }));
    state.data = { ...result(), repositories, searched: repositories };
    const out = html();
    expect(out.match(/<article/g)).toHaveLength(2);
    for (const name of ['web', 'api']) expect(out).toContain(`/acme/${name}/blob/${'b'.repeat(40)}/src/index.ts`);
    expect(textOf(out)).toContain('2 repositories searched');
  });
});
