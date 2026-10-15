import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryTree } from '../../../shared/repository';
import { Listing } from './Listing';

const state = vi.hoisted(() => ({
  page: undefined as RepositoryTree | undefined, error: null as string | null, reads: [] as unknown[][], request: vi.fn(), load: null as null | ((...args: string[]) => Promise<unknown>),
  streaming: false, head: 'a'.repeat(40),
}));
vi.mock('../../lib/api', () => ({ changes: { touching: vi.fn() }, api: { treeCommits: (...args: unknown[]) => state.request(...args) } }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T12:00:00Z') }));
vi.mock('../../lib/live', () => ({ useLive: () => ({ data: {} }) }));
vi.mock('../../lib/palette', () => ({ openPalette: vi.fn() }));
vi.mock('../../lib/reads', () => ({ reader: (_key: unknown, load: typeof state.load) => { state.load = load; return {}; } }));
vi.mock('../../lib/resources', () => ({ useRead: (_source: unknown, args: unknown[]) => { state.reads.push(args); return { value: state.page, error: state.error, retry: () => {} }; } }));
vi.mock('../../lib/router', () => ({ paths: { commit: (hash: string) => `/example/relay/commit/${hash}`, agents: () => '/agents' } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../ui/ScreenSkeleton', () => ({ FileRowsSkeleton: () => <div>Files skeleton</div> }));
vi.mock('../ui/States', () => ({ ErrorPanel: () => <div>Error</div> }));
vi.mock('./branch', () => ({ useBranch: () => ({ gitRef: state.head, main: true, streaming: state.streaming }), useCodeHref: () => (path: string) => `/files/${path}` }));

const tree = (): RepositoryTree => ({ ref: 'b'.repeat(40), path: '', nextCursor: null, entries: [
  { name: 'src', path: 'src', kind: 'dir', hash: 'tree', mode: '40000' },
  { name: 'README.md', path: 'README.md', kind: 'file', hash: 'blob', mode: '100644' },
] });
const render = (page = tree()) => renderToStaticMarkup(<Listing path={page.path} tree={page} pending={false} error={null} more={async () => {}} retry={() => {}} />);
beforeEach(() => { state.page = undefined; state.error = null; state.reads.length = 0; state.streaming = false; state.request.mockReset(); });

describe('directory commit columns', () => {
  it('labels only unresolved rows after an explicit incomplete history result, and ignores stale completeness', () => {
    expect(render()).not.toContain('History not loaded');
    const page = tree(), lastCommit = { hash: 'c'.repeat(40), title: 'Explain retries', at: '2026-10-14T11:00:00Z' };
    state.page = { ...page, historyComplete: false, entries: [{ ...page.entries[0], lastCommit }, page.entries[1]] };
    const partial = render();
    expect(partial.match(/class="listing__unknown"/g)).toHaveLength(1);
    expect(partial).toContain('aria-label="History not loaded"');
    expect(partial).toContain(`href="/example/relay/commit/${lastCommit.hash}"`);
    expect(partial).toContain('href="/files/README.md"');
    expect(partial.match(/class="listing__commit"/g)).toHaveLength(2);
    state.page.ref = state.head;
    expect(render()).not.toContain('History not loaded');
  });

  it('says once, in the first row, that the commit details failed to load, with a retry, and keeps every file', () => {
    state.error = 'HTTP 503';
    const failed = render();
    expect(failed).toContain('href="/files/README.md"');
    expect(failed.match(/Couldn’t load commits/g)).toHaveLength(1);
    expect(failed.match(/<button[^>]*listing__retry[^>]*>Retry<\/button>/g)).toHaveLength(1);
    expect(failed.match(/class="listing__commit"/g)).toHaveLength(2);
  });

  it('renders filenames and reserved metadata cells immediately, then fills separate commit links and times', () => {
    const pending = render();
    expect(pending).toContain('README.md'); expect(pending).not.toContain('Files skeleton');
    expect(pending.match(/class="listing__commit"/g)).toHaveLength(2);
    expect(pending.match(/class="listing__time"/g)).toHaveLength(2);
    const lastCommit = { hash: 'c'.repeat(40), title: 'Explain retries', at: '2026-10-14T11:00:00.000Z' };
    state.page = { ...tree(), entries: tree().entries.map(entry => ({ ...entry, lastCommit })) };
    const loaded = render();
    expect(loaded).toContain(`href="/example/relay/commit/${lastCommit.hash}"`);
    expect(loaded).toContain('href="/files/README.md"');
    expect(loaded).toContain('<time'); expect(loaded).toContain('1h ago');
    expect(loaded.match(/class="listing__row listing__row--commits"/g)).toHaveLength(2);
    expect(loaded).not.toMatch(/<a[^>]*>(?:(?!<\/a>)[\s\S])*<a[ >]/);
  });

  it('loads metadata at the returned pinned tree through the scoped API and keeps pagination', async () => {
    const page = tree();
    page.entries = Array.from({ length: 201 }, (_, i) => ({ ...page.entries[1], name: `f${i}`, path: `f${i}` }));
    page.nextCursor = '400';
    expect(render(page)).toContain('Load more');
    expect(state.reads).toEqual([[page.ref, '', '0'], [page.ref, '', '200']]);
    await state.load!(page.ref, 'dir with space', '200');
    expect(state.request).toHaveBeenCalledWith(page.ref, 'dir with space', '200');
  });

  it('ignores stale metadata for another ref or directory and skips an unpinned import preview', () => {
    state.page = { ...tree(), ref: state.head, entries: tree().entries.map(entry => ({ ...entry, lastCommit: { hash: state.head, title: 'Stale', at: '2026-10-14T11:00:00Z' } })) };
    expect(render()).not.toContain('Stale');
    state.page.ref = tree().ref; state.page.path = 'other';
    expect(render()).not.toContain('Stale');
    state.streaming = true; render(); expect(state.reads.at(-1)).toBeNull();
  });
});
