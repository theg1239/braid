import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Virtualizer as VirtualizerClass, DEFAULT_VIRTUAL_FILE_METRICS, registerCustomTheme, preloadHighlighter, parseDiffFromFile, type DiffFileInput, type FileContents, type VirtualizedFile, type FileDiff as DiffInstance } from '@pierre/diffs';
import {
  File,
  FileDiff,
  UnresolvedFile,
  VirtualizerContext,
  WorkerPoolContextProvider,
  type FileDiffOptions,
  type FileOptions,
  type UnresolvedFileReactOptions,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from '@pierre/diffs/react';
import workerUrl from '@pierre/diffs/worker/worker.js?worker&url';
import darkTheme from './theme';

import { scrollToSourceLine, useLineAnchor } from './line-anchor';
import { useSourceLineHeight } from './line-height';
import { textSize } from '../../lib/diff';
import { CodeSkeleton, codePlaceholderHeight } from './CodeSkeleton';
import type { DiffComments } from './annotations';
import { PlusIcon } from '@phosphor-icons/react';
import { selectHunks } from './select-hunks';
import { contextRowHeight, type DiffReview } from './review-types';
import type { ReviewControllerProps } from './ReviewController';

/*
 * The diff viewer: @pierre/diffs with Shiki's JavaScript engine, using a worker pool for larger
 * inputs and virtualized against the page's scroll. This module loads only when code is on screen;
 * components/code/index.tsx holds everything a page needs before that.
 */

/** Kumo's code theme in the dark mode the interface runs in. The host's panel colours replace the theme's own background. */
registerCustomTheme('braid-dark', () => Promise.resolve(darkTheme));
const THEME = 'braid-dark';
// Size conversations before Pierre's resize callback; its delayed column width causes a WebKit resize loop.
const HOST_CSS = `:host{--diffs-dark-bg:var(--panel);--diffs-dark:var(--fg);--diffs-selection-number-fg:var(--code-selected-number);}
[data-overflow=scroll] [data-annotation-content]{width:calc(100cqi - var(--diffs-column-number-width,32px));}
[data-line-number-content]{color:inherit;text-decoration:none;font:inherit;}
button[data-line-number-content]{box-sizing:border-box;width:calc(100% + 3ch);min-width:24px;min-height:24px;margin-inline:-2ch -1ch;border:0;padding:0 1ch 0 0;text-align:right;background:transparent;cursor:pointer;}
a[data-line-number-content]:hover{text-decoration:underline;}
@media(max-width:767px){:host(.code--source) a[data-line-number-content]{display:inline-flex;align-items:center;justify-content:flex-end;min-width:32px;min-height:32px;}}
[data-line-number-content]:focus-visible,[data-code]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px;}`;

const BASE = { theme: THEME, themeType: 'dark', preferredHighlighter: 'shiki-js', disableFileHeader: true, unsafeCSS: HOST_CSS } as const;
const DIFF: FileDiffOptions<ReactNode, undefined> = { ...BASE, diffStyle: 'unified', hunkSeparators: 'line-info', lineDiffType: 'word-alt', diffIndicators: 'classic', overflow: 'scroll' };
const DIFF_WRAP: FileDiffOptions<ReactNode, undefined> = { ...DIFF, overflow: 'wrap' };
const DIFF_SPLIT: FileDiffOptions<ReactNode, undefined> = { ...DIFF, diffStyle: 'split' };
const FILE: FileOptions<undefined, undefined> = { ...BASE, overflow: 'scroll' };
const CONFLICT: UnresolvedFileReactOptions<undefined> = { ...BASE, mergeConflictActionsType: 'none', disableLineNumbers: true, lineDiffType: 'none' };

/** Small inputs use Pierre's shared highlighter directly; larger inputs keep tokenization off the main thread. */
const POOL: WorkerPoolOptions = { workerFactory: () => new Worker(workerUrl, { type: 'module' }), poolSize: 2 };
const HIGHLIGHTER: WorkerInitializationRenderOptions = { theme: THEME, preferredHighlighter: 'shiki-js', lineDiffType: 'word-alt' };
const COMMENT_METRICS = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: 24 };

// Pierre can draw its normal plain rows as soon as the themes are attached. Grammars still load on demand.
export function prepareViewer() {
  return preloadHighlighter({ themes: [THEME], langs: ['text'], preferredHighlighter: 'shiki-js' });
}

/*
 * One virtualizer on the document for every code view on the page, so a 5,000-line file or a
 * change with hundreds of files renders only what is in view while the page scrolls as usual.
 */
let windowVirtualizer: VirtualizerClass | null = null;
let users = 0;

