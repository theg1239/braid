import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangePage, ChangeSummary } from '../../shared/types';
import { ApiError, request } from '../lib/api';
import { groupInbox, readInbox, type InboxItem, type InboxRepository } from './inbox';
import { filterCount } from '../lib/lists';
import { inboxFavicon, setInboxBadge } from './badge';

vi.mock('../lib/live', () => ({ useLive: vi.fn() }));
vi.mock('../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/api')>(), request: vi.fn() }));
const NOW = Date.parse('2026-10-12T12:00:00Z');
const user = { id: 'github:1', email: 'maya@example.com', name: 'Maya' };
const workspace = { id: 'w1', organizationId: 't1', name: 'Relay', slug: 'relay', visibility: 'private' as const, createdAt: '2026-10-01T12:00:00Z' };
const repo: InboxRepository = { workspace, team: { id: 't1', slug: 'acme', name: 'Acme', role: 'owner', workspaces: [workspace] }, address: { owner: 'acme', repo: 'relay' } };
const counts = { open: 1, attention: 2, revise: 3, queued: 4, landing: 5, landed: 100, closed: 200 };
const change = (id: string, status: ChangeSummary['status'], ago = 60_000): ChangeSummary => ({
  id, number: Number(id), title: `Change ${id}`, status, author: { id: 'agent:1', kind: 'agent', name: 'GPT-6.1 Sol', owner: { id: `user:${user.id}`, name: 'Maya', github: 'maya' } },
  revision: 1, files: 1, additions: 3, deletions: 1, createdAt: new Date(NOW - ago).toISOString(), updatedAt: new Date(NOW - ago).toISOString(),
});
const item = (id: string, status: ChangeSummary['status'], ago?: number): InboxItem => ({ ...repo, change: change(id, status, ago) });
const page = (items: ChangeSummary[] = [], nextCursor: string | null = null): ChangePage => ({ items, nextCursor, counts });
const query = (path: string) => new URL(path, 'https://braid.example').searchParams;
beforeEach(() => { vi.mocked(request).mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Inbox grouping', () => {
  it('groups review, owned returned work, both merge states and recent merges across repositories', () => {
    const other = { ...item('2', 'revise'), workspace: { ...workspace, id: 'w2' }, address: { owner: 'acme', repo: 'api' } };
    const groups = groupInbox([item('1', 'attention'), other, item('3', 'queued'), item('4', 'landing'), item('5', 'landed'), item('6', 'closed'), item('7', 'open')], user, NOW);
    expect(groups.review.map(i => i.change.id)).toEqual(['1']);
    expect(groups.returned).toEqual([other]);
    expect(groups.merging.map(i => i.change.id)).toEqual(['4', '3']);
    expect(groups.merged.map(i => i.change.id)).toEqual(['5']);
  });

  it('uses the stable owner id, excluding other people, missing attribution, human and simulated authors', () => {
    const returned = item('1', 'revise');
    const authors: ChangeSummary['author'][] = [
      { ...returned.change.author, owner: { id: 'user:someone-else', name: 'Maya', github: 'maya' } },
      { ...returned.change.author, owner: { name: 'Maya', github: 'maya' } },
      { ...returned.change.author, kind: 'human' }, { ...returned.change.author, kind: 'simulated' },
      { ...returned.change.author, owner: undefined },
    ];
    expect(groupInbox(authors.map(author => ({ ...returned, change: { ...returned.change, author } })), user, NOW).returned).toEqual([]);
    expect(groupInbox([returned], null, NOW).returned).toEqual([]);
    expect(groupInbox([returned], user, NOW).returned).toEqual([returned]);
  });

  it('does not ask read-only team members to approve pull requests', () => {
    const review = item('1', 'attention');
    expect(groupInbox([{ ...review, team: { ...repo.team, role: 'member' } }], user, NOW).review).toEqual([]);
  });

  it('puts the oldest questions first and the newest merges first, within the last day', () => {
    const groups = groupInbox([item('1', 'attention'), item('2', 'attention', 120_000), item('3', 'revise'), item('4', 'revise', 180_000), item('5', 'landed'), item('6', 'landed', 86_400_000), item('7', 'landed', 86_400_001)], user, NOW);
    expect(groups.review.map(i => i.change.id)).toEqual(['2', '1']);
    expect(groups.returned.map(i => i.change.id)).toEqual(['4', '3']);
    expect(groups.merged.map(i => i.change.id)).toEqual(['5', '6']);
  });

  it('keeps recent activity compact and counts every open state for repository links', () => {
    const groups = groupInbox(Array.from({ length: 12 }, (_, i) => item(String(i), 'landed', i * 60_000)), user, NOW);
    expect(groups.merged).toHaveLength(8);
    expect(groups.merged[0].change.id).toBe('0');
    expect(filterCount('open', counts)).toBe(15);
  });
});

