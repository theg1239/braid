import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf } from '../test/fixtures';
import type { CommitDetail, CommitDiff, CommitFile } from '../../shared/history';
import { CommitFileDiff, CommitScreen } from './CommitScreen';

const state = vi.hoisted(() => ({
  data: null as CommitDetail | CommitDiff | null,
  error: null as string | null,
  read: vi.fn(),
}));
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay', name: 'Relay', branch: 'main' } }) }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-12T15:00:00Z') }));
vi.mock('../lib/live', () => ({ useLive: (key: string, read: () => unknown) => { state.read(key, read); return { data: state.data, error: state.error, loading: !state.data && !state.error, refreshing: false, refresh: vi.fn() }; } }));
vi.mock('../lib/api', () => ({ api: { commit: vi.fn(), commitDiff: vi.fn() } }));
vi.mock('../lib/router', () => ({
  useRoute: () => ({ id: 'a'.repeat(40) }),
  paths: { commit: (sha: string) => `/commit/${sha}`, compare: (base: string, head: string) => `/compare/${base}...${head}`, pull: (number: number) => `/pull/${number}`, code: (path: string, options: { ref: string }) => path ? `/blob/${options.ref}/${path}` : `/tree/${options.ref}` },
}));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../components/code', () => ({
  useDiffStyle: () => 'unified', setDiffStyle: vi.fn(),
  isProse: (path: string) => /\.(md|txt)$/.test(path),
  CodeLoading: ({ label }: { label: string }) => <div role="status">{label}</div>,
  DiffView: ({ path, before, after, virtualized }: { path: string; before: string | null; after: string | null; virtualized: boolean }) => <div data-diff={path} data-virtualized={virtualized}><pre>{before}</pre><pre>{after}</pre></div>,
}));