function useWindowVirtualizer(): VirtualizerClass {
  const [instance] = useState(() => (windowVirtualizer ??= new VirtualizerClass()));
  useEffect(() => {
    users++;
    if (users === 1) instance.setup(document);
    return () => {
      users--;
      if (users === 0) instance.cleanUp();
    };
  }, [instance]);
  return instance;
}

function Surface({ label, children, ready = true, lines = 12, lineHeight = 20, virtualized = true, workers = true }: { label: string; children: ReactNode; ready?: boolean; lines?: number; lineHeight?: number; virtualized?: boolean; workers?: boolean }) {
  const virtualizer = useWindowVirtualizer();
  const content = <VirtualizerContext.Provider value={virtualized ? virtualizer : undefined}>{children}</VirtualizerContext.Provider>;
  return (
    <div className={`code code--view${ready ? '' : ' code--pending'}`} role="region" aria-label={label} style={{ '--source-line-height': `${lineHeight}px`, minHeight: ready ? undefined : (codePlaceholderHeight(lines) - 16) * lineHeight / 20 + 16 } as CSSProperties}>
      {workers ? <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>{content}</WorkerPoolContextProvider> : content}
      {ready ? null : <CodeSkeleton lines={lines} />}
    </div>
  );
}

/** Pierre owns these nodes; post-render also runs when virtualization replaces a window of lines. */
function prepareCode(node: HTMLElement): boolean {
  const root = node.shadowRoot;
  if (!root) return false;
  for (const code of root.querySelectorAll<HTMLElement>('[data-code]')) {
    code.tabIndex = 0;
    code.setAttribute('role', 'group');
    code.setAttribute('aria-label', code.hasAttribute('data-deletions') ? 'Before' : code.hasAttribute('data-additions') ? 'After' : 'Code');
  }
  return root.querySelector('[data-line]') !== null;
}

function sourceLinks(node: HTMLElement) {
  for (const number of node.shadowRoot?.querySelectorAll<HTMLElement>('span[data-line-number-content]') ?? []) {
    const line = number.parentElement!.dataset.columnNumber!;
    const anchor = document.createElement('a');
    anchor.dataset.lineNumberContent = '';
    anchor.id = `L${line}`;
    anchor.href = `#L${line}`;
    anchor.setAttribute('aria-label', `Line ${line}`);
    anchor.textContent = number.textContent;
    number.replaceWith(anchor);
  }
}

/** An annotation rerender replaces gutter nodes, so resolve the line after it closes. */
function restoreCommentFocus(node: HTMLElement, line: number, side: 'deletions' | 'additions') {
  requestAnimationFrame(() => node.shadowRoot?.querySelector<HTMLButtonElement>(`button[data-comment-line="${line}"][data-comment-side="${side}"]`)?.focus());
}

/** The number is a real button too, so every visible line can start a comment with the keyboard. */
function commentButtons(node: HTMLElement, onAddComment: NonNullable<DiffComments['onAddComment']>) {
  for (const number of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-line-number-content]') ?? []) {
    const row = number.parentElement!;
    const line = Number(row.dataset.columnNumber);
    const side = row.dataset.lineType === 'change-deletion' || row.closest('[data-deletions]') ? 'deletions' : 'additions';
    const button = number.tagName === 'BUTTON' ? number as HTMLButtonElement : document.createElement('button');
    button.type = 'button';
    button.dataset.lineNumberContent = '';
    button.dataset.commentLine = String(line);
    button.dataset.commentSide = side;
    button.setAttribute('aria-label', `Add comment on line ${line}`);
    button.textContent = number.textContent;
    button.onclick = event => { event.stopPropagation(); onAddComment(line, side, () => restoreCommentFocus(node, line, side)); };
    if (button !== number) number.replaceWith(button);
  }
}

