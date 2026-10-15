import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { RepositorySearch } from '../../shared/search';
import { SearchScreen } from './SearchScreen';
import { CodeSearch } from '../components/code/CodeSearch';

const state = vi.hoisted(() => ({
  query: new URLSearchParams(), data: null as RepositorySearch | null,
  loading: false, error: null as string | null, read: vi.fn(),
}));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay', name: 'Relay', head: 'a'.repeat(40), branch: 'main' } }) }));
vi.mock('../lib/live', () => ({ useLive: (key: string | null, read: () => unknown) => { state.read(key, read); return { data: state.data, error: state.error, loading: state.loading, refresh: vi.fn() }; } }));
vi.mock('../lib/api', () => ({ api: { search: vi.fn() } }));
vi.mock('../lib/router', () => ({
  useRoute: () => ({ query: state.query }), navigate: vi.fn(),
  paths: { search: () => '/example/relay/search', code: (path: string, options: { ref: string }) => `/example/relay/blob/${options.ref}/${path.split('/').map(encodeURIComponent).join('/')}` },
}));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

const html = () => renderToStaticMarkup(<SearchScreen />);
const result = (): RepositorySearch => ({ ref: 'b'.repeat(40), files: [], results: [], matchCount: 0, truncated: false });
beforeEach(() => { state.query = new URLSearchParams({ q: 'delivery' }); state.data = null; state.error = null; state.loading = false; state.read.mockClear(); });

describe('repository code search rendering', () => {
  it('prefills the query and renders filenames before grouped code, highlighting literal text with line numbers', () => {
    state.data = { ...result(), matchCount: 2, files: [{ path: 'src/delivery.ts', highlights: [{ start: 4, end: 12 }] }], results: [{ path: 'src/delivery.ts', matches: [
      { line: 7, content: 'const delivery = "Delivery";', highlights: [{ start: 6, end: 14 }, { start: 18, end: 26 }] },
    ] }] };
    const out = html();
    expect(out).toContain('value="delivery"');
    expect(out.indexOf('id="search-files-heading"')).toBeLessThan(out.indexOf('id="search-code-heading"'));
    expect(out).toContain('src/<mark>delivery</mark>.ts');
    expect(out).toContain('<mark>Delivery</mark>');
    expect(textOf(out)).toContain('2 code matches in 1 file · 1 filename match');
    expect(out).toContain('aria-label="src/delivery.ts, line 7"');
    expect(out).toContain(`href="/example/relay/blob/${state.data.ref}/src/delivery.ts"`);
    expect(out).toContain(`href="/example/relay/blob/${state.data.ref}/src/delivery.ts#L7"`);
    expect(textOf(out)).not.toMatch(/\d+\s*(?:ms|seconds?)\b/);
    expect(out).not.toMatch(/status-dot|avatar|sparkle/i);
  });

  it('uses the URL branch and query for its request', async () => {
    state.query = new URLSearchParams({ q: 'a.[b]', ref: 'feature/search' });
    const out = html();
    expect(textOf(out)).toContain('feature/search');
    expect(out).toContain('value="a.[b]"');
    state.read.mock.calls[0][1]();
    const { api } = await import('../lib/api');
    expect(api.search).toHaveBeenCalledWith('a.[b]', 'feature/search');
  });

  it('does not request an empty query and distinguishes it from no matches', () => {
    state.query = new URLSearchParams();
    expect(textOf(html())).toContain('Find files and code in this repository.');
    expect(state.read.mock.calls[0][0]).toBeNull();
    state.query.set('q', 'nothing'); state.data = result();
    const out = html();
    expect(textOf(out)).toContain('No results found');
    expect(textOf(out)).not.toContain('0 code matches in 0 files');
  });

  it('shows accessible loading, error with retry, and limited results states', () => {
    state.loading = true;
    expect(html()).toContain('aria-label="Searching repository"');
    state.loading = false; state.error = 'Repository revision not found.';
    const failed = html();
    expect(failed).toContain('role="alert"');
    expect(textOf(failed)).toContain('Repository revision not found.');
    expect(textOf(failed)).toContain('Try again');
    state.error = null; state.data = { ...result(), truncated: true };
    expect(textOf(html())).toContain('Results limited');
  });

  it('escapes repository HTML and keeps special characters safe in file links', () => {
    state.data = { ...result(), matchCount: 1, results: [{ path: 'src/<tag> #1.ts', matches: [{ line: 1, content: '<script>alert(1)</script>', highlights: [{ start: 1, end: 7 }] }] }] };
    const out = html();
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;<mark>script</mark>&gt;');
    expect(out).toContain('/src/%3Ctag%3E%20%231.ts');
  });

  it('offers a code search entry with the slash shortcut beside the file finder', () => {
    const out = renderToStaticMarkup(<CodeSearch gitRef="feature/search" />);
    expect(out).toContain('role="search"');
    expect(out).toContain('type="search"');
    expect(out).toContain('aria-label="Search this repository"');
    expect(textOf(out)).toContain('/');
  });
});
