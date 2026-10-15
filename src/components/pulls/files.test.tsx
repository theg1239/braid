import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change, ChangeDiff } from '../../../shared/types';
import type { ChangeGuide } from '../../../shared/guide';
import { FilesChanged } from './Files';

const state = vi.hoisted(() => ({ diff: null as ChangeDiff | null, error: null as string | null, blocker: null as string | null, guide: null as ChangeGuide | null }));
vi.mock('../../lib/resources', () => ({
  prefetchDiff: vi.fn(),
  useChangeComparison: () => ({ comparison: null }),
  useChangeDiff: () => ({ key: 'diff:1', diff: state.diff, error: state.error, retry: vi.fn() }),
}));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({}), answerBlocker: () => state.blocker }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('./guide', () => ({ useGuide: () => ({ guide: state.guide }) }));
vi.mock('../../lib/router', () => ({ isPlainLeftClick: () => true, navigate: vi.fn(), paths: { pull: (number: number) => `/pull/${number}/files` } }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../code', () => ({
  prefetchCode: vi.fn(), useDiffStyle: () => 'unified', setDiffStyle: vi.fn(),
  CodeLoading: () => <div aria-busy="true" />,
  CodeError: ({ result }: { result: { message: string } }) => <div role="alert">{result.message}</div>,
  DiffView: ({ annotations }: { annotations: { metadata: React.ReactNode }[] }) => <div data-diff>{annotations.map((annotation, index) => <div key={index}>{annotation.metadata}</div>)}</div>,
}));

function change(): Change {
  return {
    id: 'ch_test', number: 22, title: 'Validate endpoints', status: 'landed', revision: 2,
    author: { id: 'owner', kind: 'human', name: 'Maya Chen' },
    additions: 6, deletions: 0, baseCommit: 'base', intent: '', summary: '', rationale: '',
    createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T10:00:00Z',
    reviews: [], checks: [], conflicts: [], overlaps: [], events: [],
    files: [{ path: 'src/endpoints.ts', additions: 6, deletions: 0, added: true, beforeHash: null, afterHash: 'a'.repeat(40) }],
    comments: [{ id: 'thread', author: { id: 'owner', kind: 'human', name: 'Maya Chen' }, body: 'Require HTTPS.', createdAt: '2026-10-12T10:00:00Z', revision: 2, resolved: true,
      anchor: { path: 'src/endpoints.ts', side: 'RIGHT', line: 5, position: 5, revision: 2, outdated: false } }],
  };
}
const html = (input = change()) => renderToStaticMarkup(<FilesChanged change={input} since={null} focus={null} />);
beforeEach(() => { state.diff = null; state.error = null; state.blocker = null; state.guide = null; });

describe('file loading reservations', () => {
  it('reserves an entire added file while drawing only a screen of skeleton lines', () => {
    const input = change();
    input.files[0].additions = 250;
    const out = html(input);
    expect(out).toContain('height:6044px');
    expect(out.match(/class="code-skeleton__row"/g)).toHaveLength(30);
  });

  it('sizes the known conversation before the file arrives, without exposing its inactive controls', () => {
    const out = html();
    expect(out).toContain('class="fsec__sizing" aria-hidden="true" inert=""');
    expect(out).toContain('data-thread-location="RIGHT:5"');
    expect(out).toContain('Resolved');
    expect(out).toContain('Show conversation');
    expect(out).not.toContain('id="discussion-thread"');
    expect(out).toContain('aria-busy="true" aria-label="Changes"');
    expect(out).not.toContain('data-diff');
  });

  it('keeps the real discussion anchor unique when its inline diff is ready', () => {
    state.diff = { path: 'src/endpoints.ts', revision: 2, before: null, after: 'export const valid = true;', binary: false };
    const out = html();
    expect(out.match(/id="discussion-thread"/g)).toHaveLength(1);
    expect(out.match(/id="comment-thread"/g)).toHaveLength(1);
    expect(out).not.toContain('aria-label="Loading changes"');
  });

  it('renders outdated conversations below the pending file, without waiting for its contents', () => {
    const input = change();
    input.comments![0].anchor!.outdated = true;
    const out = html(input);
    expect(out).toContain('class="file-conversations"');
    expect(out).toContain('Outdated');
    expect(out).not.toContain('data-thread-location');
    expect(out.match(/id="discussion-thread"/g)).toHaveLength(1);
  });

  it('keeps withheld content out of both the viewer and its sizing copy', () => {
    state.diff = { path: 'src/endpoints.ts', revision: 2, before: null, after: null, binary: false, withheld: true };
    const out = html();
    expect(out).toContain('Content withheld');
    expect(out).not.toContain('fsec__sizing');
    expect(out).not.toContain('data-diff');
  });

  it('replaces a failed read with the retryable error instead of retaining a skeleton', () => {
    state.error = 'Revision changed.';
    const out = html();
    expect(out).toContain('role="alert">Revision changed.');
    expect(out).not.toContain('fsec__sizing');
    expect(out).not.toContain('aria-busy');
  });
});

describe('explicit file groups', () => {
  const groupedChange = () => {
    const input = change();
    input.files = ['aaa.ts', 'generated.ts', 'logic.ts'].map(path => ({ ...input.files[0], path }));
    state.guide = { status: 'ready', revision: 2, generatedBy: 'model', attributes: [{ path: 'generated.ts', generated: true }], chapters: [
      { id: 'tests', title: 'Check endpoints', summary: '', kind: 'tests', files: [{ path: 'aaa.ts', hunks: [] }] },
      { id: 'logic', title: 'Validate endpoints', summary: '', kind: 'logic', files: [{ path: 'logic.ts', hunks: [] }] },
    ] };
    return input;
  };

  it('starts with logic and mounts neither collapsed group from a cached ready guide', () => {
    const out = html(groupedChange());
    expect(out).toContain('data-path="logic.ts"');
    expect(out).not.toContain('data-path="aaa.ts"');
    expect(out).not.toContain('data-path="generated.ts"');
    expect(out.match(/<details class="fgroup">/g)).toHaveLength(2);
    expect(out).toMatch(/Tests <span class="count">1<\/span>/);
    expect(out).toMatch(/Generated <span class="count">1<\/span>/);
  });

  it('ignores a guide from an earlier revision, keeping the existing alphabetical order', () => {
    const input = groupedChange();
    state.guide!.revision = 1;
    const out = html(input);
    expect(out).not.toContain('class="fgroup"');
    expect(out.indexOf('data-path="aaa.ts"')).toBeLessThan(out.indexOf('data-path="generated.ts"'));
    expect(out.indexOf('data-path="generated.ts"')).toBeLessThan(out.indexOf('data-path="logic.ts"'));
  });
});
