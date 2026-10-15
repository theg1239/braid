import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change } from '../../../shared/types';
import type { CommitPage } from '../../../shared/history';
import { missionFixture, textOf } from '../../test/fixtures';

const state = vi.hoisted(() => ({ snapshot: null as unknown, latest: null as unknown, full: null as unknown, tip: null as CommitPage | null, tipError: null as string | null, latestError: null as string | null, reads: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => state.snapshot }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T12:00:00Z') }));
vi.mock('../../lib/live', () => ({ useLive: (key: string | null, read: () => unknown) => {
  state.reads(key, read);
  return key === 'changes:list:latest' ? { data: state.latest, error: state.latestError } : key?.startsWith('commits:tip:') ? { data: state.tip, error: state.tipError } : { data: key ? state.full : null, error: null };
} }));
vi.mock('../../lib/router', () => ({ paths: {
  pull: (number: number, options?: { tab?: string }) => `/pull/${number}${options?.tab ? `/${options.tab}` : ''}`,
  commits: (ref: string) => `/commits/${ref}`, commit: (hash: string) => `/commit/${hash}`, task: (id: string) => `/tasks/${id}`,
} }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

import { LatestCommit } from './LatestCommit';

beforeEach(() => {
  const head = 'a'.repeat(40);
  state.snapshot = { project: { id: 'relay', name: 'Relay', branch: 'main', head }, missions: [] };
  state.full = {
    id: 'change-51', number: 51, title: 'Add delivery logging', status: 'landed', revision: 1,
    author: { id: 'agent', kind: 'agent', name: 'GPT-6 Astra' }, landedCommit: head,
    additions: 1, deletions: 0, createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z',
    intent: '', summary: '', rationale: '', baseCommit: 'b'.repeat(40), files: [], reviews: [], conflicts: [], overlaps: [], events: [],
    checks: [{ label: 'npm test', status: 'passed', source: 'braid', revision: 1, detail: 'Passed in Braid' }],
  } satisfies Change;
  state.latest = { items: [state.full], counts: { landed: 12 } };
  state.tip = null; state.tipError = null; state.latestError = null; state.reads.mockClear();
});

describe('latest commit controls', () => {
  it('offers the full commit hash through its short hash copy control', () => {
    const html = renderToStaticMarkup(<LatestCommit />);
    expect(html).toContain('Copy commit hash aaaaaaa');
    expect(html).toContain('>aaaaaaa<');
  });

  it('links the checks mark directly to the latest pull request checks', () => {
    const html = renderToStaticMarkup(<LatestCommit />);
    expect(html).toContain('href="/pull/51/checks"');
    expect(html).toContain('1 check passed');
  });

  it('does not attach an older pull request’s checks to a newer direct task commit', () => {
    state.snapshot = { project: { branch: 'main', head: 'c'.repeat(40) }, missions: [missionFixture({ status: 'merged', mergedAt: '2026-10-14T11:00:00Z', mergeCommit: 'c'.repeat(40) })] };
    const html = renderToStaticMarkup(<LatestCommit />);
    expect(html).toContain('Copy commit hash ccccccc');
    expect(html).not.toContain('/pull/51/checks');
  });

  it('falls back to the current head when a newer pull request has no stored commit hash', () => {
    state.latest = { items: [{ ...(state.full as Change), landedCommit: undefined }], counts: { landed: 12 } };
    state.snapshot = { project: { branch: 'main', head: 'a'.repeat(40) }, missions: [missionFixture({ status: 'merged', mergedAt: '2026-10-14T09:00:00Z', mergeCommit: 'c'.repeat(40) })] };
    const html = renderToStaticMarkup(<LatestCommit />);
    expect(html).toContain('Copy commit hash aaaaaaa');
    expect(html).not.toContain('Copy commit hash ccccccc');
  });

  it('shows the exact Git tip subject, author and date when there is no Braid merge', async () => {
    const head = 'a'.repeat(40);
    state.latest = { items: [], counts: { landed: 0 } };
    state.tip = { ref: head, path: '', items: [{ hash: head, title: 'upd', author: { kind: 'human', id: 'theg1239', name: 'theg1239' }, at: '2026-03-31T12:00:00Z' }], nextCursor: null };
    const html = renderToStaticMarkup(<LatestCommit />);
    expect(textOf(html)).toContain('upd');
    expect(textOf(html)).toContain('theg1239');
    expect(html).toContain('dateTime="2026-03-31T12:00:00Z"');
    expect(textOf(html).match(/aaaaaaa/g)).toHaveLength(1);
    expect(html).toContain(`href="/commit/${head}"`);
    expect(html).not.toContain('aria-busy="true"');
    const { api } = await import('../../lib/api');
    const read = vi.spyOn(api, 'commits').mockResolvedValue(state.tip);
    await state.reads.mock.calls.find(([key]) => key === `commits:tip:${head}`)![1]();
    expect(read).toHaveBeenCalledExactlyOnceWith(head, '', null, 1);
    read.mockRestore();
  });

  it('keeps the author, subject and time slots while Git metadata loads and if it fails', () => {
    state.latest = { items: [], counts: { landed: 0 } };
    const pending = renderToStaticMarkup(<LatestCommit />);
    expect(pending).toContain('Loading latest commit');
    for (const slot of ['commit-bar__author', 'commit-bar__subject', 'commit-bar__time']) expect(pending).toContain(slot);
    state.tipError = 'Could not load commits.';
    const failed = renderToStaticMarkup(<LatestCommit />);
    for (const slot of ['commit-bar__author', 'commit-bar__subject', 'commit-bar__time']) expect(failed).toContain(slot);
    expect(failed).not.toContain('aria-busy="true"');
    expect(textOf(failed)).toContain('View commit');
    expect(textOf(failed).match(/aaaaaaa/g)).toHaveLength(1);
  });

  it('can read Git metadata if the Braid merge list fails', () => {
    state.latest = null; state.latestError = 'Could not load pull requests.';
    renderToStaticMarkup(<LatestCommit />);
    expect(state.reads.mock.calls.some(([key]) => key === `commits:tip:${'a'.repeat(40)}`)).toBe(true);
  });

  it('does not request Git history for a known Braid pull request or direct task', () => {
    renderToStaticMarkup(<LatestCommit />);
    expect(state.reads.mock.calls.some(([key]) => key?.startsWith('commits:tip:'))).toBe(false);
    state.latest = { items: [], counts: { landed: 0 } };
    state.snapshot = { project: { branch: 'main', head: 'c'.repeat(40) }, missions: [missionFixture({ status: 'merged', mergeCommit: 'c'.repeat(40) })] };
    state.reads.mockClear();
    renderToStaticMarkup(<LatestCommit />);
    expect(state.reads.mock.calls.some(([key]) => key?.startsWith('commits:tip:'))).toBe(false);
  });
});
