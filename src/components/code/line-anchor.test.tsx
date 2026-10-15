import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileOptions } from '@pierre/diffs/react';
import { FileView } from './index';
import { Diff, Source } from './pierre';
import { lineFromHash, scrollToSourceLine } from './line-anchor';

const state = vi.hoisted(() => ({ hash: '#L2', options: null as FileOptions<undefined, undefined> | null }));
vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: state.hash }) }));
vi.mock('./viewer', () => ({ Source: () => null, Diff: () => null, Conflict: () => null, Markdown: () => null }));
vi.mock('@pierre/diffs', async importOriginal => ({ ...await importOriginal<typeof import('@pierre/diffs')>(), Virtualizer: class {}, registerCustomTheme: vi.fn(), preloadHighlighter: vi.fn(async () => {}), DEFAULT_VIRTUAL_FILE_METRICS: { hunkLineCount: 50, lineHeight: 20, diffHeaderHeight: 44, spacing: 8 } }));
vi.mock('@pierre/diffs/worker/worker.js?worker&url', () => ({ default: '/worker.js' }));
vi.mock('@pierre/diffs/react', async () => ({
  VirtualizerContext: (await import('react')).createContext(null),
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <div data-worker-pool="">{children}</div>,
  File: ({ selectedLines, options }: { selectedLines: { start: number; end: number } | null; options: FileOptions<undefined, undefined> }) => { state.options = options; return <div data-selection={JSON.stringify(selectedLines)} />; },
  FileDiff: () => null, UnresolvedFile: () => null,
}));

beforeEach(() => { state.hash = '#L2'; state.options = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('file line anchors', () => {
  it('renders small files and diffs without starting a worker pool', () => {
    const file = { name: 'a.ts', contents: 'export const x = 1;\n', cacheKey: 'a' };
    expect(renderToStaticMarkup(<Source file={file} label="Source" />)).not.toContain('data-worker-pool');
    expect(renderToStaticMarkup(<Diff files={{ oldFile: file, newFile: { ...file, cacheKey: 'b', contents: 'export const x = 2;\n' } }} label="Diff" split={false} wrap={false} />)).not.toContain('data-worker-pool');
  });
  it.each(['line\n'.repeat(201), 'x'.repeat(12_001)])('keeps long or dense files on the worker pool', contents => {
    expect(renderToStaticMarkup(<Source file={{ name: 'a.ts', contents, cacheKey: 'a' }} label="Source" />)).toContain('data-worker-pool');
  });
  it('bounds the combined diff input, even when each side alone is small', () => {
    const file = { name: 'a.ts', contents: 'line\n'.repeat(110), cacheKey: 'a' };
    expect(renderToStaticMarkup(<Diff files={{ oldFile: file, newFile: { ...file, cacheKey: 'b' } }} label="Diff" split wrap={false} />)).toContain('data-worker-pool');
  });
  it.each([['#L1', 1], ['#L1234', 1234], ['', null], ['#L0', null], ['#L-2', null], ['#L1.2', null], ['#L1junk', null], ['#L999999999999999999999', null]] as const)('parses %s', (hash, line) => {
    expect(lineFromHash(hash)).toBe(line);
  });
  it('gives plain text lines addressable numbers and highlights just the target', () => {
    const markup = renderToStaticMarkup(<FileView path="README.md" content={'one\ntwo\nthree\n'} id="readme" render="code" />);
    expect(markup).toContain('id="L2" class="code__row" data-selected="true"');
    expect(markup.match(/data-selected/g)).toHaveLength(1);
    expect(markup).toContain('href="#L2" aria-label="Line 2"');
  });
  it('selects the requested highlighted source line and scrolls once even when it starts outside the virtual window', () => {
    state.hash = '#L1500';
    const markup = renderToStaticMarkup(<Source file={{ name: 'long.ts', contents: 'line\n'.repeat(2000), cacheKey: 'long' }} label="Long file" />);
    expect(markup).toContain('{&quot;start&quot;:1500,&quot;end&quot;:1500}');
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollY: 50, innerHeight: 900, scrollTo });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const node = { getBoundingClientRect: () => ({ top: 400 }) } as HTMLElement;
    const getLinePosition = vi.fn(() => ({ top: 30_000, height: 20 }));
    const instance = { getLinePosition } as unknown as Parameters<NonNullable<FileOptions<undefined, undefined>['onPostRender']>>[1];
    state.options!.onPostRender!(node, instance, 'mount');
    state.options!.onPostRender!(node, instance, 'update');
    expect(getLinePosition).toHaveBeenCalledExactlyOnceWith(1500);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 30_150, behavior: 'instant' });
  });
  it('does not scroll or select an invalid fragment', () => {
    state.hash = '#section';
    expect(renderToStaticMarkup(<Source file={{ name: 'a.ts', contents: 'text', cacheKey: 'a' }} label="Source" />)).toContain('data-selection="null"');
  });
  it('keeps the start of the document within scroll bounds', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollY: 0, innerHeight: 900, scrollTo });
    scrollToSourceLine({ getBoundingClientRect: () => ({ top: 50 }) } as HTMLElement, 0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
  });
});
