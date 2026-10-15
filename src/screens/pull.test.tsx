import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change, ChangeGuide } from '../../shared/types';
import { textOf } from '../test/fixtures';

const state = vi.hoisted(() => ({ guide: null as ChangeGuide | null, labels: new Map<string, ReactNode>() }));
vi.hoisted(() => vi.stubGlobal('window', { location: { origin: 'https://braid.test' } }));
const change: Change = {
  id: 'ch-guide', number: 23, title: 'Add delivery headers', status: 'landed', revision: 1,
  author: { kind: 'agent', id: 'agent', name: 'Claude Opus 5.5' }, additions: 1, deletions: 0,
  createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z',
  intent: '', summary: '', rationale: '', baseCommit: 'a'.repeat(40),
  files: [], reviews: [], checks: [], conflicts: [], overlaps: [], events: [],
};
vi.mock('../store/workspace', () => ({ useSnapshot: () => ({ project: { id: 'relay', branch: 'main' }, missions: [], capabilities: { mode: 'example' } }), answerBlocker: () => 'Recorded example' }));
vi.mock('../lib/hooks', () => ({ useNow: () => 0, useCopy: () => [null, vi.fn()] }));
vi.mock('../lib/title', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../lib/live', () => ({ useLive: (key: string) => ({ data: key === 'changes:item:23' ? change : null }), setLive: vi.fn(), refreshLive: vi.fn() }));
vi.mock('../lib/prefetch', () => ({ canPrefetch: () => false, prefetchHref: vi.fn() }));
vi.mock('../lib/router', () => ({ useRoute: () => ({ id: '23', sub: 'guide', query: new URLSearchParams() }), navigate: vi.fn(), isPlainLeftClick: () => false, paths: { pull: (number: number, options?: { tab?: string }) => `/pull/${number}${options?.tab ? `/${options.tab}` : ''}` } }));
vi.mock('../components/pulls/guide', () => ({ useGuide: vi.fn(() => ({ guide: state.guide })) }));
vi.mock('../components/pulls/prefetch', () => ({ filesTab: { Component: () => null, prefetch: vi.fn() }, guideTab: { Component: () => null, prefetch: vi.fn() }, prefetchFirstDiff: vi.fn() }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }), Tabs: ({ tabs }: { tabs: { value: string; label: ReactNode }[] }) => {
  state.labels = new Map(tabs.map(tab => [tab.value, tab.label]));
  return <nav>{tabs.map(tab => <span key={tab.value}>{tab.label}</span>)}</nav>;
} }));

import { PullScreen } from './PullScreen';
import { useGuide } from '../components/pulls/guide';

beforeEach(() => { state.guide = null; state.labels.clear(); vi.clearAllMocks(); });

describe('pull request tabs', () => {
  it('keeps Guide’s label and neighboring tab labels unchanged when chapters arrive', () => {
    renderToStaticMarkup(<PullScreen />);
    const pending = [...state.labels].map(([key, label]) => [key, renderToStaticMarkup(<>{label}</>)]);
    state.guide = { status: 'ready', revision: 1, generatedBy: '@cf/test', attributes: [], chapters: [{ id: 'headers', title: 'Headers', summary: 'Add delivery headers.', kind: 'logic', files: [] }] };
    renderToStaticMarkup(<PullScreen />);
    const ready = [...state.labels].map(([key, label]) => [key, renderToStaticMarkup(<>{label}</>)]);
    expect(ready).toEqual(pending);
    expect(textOf(ready.find(([key]) => key === 'guide')![1]).trim()).toBe('Guide');
    expect(useGuide).toHaveBeenCalledWith(change, true);
  });
});
