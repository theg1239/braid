import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { ChangeAuthor, ChangeSummary } from '../../shared/types';
import { AuthorChip } from '../components/pulls/Bits';
import { PullRow } from '../components/pulls/PullRow';
import { BranchList, BranchesScreen } from './BranchesScreen';
import { CommitFileDiff, CommitScreen } from './CommitScreen';
import { CommitsScreen } from './CommitsScreen';
import { CompareScreen, ComparisonResult } from './CompareScreen';
import { SearchScreen } from './SearchScreen';

const state = vi.hoisted(() => ({ data: null as unknown, error: 'Repository revision not found.', errorStatus: 404 as number | null, read: vi.fn() }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay', name: 'Relay', branch: 'main', head: 'a'.repeat(40), branches: ['main'] } }) }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T12:00:00Z') }));
vi.mock('../lib/live', () => ({ useLive: (key: string, read: () => unknown) => { state.read(key, read); return { ...state, loading: false, refreshing: false, refresh: vi.fn() }; } }));
vi.mock('../lib/api', () => ({ api: { commit: vi.fn(), commits: vi.fn(), branches: vi.fn(), compare: vi.fn(), commitDiff: vi.fn(), search: vi.fn() } }));
vi.mock('../lib/router', () => ({ navigate: vi.fn(), useRoute: () => ({ id: '6d376a2', ref: 'main', path: '', query: new URLSearchParams({ q: 'delivery' }) }), paths: {
  code: (path: string) => `/blob/main/${path}`, commit: (sha: string) => `/commit/${sha}`, commits: () => '/commits/main', compare: () => '/compare/main...main', pull: (number: number) => `/pull/${number}`, search: () => '/search',
} }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../components/code/BranchMenu', () => ({ BranchMenu: () => <button>main</button> }));
vi.mock('../components/code', () => ({ CodeLoading: () => null, DiffView: () => null, useDiffStyle: () => 'unified', setDiffStyle: vi.fn() }));

const file = { path: 'README.md', status: 'modified' as const, additions: 1, deletions: 1, binary: false, tooLarge: false };
const screens = [
  { name: 'commit', view: <CommitScreen />, notFound: 'Commit not found' },
  { name: 'commits', view: <CommitsScreen />, notFound: 'Commit history not found' },
  { name: 'branches', view: <BranchesScreen />, notFound: 'Repository not found' },
  { name: 'compare', view: <CompareScreen />, notFound: 'Branch or commit not found' },
  { name: 'search', view: <SearchScreen />, notFound: 'Branch or commit not found' },
  { name: 'commit diff', view: <CommitFileDiff sha="6d376a2" file={file} />, notFound: 'Changes not found' },
];
beforeEach(() => { state.data = null; state.error = 'Repository revision not found.'; state.errorStatus = 404; state.read.mockClear(); });

describe.each(screens)('$name error states', ({ view, notFound }) => {
  it.each([400, 401, 403, 404, 409, 422, 499])('shows a non-retryable panel for HTTP %i', status => {
    state.errorStatus = status;
    const markup = renderToStaticMarkup(view);
    expect(textOf(markup)).toContain(status === 404 ? notFound : state.error);
    expect(textOf(markup)).not.toContain('Try again');
    expect(markup).not.toContain('role="alert"');
  });
  it.each([0, 429, 500, 502, 503])('keeps Try again for transient status %i', status => {
    state.errorStatus = status;
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain('role="alert"');
    expect(textOf(markup)).toContain('Try again');
  });
});

const author: ChangeAuthor = { id: 'sim:0031', kind: 'simulated', name: 'Simulated s0031', model: 'simulated', owner: { name: 'Maya Chen', github: 'maya-chen' } };
const time = '2026-10-12T10:00:00Z';
const commit = { hash: 'a'.repeat(40), title: 'Add tests', at: time, author };
const tip = { hash: commit.hash, title: commit.title, time, author };

describe('one simulated author label', () => {
  it.each([author, { ...author, model: undefined }, { ...author, kind: 'agent' as const }, { ...author, name: 'GPT-6.1 Sol' }])('names a simulated author by model rather than $name', input => {
    expect(textOf(renderToStaticMarkup(<AuthorChip author={input} />)).trim()).toBe('Simulated for @maya-chen');
  });
  it('uses the same single label in commit history, detail, branches and comparisons', () => {
    const assertAuthor = (markup: string) => {
      const text = textOf(markup);
      expect(text).toContain('Simulated for @maya-chen');
      expect(text.match(/Simulated/g)).toHaveLength(1);
      expect(text).not.toContain('s0031');
    };
    state.error = ''; state.errorStatus = null;
    state.data = { ref: commit.hash, path: '', nextCursor: null, items: [commit] };
    assertAuthor(renderToStaticMarkup(<CommitsScreen />));
    state.data = { ...commit, message: commit.title, parents: [], files: [], filesTruncated: false, parentUnavailable: false };
    assertAuthor(renderToStaticMarkup(<CommitScreen />));
    assertAuthor(renderToStaticMarkup(<BranchList data={{ defaultBranch: 'main', branches: [{ name: 'main', tip }] }} query="" now={Date.parse(time)} />));
    assertAuthor(renderToStaticMarkup(<ComparisonResult comparison={{ base: 'a'.repeat(40), head: 'b'.repeat(40), mergeBase: 'a'.repeat(40), status: 'ready', commits: [tip], files: [], commitsTruncated: false, filesTruncated: false }} now={Date.parse(time)} />));
  });
  it('does not put a second simulated badge beside a pull request title', () => {
    const change: ChangeSummary = { id: 'ch_test', number: 31, title: 'Add tests', status: 'landed', revision: 1, author: { ...author, name: 'Simulated' }, createdAt: time, updatedAt: time, files: 1, additions: 1, deletions: 0 };
    const markup = renderToStaticMarkup(<PullRow change={change} now={Date.parse(time)} />);
    expect(textOf(markup).match(/simulated/gi)).toHaveLength(1);
    expect(markup).not.toContain('data-tone="simulated"');
  });
  it('passes short route hashes unchanged to the commit API', async () => {
    renderToStaticMarkup(<CommitScreen />);
    state.read.mock.calls[0][1]();
    const { api } = await import('../lib/api');
    expect(api.commit).toHaveBeenCalledWith('6d376a2');
  });
});
