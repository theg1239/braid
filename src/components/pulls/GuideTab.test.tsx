import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change, ChangeGuide } from '../../../shared/types';
import { Guide } from './GuideTab';

const state = vi.hoisted(() => ({ guide: null as ChangeGuide | null, error: null as string | null }));
vi.mock('../../lib/api', () => ({ changes: { guide: vi.fn() } }));
vi.mock('../../lib/live', () => ({ useLive: () => ({ data: state.guide, error: state.error, refreshing: false, refresh: vi.fn() }), refreshLive: vi.fn(), peekLive: vi.fn() }));
vi.mock('../../lib/resources', () => ({ prefetchDiff: vi.fn(), useChangeDiff: () => ({ key: 'diff:1', diff: null, error: null, retry: vi.fn() }) }));
vi.mock('../code', () => ({ useDiffStyle: () => 'unified', CodeError: () => null, DiffView: () => <div data-diff />, AnchoredHunks: () => <div data-diff /> }));
vi.mock('@pierre/diffs', () => ({ parseDiffFromFile: () => ({ hunks: [] }) }));
vi.mock('./useMoves', () => ({ useMoves: () => ({ moves: [], onReady: vi.fn() }) }));

const change = { id: 'ch_test', number: 49, revision: 1, files: [] } as unknown as Change;
const ready = (): ChangeGuide => ({
  status: 'ready', revision: 1, generatedBy: '@cf/meta/llama-4-scout-17b-16e-instruct', attributes: [],
  before: 'Thirty handlers by hand.', after: 'Handler h0031 is registered.',
  chapters: [
    { id: 'c1', title: 'The handler itself', summary: 'One function.', kind: 'logic', files: [{ path: 'swarm/handlers/h0031.ts', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] }] },
    { id: 'c2', title: 'Registry entry', summary: '', kind: 'config', files: [{ path: 'swarm/registry.json', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }] }] },
    { id: 'c3', title: 'Handler test', summary: '', kind: 'tests', files: [{ path: 'swarm/handlers/h0031.test.ts', hunks: [] }] },
    { id: 'c4', title: 'Lockfile', summary: '', kind: 'generated', files: [{ path: 'package-lock.json', hunks: [] }] },
  ],
});
const html = () => renderToStaticMarkup(<Guide change={change} />);
beforeEach(() => { state.guide = null; state.error = null; });

describe('guide states', () => {
  it('holds the final layout with skeleton chapters while the model writes, without a spinner or the word Loading', () => {
    state.guide = { status: 'pending', revision: 1, chapters: [], generatedBy: 'model', attributes: [] };
    const out = html();
    expect(out).toContain('guide--pending');
    expect(out).toContain('guide__chapters');
    expect(out).toContain('guide__diff-room');
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toMatch(/>Loading/);
    expect(out).not.toContain('spinner');
  });

  it('shows a failure as one line with Try again and no invented chapters', () => {
    state.guide = { status: 'failed', revision: 1, chapters: [], generatedBy: 'model', attributes: [], error: 'The model timed out.' };
    const out = html();
    expect(out).toContain('role="alert"');
    expect(out).toContain('The model timed out.');
    expect(out).toContain('Try again');
    expect(out).not.toContain('guide__chapter"');
  });

  it('shows a read error the same way', () => {
    state.error = 'Network down.';
    expect(html()).toContain('Network down.');
  });

  it('opens on the first chapter with before and after above and tests and generated folded below', () => {
    state.guide = ready();
    const out = html();
    expect(out).toContain('<h2>Before</h2><p>Thirty handlers by hand.</p>');
    expect(out).toContain('<h2>After</h2><p>Handler h0031 is registered.</p>');
    expect(out.match(/class="guide__chapter"/g)).toHaveLength(4);
    expect(out).toContain('aria-current="true"');
    expect(out).toContain('config · registry.json');
    expect(out).toContain('<summary class="guide__fold-summary">');
    expect(out).toMatch(/Tests<span class="tab-count">1<\/span>/);
    expect(out).toMatch(/Generated<span class="tab-count">1<\/span>/);
    expect(out).not.toContain('<details class="guide__fold" open');
    expect(out).toContain('aria-label="swarm/handlers/h0031.ts"');
    expect(out).toContain('lines 1–3');
    expect(out).toContain('aria-label="Previous chapter"');
    expect(out).toContain('aria-label="Chapter"');
    expect(out).toContain('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('says so when a ready guide has no chapters', () => {
    state.guide = { ...ready(), chapters: [] };
    expect(html()).toContain('No chapters');
  });
});
