import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { RepositoryBranches, RepositoryComparison } from '../../shared/compare';
import type { ChangePage, ChangeSummary } from '../../shared/types';

vi.mock('../lib/router', () => ({ paths: {
  code: (path: string, options: { ref: string }) => `/example/relay/tree/${encodeURIComponent(options.ref)}${path ? `/${path}` : ''}`,
  compare: (base: string, head: string) => `/example/relay/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  commits: (ref: string) => `/example/relay/commits/${encodeURIComponent(ref)}`,
  commit: (sha: string) => `/example/relay/commit/${sha}`,
  branches: () => '/example/relay/branches',
  pull: (number: number) => `/example/relay/pull/${number}`,
}, navigate: vi.fn(), useRoute: () => ({ id: 'main...feature/retries' }) }));
vi.mock('../lib/api', () => ({ api: { branches: vi.fn(), compare: vi.fn(), compareDiff: vi.fn() }, changes: { list: vi.fn() } }));
vi.mock('../lib/live', () => ({ useLive: vi.fn() }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T12:00:00Z') }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { name: 'Relay', branch: 'main', branches: ['main', 'feature/retries'] } }) }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../components/code', () => ({
  CodeLoading: ({ label }: { label: string }) => <div role="status">{label}</div>,
  DiffView: () => <div>Diff viewer</div>, prefetchCode: vi.fn(), setDiffStyle: vi.fn(), useDiffStyle: () => 'unified',
}));

import { useLive } from '../lib/live';
import { changes } from '../lib/api';
import { BranchesScreen, BranchList, branchPullRequests } from './BranchesScreen';
import { CompareScreen, ComparisonResult } from './CompareScreen';
import { BranchMenu } from '../components/code/BranchMenu';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const branches: RepositoryBranches = { defaultBranch: 'main', branches: [
  { name: 'main', tip: { hash: 'a'.repeat(40), title: 'Merge retries', time: '2026-10-12T11:55:00Z', author: { id: 'maya', kind: 'human', name: 'Maya Chen', owner: { name: 'Maya Chen', github: 'maya-chen' } } } },
  { name: 'feature/retries', tip: { hash: 'b'.repeat(40), title: 'Handle retry-after', time: '2026-10-12T11:58:00Z', author: { id: 'agent', kind: 'agent', name: 'Claude Opus 5.5', owner: { name: 'Maya Chen', github: 'maya-chen' } } } },
] };
const comparison: RepositoryComparison = { base: 'a'.repeat(40), head: 'b'.repeat(40), mergeBase: 'c'.repeat(40), status: 'ready', commits: [branches.branches[1].tip!], commitsTruncated: false, filesTruncated: false,
  files: [{ path: 'src/retries.ts', additions: 8, deletions: 2, added: false, deleted: false, binary: false, tooLarge: false, beforeMode: '100644', afterMode: '100644' }] };
const state = (data: unknown, error: string | null = null) => ({ data, error, errorStatus: error ? 500 : null, loading: !data && !error, refreshing: false, updatedAt: null, refresh: vi.fn() });
const pull: ChangeSummary = { id: 'ch_0123456789abc', number: 7, title: 'Handle retry-after', status: 'attention', author: branches.branches[1].tip!.author,
  revision: 1, files: 1, additions: 8, deletions: 2, createdAt: '2026-10-12T11:58:00Z', updatedAt: '2026-10-12T11:58:00Z', headCommit: comparison.head };
const page = (items: ChangeSummary[], nextCursor: string | null = null): ChangePage => ({ items, nextCursor, counts: { open: 0, revise: 0, attention: items.length, queued: 0, landing: 0, landed: 0, closed: 0 } });
function live(data: unknown, pulls: Map<string, ChangeSummary> | null = null, error: string | null = null) {
  vi.mocked(useLive).mockImplementation(key => key === 'repository:branch-pull-requests' ? state(pulls) : state(data, error));
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(changes.list).mockReset(); live(null); });

describe('branch pull request lookup', () => {
  it('follows all pages and matches only exact heads of open pull requests, newest first', async () => {
    vi.mocked(changes.list).mockResolvedValueOnce(page([
      { ...pull, number: 8, headCommit: undefined },
      { ...pull, number: 9, status: 'landed', headCommit: 'a'.repeat(40) },
      { ...pull, number: 10, status: 'closed', headCommit: 'c'.repeat(40) },
    ], 'older')).mockResolvedValueOnce(page([pull, { ...pull, number: 6 }]));
    const pulls = await branchPullRequests();
    expect(changes.list).toHaveBeenNthCalledWith(1, { status: 'active', limit: 100 });
    expect(changes.list).toHaveBeenNthCalledWith(2, { status: 'active', limit: 100, cursor: 'older' });
    expect([...pulls]).toEqual([[comparison.head, pull]]);
    expect(pulls.get(comparison.head.slice(0, 7))).toBeUndefined();
  });

  it.each(['open', 'revise', 'attention', 'queued', 'landing'] as const)('includes the %s state as an open pull request', async status => {
    vi.mocked(changes.list).mockResolvedValue(page([{ ...pull, status }]));
    expect((await branchPullRequests()).get(comparison.head)?.status).toBe(status);
  });

  it('propagates a denied read without returning a partial list', async () => {
    vi.mocked(changes.list).mockResolvedValueOnce(page([pull], 'older')).mockRejectedValueOnce(new Error('Repository not found.'));
    await expect(branchPullRequests()).rejects.toThrow('Repository not found.');
  });
});

describe('Branches', () => {
  it('separates the default branch and offers comparison only for other branches', () => {
    const html = renderToStaticMarkup(<BranchList data={branches} query="" now={NOW} />);
    expect(textOf(html)).toMatch(/Default branch.*main.*Other branches.*feature\/retries/);
    expect(textOf(html)).toContain('Claude Opus 5.5 for @maya-chen');
    expect(textOf(html)).toContain('Updated 2m ago');
    expect(html).toContain('href="/example/relay/tree/feature%2Fretries"');
    expect(html).toContain('href="/example/relay/commits/feature%2Fretries"');
    expect(html).toContain('href="/example/relay/compare/main...feature%2Fretries"');
    expect(html).not.toContain('/compare/main...main');
    expect(html.match(/aria-label="Compare /g)).toHaveLength(1);
    expect(html.match(/class="branches__compare-slot"/g)).toHaveLength(2);
  });

  it('uses the repository default rather than assuming main', () => {
    const html = renderToStaticMarkup(<BranchList data={{ ...branches, defaultBranch: 'feature/retries' }} query="" now={NOW} />);
    expect(html).toContain('href="/example/relay/compare/feature%2Fretries...main"');
    expect(html).not.toContain('/compare/feature%2Fretries...feature%2Fretries');
    expect(html.match(/aria-label="Compare /g)).toHaveLength(1);
  });

  it('filters slash refs without case sensitivity and handles no matches and empty repositories', () => {
    const html = textOf(renderToStaticMarkup(<BranchList data={branches} query="  FEATURE/  " now={NOW} />));
    expect(html).toContain('feature/retries');
    expect(html).not.toContain('Default branch');
    expect(textOf(renderToStaticMarkup(<BranchList data={branches} query="absent" now={NOW} />))).toContain('No matching branches');
    expect(textOf(renderToStaticMarkup(<BranchList data={{ ...branches, branches: [] }} query="" now={NOW} />))).toContain('No branches yet');
  });

  it('shows search only for a longer branch list', () => {
    live(branches);
    expect(renderToStaticMarkup(<BranchesScreen />)).not.toContain('placeholder="Find a branch"');
    live({ ...branches, branches: Array.from({ length: 10 }, (_, i) => ({ name: `topic/${i}`, tip: null })) });
    expect(renderToStaticMarkup(<BranchesScreen />)).toContain('placeholder="Find a branch"');
  });

  it('shows loading and recoverable errors', () => {
    expect(renderToStaticMarkup(<BranchesScreen />)).toContain('aria-label="Loading branches"');
    vi.mocked(useLive).mockReturnValue(state(null, 'Network unavailable'));
    const html = renderToStaticMarkup(<BranchesScreen />);
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('Network unavailable');
    expect(textOf(html)).toContain('Try again');
  });

  it('labels simulated authors', () => {
    const tip = { ...branches.branches[0].tip!, author: { id: 'sim:one', name: 'GPT-6.1 Sol', kind: 'simulated' as const } };
    const text = textOf(renderToStaticMarkup(<BranchList data={{ defaultBranch: 'main', branches: [{ name: 'main', tip }] }} query="" now={NOW} />));
    expect(text.match(/Simulated/g)).toHaveLength(1);
    expect(text).not.toContain('GPT-6.1 Sol');
  });

  it('links the matching branch tip to its open pull request and reserves both row slots before lookup', () => {
    live(branches);
    const loading = renderToStaticMarkup(<BranchesScreen />);
    expect(loading.match(/class="branches__pull-slot"/g)).toHaveLength(2);
    expect(loading).not.toContain('/pull/7');
    live(branches, new Map([[comparison.head, pull]]));
    const html = renderToStaticMarkup(<BranchesScreen />);
    expect(html.match(/class="branches__pull-slot"/g)).toHaveLength(2);
    expect(html.match(/href="\/example\/relay\/pull\/7"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Pull request #7 · Open: Handle retry-after"');
    expect(html).toContain('data-state="open"');
    expect(html.indexOf('/pull/7')).toBeGreaterThan(html.indexOf('Other branches'));
  });
});

describe('Compare', () => {
  it('keeps both refs switchable and offers a swap', () => {
    live(comparison);
    const html = renderToStaticMarkup(<CompareScreen />);
    expect(html).toContain('aria-label="base: main"');
    expect(html).toContain('aria-label="compare: feature/retries"');
    expect(html).toContain('aria-label="Swap base and compare"');
    expect(vi.mocked(useLive).mock.calls[0][0]).toContain('feature/retries');
  });

  it('links the resolved comparison head above commits, with the same reserved slot while loading', () => {
    live(comparison);
    const loading = renderToStaticMarkup(<CompareScreen />);
    expect(loading).toContain('<div class="compare__pull-request"></div>');
    live(comparison, new Map([[comparison.head, pull]]));
    const html = renderToStaticMarkup(<CompareScreen />);
    expect(textOf(html)).toContain('Pull request #7 · Open');
    expect(html).toContain('href="/example/relay/pull/7"');
    expect(html.indexOf('/pull/7')).toBeLessThan(html.indexOf('aria-label="Commits"'));
    expect(textOf(html)).not.toContain('Create pull request');
  });

  it('does not link a pull request belonging only to the base or before comparison resolves', () => {
    live(comparison, new Map([[comparison.base, { ...pull, headCommit: comparison.base }]]));
    expect(renderToStaticMarkup(<CompareScreen />)).not.toContain('/pull/7');
    live(null, new Map([[comparison.head, pull]]));
    expect(renderToStaticMarkup(<CompareScreen />)).not.toContain('/pull/7');
  });

  it('puts commits before the file list and reuses the unified/split controls', () => {
    const html = renderToStaticMarkup(<ComparisonResult comparison={comparison} now={NOW} />);
    expect(textOf(html)).toMatch(/1 commit.*Handle retry-after.*Claude Opus 5\.5 for @maya-chen.*Files changed.*src\/retries\.ts/);
    expect(textOf(html)).toContain('+8');
    expect(textOf(html)).toContain('−2');
    expect(textOf(html)).toContain('Unified');
    expect(textOf(html)).toContain('Split');
    expect(html).toContain('aria-expanded="true"');
  });

  it('draws the first three diffs at once and leaves the rest until they near the viewport', () => {
    const files = ['a', 'b', 'c', 'd'].map((name) => ({ ...comparison.files[0], path: `src/${name}.ts` }));
    vi.mocked(useLive).mockImplementation((key) => state(key?.startsWith('repository:diff:') ? { path: '', before: 'a\n', after: 'b\n', binary: false, tooLarge: false } : null));
    const html = renderToStaticMarkup(<ComparisonResult comparison={{ ...comparison, files }} now={NOW} />);
    expect(html.match(/Diff viewer/g)).toHaveLength(3);
    // public/boot.js reads the same three diffs with the comparison, under these keys' paths.
    expect(vi.mocked(useLive).mock.calls.map(([key]) => key)).toEqual(files.slice(0, 3).map((file) => `repository:diff:${comparison.mergeBase}:${comparison.head}:${file.path}`));
  });

  it.each([
    ['identical', 'Identical'], ['unrelated', 'No common history'], ['limited', 'History exceeds the comparison limit or is incomplete'], ['multiple-bases', 'Multiple merge bases'],
  ] as const)('shows the %s state without an empty diff list', (status, label) => {
    const html = textOf(renderToStaticMarkup(<ComparisonResult comparison={{ ...comparison, status, files: [], commits: [] }} now={NOW} />));
    expect(html).toContain(label);
    expect(html).not.toContain('Files changed');
  });

  it('labels partial lists and allows a branch with no commits ahead', () => {
    expect(textOf(renderToStaticMarkup(<ComparisonResult comparison={{ ...comparison, commitsTruncated: true, filesTruncated: true }} now={NOW} />))).toMatch(/1 commit shown.*More commits in.*commit history.*partial comparison/);
    expect(textOf(renderToStaticMarkup(<ComparisonResult comparison={{ ...comparison, commits: [], files: [] }} now={NOW} />))).toMatch(/No commits ahead.*No files changed/);
  });

  it('shows loading and retry without losing the ref controls', () => {
    expect(renderToStaticMarkup(<CompareScreen />)).toContain('aria-label="Comparing branches"');
    vi.mocked(useLive).mockReturnValue(state(null, 'Branch not found'));
    const html = renderToStaticMarkup(<CompareScreen />);
    expect(html).toContain('aria-label="base: main"');
    expect(textOf(html)).toContain('Branch not found');
    expect(textOf(html)).toContain('Try again');
  });

  it('renders the shared branch picker as an accessible control', () => {
    expect(renderToStaticMarkup(<BranchMenu current="main" />)).toContain('aria-label="Switch branch: main"');
  });
});