export function Diff({ files, label, split, wrap, virtualized = true, annotations, onAddComment, hunks, moves, onMove, moveTarget, onReady }: { files: DiffFileInput; label: string; split: boolean; wrap: boolean; virtualized?: boolean } & DiffComments & DiffReview) {
  const identity = `${files.oldFile?.cacheKey}:${files.newFile?.cacheKey}:${split}:${wrap}:${hunks?.join(',') ?? ''}`;
  const path = (files.newFile ?? files.oldFile)!.name;
  const supportsContext = contextRowHeight(path) > 0;
  const diff = useMemo(() => selectHunks(parseDiffFromFile(files.oldFile, files.newFile), hunks), [files, hunks]);
  const host = useRef<HTMLElement | null>(null);
  const instance = useRef<DiffInstance<ReactNode, undefined> | null>(null);
  const signature = useRef<HTMLButtonElement>(null);
  const onRender = useRef<ReviewControllerProps['onRender']['current']>(null);
  const [Review, setReview] = useState<typeof import('./ReviewController').ReviewController | null>(null);
  const [reviewReady, setReviewReady] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ lineNumber: number; side: 'deletions' | 'additions' } | null>(null);
  const lines = useMemo(() => textSize(files.oldFile?.contents ?? '').lines + textSize(files.newFile?.contents ?? '').lines, [files]);
  const workers = lines > 200 || (files.oldFile?.contents.length ?? 0) + (files.newFile?.contents.length ?? 0) > 12_000;
  useEffect(() => {
    if (ready !== identity) return;
    let cancelled = false;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      onReady?.();
      // The diff reads without its review layer. A chunk that failed to load, as after a deploy, leaves line comments to the next page load.
      void import('./ReviewController').then(module => {
        if (!cancelled) { setReview(() => module.ReviewController); setReviewReady(identity); }
      }).catch(() => undefined);
    }); });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [ready, identity, onReady]);
  const options = useMemo<FileDiffOptions<ReactNode, undefined>>(() => ({
    ...(split ? DIFF_SPLIT : wrap ? DIFF_WRAP : DIFF),
    enableGutterUtility: !!onAddComment,
    onLineEnter: onAddComment ? ({ lineNumber, annotationSide: side }) => setHovered(current => current?.lineNumber === lineNumber && current.side === side ? current : { lineNumber, side }) : undefined,
    onPostRender: (node, viewer) => {
      host.current = node; instance.current = viewer;
      if (prepareCode(node)) setReady(identity);
      if (onAddComment) commentButtons(node, onAddComment);
      onRender.current?.(node, viewer);
    },
  }), [split, wrap, identity, label, onAddComment]);
  return (
    <Surface label={label} ready={ready === identity} lines={lines} virtualized={virtualized} workers={workers}>
      {Review && reviewReady === identity && ready === identity ? <Review files={files} diff={diff} host={host} instance={instance} signature={signature} onRender={onRender} virtualized={virtualized} moves={moves} onMove={onMove} moveTarget={moveTarget} /> : null}
      {supportsContext ? <div className="diff-function"><button ref={signature} className="diff-function__signature" type="button" disabled aria-label="Function context">{diff.hunks[0]?.hunkSpecs}</button></div> : null}
      <FileDiff<ReactNode> fileDiff={diff} options={options} className={onAddComment ? 'code--commentable' : undefined} metrics={onAddComment ? COMMENT_METRICS : undefined} lineAnnotations={annotations} renderAnnotation={annotation => annotation.metadata}
        renderGutterUtility={onAddComment ? getHoveredLine => <button type="button" className="code-comment-add" aria-label={`Add comment on line ${hovered?.lineNumber ?? 1}`} onClick={event => {
          const target = getHoveredLine() ?? hovered;
          const node = event.currentTarget.closest<HTMLElement>('diffs-container')!;
          if (target) onAddComment(target.lineNumber, target.side, () => restoreCommentFocus(node, target.lineNumber, target.side));
        }}><PlusIcon size={14} aria-hidden="true" /></button> : undefined} />
    </Surface>
  );
}

export function Source({ file, label }: { file: FileContents; label: string }) {
  const line = useLineAnchor();
  const lineHeight = useSourceLineHeight();
  const metrics = useMemo(() => ({ ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight }), [lineHeight]);
  const [ready, setReady] = useState<string | null>(null);
  const identity = file.cacheKey ?? file.contents;
  const lines = useMemo(() => textSize(file.contents).lines, [file.contents]);
  const workers = lines > 200 || file.contents.length > 12_000;
  const options = useMemo<FileOptions<undefined, undefined>>(() => {
    let scrolled = false;
    return {
      ...FILE,
      onLineNumberClick: ({ lineNumber }) => { window.location.hash = `L${lineNumber}`; },
      onPostRender: (node, instance) => {
        if (prepareCode(node)) setReady(identity);
        sourceLinks(node);
        if (line === null || scrolled) return;
        const position = (instance as VirtualizedFile).getLinePosition(line);
        if (!position) return;
        scrolled = true;
        requestAnimationFrame(() => scrollToSourceLine(node, position.top));
      },
    };
  }, [line, identity, label, lineHeight]);
  return (
    <Surface label={label} ready={ready === identity} lines={lines} lineHeight={lineHeight} workers={workers}>
      <File className="code--source" metrics={metrics} file={file} options={options} selectedLines={line === null ? null : { start: line, end: line }} />
    </Surface>
  );
}

/** A conflict region as Git would leave it in the file, with both sides and the base, read-only. */
export function Conflict({ file, label }: { file: FileContents; label: string }) {
  const options = useMemo<UnresolvedFileReactOptions<undefined>>(() => ({ ...CONFLICT, onPostRender: node => { prepareCode(node); } }), []);
  return (
    <Surface label={label}>
      <UnresolvedFile file={file} options={options} />
    </Surface>
  );
}