const file: CommitFile = { path: 'src/retry.ts', status: 'modified', additions: 1, deletions: 1, binary: false, tooLarge: false, beforeMode: '100644', afterMode: '100644' };
const detail = (): CommitDetail => ({ hash: 'a'.repeat(40), title: 'Limit retries', message: 'Limit retries\n\nStop after three attempts.', at: '2026-10-12T10:00:00Z', parents: ['b'.repeat(40)], pullRequest: 12,
  author: { kind: 'agent', id: 'agent:1', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', owner: { name: 'Maya', github: 'maya-chen' } }, files: [file], filesTruncated: false, parentUnavailable: false });
const html = () => renderToStaticMarkup(<CommitScreen />);
beforeEach(() => { state.data = null; state.error = null; state.read.mockClear(); });

describe('commit rendering', () => {
  it('keeps a bot name in commit details without an ownership byline', () => {
    state.data = { ...detail(), author: { kind: 'bot', id: 'renovate', name: 'Renovate', tool: 'renovate[bot]', owner: { name: 'Maya', github: 'maya-chen' } } };
    expect(html()).toContain('data-kind="bot"');
    expect(textOf(html())).toContain('Renovate');
    expect(textOf(html())).not.toMatch(/for @|maya-chen/);
  });

  it('shows full metadata, copy hash, parent, pull request and Browse files links', async () => {
    state.data = detail();
    const out = html();
    expect(textOf(out)).toContain('Limit retries');
    expect(textOf(out)).toContain('Stop after three attempts.');
    expect(textOf(out)).toContain('Claude Opus 5.5 for @maya-chen');
    expect(textOf(out)).toContain('committed 5h ago');
    expect(out).toContain('Copy commit hash');
    expect(out).toContain('aaaaaaa');
    expect(out).toContain(`href="/commit/${'b'.repeat(40)}"`);
    expect(out).toContain('href="/pull/12"');
    expect(out).toContain(`href="/tree/${'a'.repeat(40)}"`);
    expect(out).toContain(`href="/compare/${'b'.repeat(40)}...${'a'.repeat(40)}"`);
    expect(textOf(out)).toContain('Compare with previous commit');
    expect(out).not.toMatch(/avatar|sparkle|status-dot/i);
    const { api } = await import('../lib/api');
    state.read.mock.calls[0][1]();
    expect(api.commit).toHaveBeenCalledWith('a'.repeat(40));
  });

  it('collapses long bodies while keeping the complete message available', () => {
    state.data = { ...detail(), message: `Limit retries\n\n${'Keep the original message.\n'.repeat(30)}` };
    const out = html();
    expect(out).toContain('<details class="commit-message">');
    expect(out).not.toContain('<details class="commit-message" open');
    expect(out.match(/Keep the original message\./g)).toHaveLength(30);
  });

  it('shows stats and collapsible sections without repeating a single file or fetching offscreen diffs', () => {
    state.data = detail();
    const out = html();
    expect(textOf(out)).toContain('1 file changed');
    expect(out).not.toContain('aria-label="Changed files"');
    expect(out).not.toContain('href="#commit-file-0"');
    expect(out).toContain('Collapse src/retry.ts');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('Unified');
    expect(out).toContain('Split');
    expect(out).not.toContain('data-diff=');
    expect(out).not.toContain('role="status"');
    expect(out).toContain('class="commit-file__body" style="min-height:496px"></div>');
    expect(state.read).toHaveBeenCalledTimes(1);
  });

  it('reserves every added or deleted line without mounting distant diffs', () => {
    state.data = { ...detail(), files: [
      { ...file, path: 'decision.json', status: 'added', additions: 250, deletions: 0 },
      { ...file, path: 'removed.json', status: 'deleted', additions: 0, deletions: 300 },
    ] };
    const out = html();
    expect(out).toContain('min-height:5016px');
    expect(out).toContain('min-height:6016px');
    expect(out).not.toContain('data-diff=');
    expect(out).not.toContain('role="status"');
    expect(state.read).toHaveBeenCalledTimes(1);
  });

  it('reserves wrapped prose before fetching its contents', () => {
    state.data = { ...detail(), files: [{ ...file, path: 'README.md', status: 'added', additions: 1, deletions: 0, textColumns: 8_000 }] };
    const out = html();
    const height = Number(/min-height:(\d+)px/.exec(out)?.[1]);
    expect(height).toBeGreaterThan(8_000);
    expect(out).not.toContain('data-diff=');
    expect(state.read).toHaveBeenCalledTimes(1);
  });

  it('provides file-list anchors for commits with several files', () => {
    state.data = { ...detail(), files: [file, { ...file, path: 'src/other.ts' }] };
    const out = html();
    expect(out).toContain('aria-label="Changed files"');
    expect(out).toContain('href="#commit-file-0"');
    expect(out).toContain('href="#commit-file-1"');
  });

  it('distinguishes root, empty and unavailable-parent commits', () => {
    state.data = { ...detail(), parents: [], files: [] };
    expect(textOf(html())).toContain('Initial commit');
    expect(textOf(html())).toContain('No files changed');
    expect(textOf(html())).not.toContain('Compare with previous commit');
    state.data = { ...detail(), parentUnavailable: true, files: [] };
    expect(textOf(html())).toContain('Parent commit unavailable');
    expect(textOf(html())).not.toContain('No files changed');
    expect(textOf(html())).not.toContain('Compare with previous commit');
  });

  it('keeps an unavailable first parent as text and the commit’s files reachable', () => {
    state.data = { ...detail(), parentUnavailable: true, files: [] };
    const out = html();
    expect(out).not.toContain(`href="/commit/${'b'.repeat(40)}"`);
    expect(textOf(out)).toContain('bbbbbbb');
    expect(textOf(out)).toContain('not imported');
    expect(out).toContain(`href="/tree/${'a'.repeat(40)}"`);
    expect(textOf(out)).toContain('Limit retries');
    expect(out).toContain('Copy commit hash');
  });

  it('only suppresses the first parent when the import marks it unavailable', () => {
    state.data = { ...detail(), parents: ['b'.repeat(40), 'c'.repeat(40)], parentUnavailable: true, files: [] };
    const out = html();
    expect(out).not.toContain(`href="/commit/${'b'.repeat(40)}"`);
    expect(out).toContain(`href="/commit/${'c'.repeat(40)}"`);
  });

  it('shows every merge parent and labels simulated authors', () => {
    state.data = { ...detail(), parents: ['b'.repeat(40), 'c'.repeat(40)], author: { kind: 'simulated', id: 'sim:1', name: 'Simulated s001', model: 'simulated' } };
    const out = html();
    expect(out).toContain(`href="/commit/${'b'.repeat(40)}"`);
    expect(out).toContain(`href="/commit/${'c'.repeat(40)}"`);
    expect(textOf(out)).toContain('2 parents');
    expect(textOf(out)).toContain('Simulated');
  });

  it('labels incomplete file lists and unknown stats', () => {
    state.data = { ...detail(), filesTruncated: true, files: [{ ...file, additions: null, deletions: null, tooLarge: true }] };
    const out = html();
    expect(textOf(out)).toContain('Showing a partial diff.');
    expect(textOf(out)).toContain('Line counts exclude 1 file.');
    expect(textOf(out)).toContain('Large file');
  });

  it('shows loading and retryable errors without stale invented commit metadata', () => {
    expect(html()).toContain('aria-label="Loading commit"');
    state.error = 'Commit not found.';
    const out = html();
    expect(out).toContain('role="alert"');
    expect(textOf(out)).toContain('Commit not found.');
    expect(textOf(out)).toContain('Try again');
    expect(out).not.toContain('Browse files');
  });
});

describe('lazy commit file rendering', () => {
  const diffHtml = (input = file) => renderToStaticMarkup(<CommitFileDiff sha={'a'.repeat(40)} parent={'b'.repeat(40)} file={input} />);
  it('uses the existing diff viewer with both exact texts', async () => {
    state.data = { path: file.path, before: 'before\n', after: 'after\n', binary: false, tooLarge: false };
    const out = diffHtml();
    expect(out).toContain('data-diff="src/retry.ts"');
    expect(out).toContain('data-virtualized="false"');
    expect(out).toContain('before\n');
    expect(out).toContain('after\n');
    const { api } = await import('../lib/api');
    state.read.mock.calls[0][1]();
    expect(api.commitDiff).toHaveBeenCalledWith('a'.repeat(40), 'src/retry.ts');
  });

  it('shows binary and oversized files explicitly and links deletions to the parent', () => {
    state.data = { path: file.path, before: null, after: null, binary: true, tooLarge: false };
    expect(textOf(diffHtml())).toContain('Binary file');
    expect(diffHtml()).not.toContain('data-diff');
    state.data = { ...state.data, binary: false, tooLarge: true };
    expect(diffHtml({ ...file, status: 'deleted' })).toContain(`href="/blob/${'b'.repeat(40)}/src/retry.ts"`);
    expect(diffHtml()).toContain(`href="/blob/${'a'.repeat(40)}/src/retry.ts"`);
  });

  it('shows per-file loading and error states', () => {
    expect(textOf(diffHtml())).toContain('Loading changes');
    state.error = 'File is unavailable.';
    expect(textOf(diffHtml())).toContain('File is unavailable.');
    expect(textOf(diffHtml())).toContain('Try again');
  });
});