describe('Inbox reads', () => {
  it('reads the existing API with explicit repository scope and a deadline', async () => {
    vi.mocked(request).mockImplementation(async path => page([change('1', query(path).get('status') === 'landed' ? 'landed' : 'attention')]));
    const data = await readInbox([repo]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [path, options] of vi.mocked(request).mock.calls) {
      expect(path).toMatch(/^\/api\/changes\?/);
      expect(options?.headers).toEqual({ 'x-braid-workspace': 'w1' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(Number(query(path).get('limit'))).toBeLessThanOrEqual(100);
    }
    expect(data.open).toEqual({ w1: 15 });
    expect(data.unavailable).toEqual([]);
  });

  it('pages active work independently of merges, including older requests needing the person', async () => {
    vi.mocked(request).mockImplementation(async path => {
      const params = query(path);
      if (params.get('status') === 'landed') return page([change('3', 'landed')], 'older-merges');
      return params.has('cursor') ? page([change('2', 'attention', 2 * 86_400_000)]) : page([change('1', 'queued')], 'older/+=');
    });
    const data = await readInbox([repo]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.mocked(request).mock.calls.map(([path]) => query(path).get('cursor'))).toContain('older/+=');
    expect(groupInbox(data.items, user, NOW).review[0].change.id).toBe('2');
  });

  it('covers more than twelve repositories with at most four requests in flight', async () => {
    vi.useFakeTimers();
    let active = 0, peak = 0;
    vi.mocked(request).mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return page();
    });
    const repos = Array.from({ length: 15 }, (_, i) => ({ ...repo, workspace: { ...workspace, id: `w${i}` } }));
    const pending = readInbox(repos);
    await vi.runAllTimersAsync();
    const data = await pending;
    expect(peak).toBe(4);
    expect(request).toHaveBeenCalledTimes(30);
    expect(Object.keys(data.open)).toHaveLength(15);
  });

  it('reports failed repositories once while retaining successful reads and pages', async () => {
    vi.mocked(request).mockImplementation(async (path, options) => {
      if (new Headers(options?.headers).get('x-braid-workspace') === 'bad' || query(path).has('cursor')) throw new Error('Unavailable');
      return query(path).get('status') === 'landed' ? page([change('2', 'landed')]) : page([change('1', 'attention')], 'more');
    });
    const bad = { ...repo, workspace: { ...workspace, id: 'bad' } };
    const data = await readInbox([repo, bad]);
    expect(data.items).toHaveLength(2);
    expect(data.unavailable.map(r => r.workspace.id).sort()).toEqual(['bad', 'w1']);
  });

  it('deduplicates a pull request moving into merged while pages load, keeping repository identity', async () => {
    vi.mocked(request).mockImplementation(async path => page([change('1', query(path).get('status') === 'landed' ? 'landed' : 'landing', query(path).get('status') === 'landed' ? 1_000 : 2_000)]));
    const data = await readInbox([repo, { ...repo, workspace: { ...workspace, id: 'w2' } }]);
    expect(data.items).toHaveLength(2);
    expect(data.items.every(i => i.change.status === 'landed')).toBe(true);
  });

  it('retains the rate-limit retry time beside any successful repository reads', async () => {
    const message = 'Too many requests. Try again after 6:30:00 PM.';
    vi.mocked(request).mockImplementation(async path => {
      if (query(path).get('status') === 'landed') throw new ApiError(429, message, Date.now() + 60_000);
      return page([change('1', 'attention')]);
    });
    const data = await readInbox([repo]);
    expect(data.retryMessage).toBe(message);
    expect(data.items.map(item => item.change.id)).toEqual(['1']);
    expect(data.unavailable).toEqual([repo]);
  });

  it('makes no requests for an account with no repositories', async () => {
    expect(await readInbox([])).toEqual({ items: [], open: {}, unavailable: [] });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Inbox tab badges', () => {
  it('uses an SVG data URL with a number, retaining the mark and capping large badges', () => {
    const svg = decodeURIComponent(inboxFavicon(2));
    expect(svg).toMatch(/^data:image\/svg\+xml,<svg/);
    expect(svg).toContain('>2</text>');
    expect(svg).toContain('M7 9c7 0 7 7 14 7');
    expect(decodeURIComponent(inboxFavicon(120))).toContain('>99+</text>');
  });

  it('sets the title and icon, restoring both on zero and unmount', () => {
    const icon = { href: '/favicon.svg', getAttribute: () => icon.href, setAttribute: (_name: string, value: string) => { icon.href = value; } };
    vi.stubGlobal('document', { title: 'Braid', querySelector: () => icon });
    const clear = setInboxBadge(2);
    expect(document.title).toBe('(2) Braid');
    expect(icon.href).toBe(inboxFavicon(2));
    clear();
    const clearZero = setInboxBadge(0);
    expect(document.title).toBe('Braid');
    expect(icon.href).toBe('/favicon.svg');
    clearZero();
    setInboxBadge(120)();
    expect(document.title).toBe('Braid');
    expect(icon.href).toBe('/favicon.svg');
  });
});
