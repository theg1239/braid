import type { ReactNode } from 'react';
import { createHash } from 'node:crypto';
import { renderToReadableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitPage, RepositoryCommit } from '../../shared/history';
import type { WorkspaceSnapshot } from '../../shared/types';
import { textOf } from '../test/fixtures';

const state = vi.hoisted(() => ({
  snapshot: null as unknown as Partial<WorkspaceSnapshot>,
  mirror: null as { importing: boolean; startedAt?: string } | null,
  live: { data: null as CommitPage | null, error: null as string | null },
  keys: [] as (string | null)[],
}));
vi.hoisted(() => vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', origin: 'https://braid.test' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() }));
vi.mock('../store/workspace', () => ({ useSnapshot: () => state.snapshot }));
vi.mock('../account/mirrors', () => ({ useMirror: () => state.mirror }));
vi.mock('../lib/live', () => ({ useLive: (key: string | null, _fetch: unknown, interval: number) => { state.keys.push(key, String(interval)); return { ...state.live, refresh: vi.fn(), refreshing: false, loading: !state.live.data, errorStatus: null, updatedAt: null }; } }));
vi.mock('../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-15T10:00:42Z') }));
vi.mock('../lib/title', () => ({ useDocumentTitle: () => undefined }));
vi.mock('../components/ui/Link', () => ({ RouterLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
import { MirrorAgentsScreen } from './MirrorAgentsScreen';

const head = 'c'.repeat(40);
const hash = (value: string) => createHash('sha1').update(value).digest('hex');
const commit = (index: number, author: RepositoryCommit['author']): RepositoryCommit => ({ hash: hash(String(index)), title: `Commit ${index}`, at: '2026-10-15T09:00:00Z', author });
const agent = { kind: 'agent' as const, id: 'a', name: 'Claude Opus 5.5', model: 'claude-opus-5-5', tool: 'claude-code/2.4.1' };
const person = { kind: 'human' as const, id: 'p', name: 'Alex Morgan' };
const page = (count: number, nextCursor: string | null = null): CommitPage => ({ ref: head, path: '', nextCursor,
  items: Array.from({ length: count }, (_, index) => commit(index, index % 3 ? person : agent)) });
async function render() {
  const stream = await renderToReadableStream(<MirrorAgentsScreen />);
  await stream.allReady;
  return new Response(stream).text();
}

beforeEach(() => {
  state.keys.length = 0;
  state.mirror = null;
  state.live = { data: null, error: null };
});

describe('a mirror’s Agents tab', () => {
  it('keeps the table while the first copy runs, with how long it has run and no read yet', async () => {
    state.snapshot = { project: { head: '', name: 'workers-sdk' } as WorkspaceSnapshot['project'], importing: { name: 'workers-sdk', source: 'cloudflare/workers-sdk', startedAt: '2026-10-15T10:00:00Z' } };
    const html = await render();
    expect(textOf(html)).toContain('Authors Copying from GitHub 42s Author Commits Latest commit');
    expect(html).toContain('skeleton-line');
    expect(html).not.toMatch(/Commit history will appear|Show 300/);
    expect(state.keys[0]).toBeNull();
  });

  it('counts the commits that have arrived while the history copies, and reads them again', async () => {
    state.snapshot = { project: { head, name: 'workers-sdk' } as WorkspaceSnapshot['project'], branchCopy: { remaining: null } };
    state.live.data = page(12);
    const text = textOf(await render());
    expect(text).toContain('Authors 2 Newest 12 commits · copying history');
    expect(text).toMatch(/Claude Opus 5\.5 Claude Code 4 Commit 0 /);
    expect(text).toMatch(/People 8 Commit 1/);
    expect(text).not.toContain('Show 300');
    expect(state.keys).toEqual([`mirror-authors:${head}:history`, '10000']);
  });

  it('calls a full page of newest commits the last 100, and offers more once the copy is done', async () => {
    state.snapshot = { project: { head, name: 'workers-sdk' } as WorkspaceSnapshot['project'], branchCopy: { remaining: 3 } };
    state.live.data = page(100, 'next');
    expect(textOf(await render())).toContain('Last 100 commits Author');
    state.snapshot = { project: { head, name: 'workers-sdk' } as WorkspaceSnapshot['project'] };
    const done = textOf(await render());
    expect(done).toContain('Last 100 commits Show 300');
    expect(state.keys.slice(-2)).toEqual([`mirror-authors:${head}:done`, '300000']);
  });

  it('leaves out a People row without commits and says when one commit is all there is', async () => {
    state.snapshot = { project: { head, name: 'tiny' } as WorkspaceSnapshot['project'] };
    state.live.data = { ref: head, path: '', nextCursor: null, items: [commit(0, agent)] };
    const text = textOf(await render());
    expect(text).toContain('Authors 1 Last 1 commit');
    expect(text).not.toContain('People');
  });

  it('shows a failed read with a retry instead of an empty panel', async () => {
    state.snapshot = { project: { head, name: 'workers-sdk' } as WorkspaceSnapshot['project'] };
    state.live.error = 'Braid could not be reached.';
    const text = textOf(await render());
    expect(text).toContain('Couldn’t read commit history');
    expect(text).toContain('Braid could not be reached.');
  });
});
