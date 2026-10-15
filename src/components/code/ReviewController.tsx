import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { getFiletypeFromFileName, type DiffFileInput, type FileDiff, type FileDiffMetadata, type VirtualizedFileDiff } from '@pierre/diffs';
import { analyzeContext } from './analysis-client';
import { contextLanguages, enclosingDeclaration, hunkFunctionContext, type FunctionContext } from './function-context';
import { REVIEW_CSS, decorateHunks, decorateMoves, rowLocation, sourceRows } from './review-decoration';
import type { DiffReview } from './review-types';
import { scrollToSourceLine } from './line-anchor';

type Instance = FileDiff<ReactNode, undefined>;
export interface ReviewControllerProps extends Pick<DiffReview, 'moves' | 'onMove' | 'moveTarget'> {
  files: DiffFileInput;
  diff: FileDiffMetadata;
  virtualized: boolean;
  host: RefObject<HTMLElement | null>;
  instance: RefObject<Instance | null>;
  signature: RefObject<HTMLButtonElement | null>;
  onRender: RefObject<((node: HTMLElement, viewer: Instance) => void) | null>;
}

/** Optional review code is imported only after the first diff paints; decorations occupy existing rows. */
export function ReviewController({ files, diff, virtualized, host, instance, signature, onRender, moves, onMove, moveTarget }: ReviewControllerProps) {
  const path = (files.newFile ?? files.oldFile)!.name;
  const language = getFiletypeFromFileName(path);
  const expanded = useMemo(() => new Set<number>(), [diff]);
  const [analysis, setAnalysis] = useState<{ files: DiffFileInput; context: FunctionContext } | null>(null);
  const context = analysis?.files === files ? analysis.context : undefined;
  useEffect(() => {
    if (!contextLanguages.has(language)) return;
    let cancelled = false;
    void analyzeContext(language, files.oldFile?.contents ?? '', files.newFile?.contents ?? '').then(context => {
      if (!cancelled && context) setAnalysis({ files, context });
    });
    return () => { cancelled = true; };
  }, [files, language]);
  useEffect(() => {
    const decorate = (node: HTMLElement, viewer: Instance) => {
      const root = node.shadowRoot;
      if (!root) return;
      if (!root.querySelector('[data-review-style]')) {
        const style = document.createElement('style');
        style.dataset.reviewStyle = ''; style.textContent = REVIEW_CSS; root.appendChild(style);
      }
      decorateMoves(node, path, moves ?? [], onMove, moveTarget);
      if (context) decorateHunks(node, viewer, diff, context, expanded);
    };
    onRender.current = decorate;
    if (host.current && instance.current) decorate(host.current, instance.current);
    return () => { onRender.current = null; };
  }, [moves, onMove, moveTarget, path, context, diff, expanded, host, instance, onRender]);
  useEffect(() => {
    if (!context || !signature.current) return;
    const button = signature.current;
    let frame = 0;
    const update = () => {
      frame = 0;
      const node = host.current;
      if (!node) return;
      const top = button.getBoundingClientRect().bottom;
      const row = sourceRows(node).find(row => row.getBoundingClientRect().bottom > top);
      const at = row ? rowLocation(row) : null;
      const declaration = at ? enclosingDeclaration(at.side === 'deletions' ? context.before : context.after, at.line) : undefined;
      const first = diff.hunks.find(hunk => !at || (at.side === 'deletions' ? hunk.deletionStart + hunk.deletionCount : hunk.additionStart + hunk.additionCount) > at.line);
      const anchor = first ? hunkFunctionContext(first, context) : undefined;
      button.textContent = declaration?.signature ?? anchor?.declaration.signature ?? first?.hunkSpecs ?? '';
      button.title = button.textContent;
      const index = first ? diff.hunks.indexOf(first) : -1;
      button.disabled = !anchor?.leading || diff.isPartial || expanded.has(index);
      button.setAttribute('aria-label', button.disabled ? button.textContent || 'Function context' : `Expand context: ${button.textContent}`);
      button.onclick = () => {
        if (anchor?.leading && instance.current && !button.disabled) {
          expanded.add(index); instance.current.expandHunk(index, 'down', anchor.leading); update();
        }
      };
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [context, diff, expanded, host, instance, signature]);
  useEffect(() => {
    if (!moveTarget || moveTarget.path !== path) return;
    const node = host.current, viewer = instance.current;
    if (!node || !viewer) return;
    let frame = requestAnimationFrame(() => {
      const position = virtualized ? (viewer as VirtualizedFileDiff).getLinePosition(moveTarget.line, moveTarget.side) : undefined;
      if (position) scrollToSourceLine(node, position.top);
      frame = requestAnimationFrame(() => {
        const row = sourceRows(node).find(row => { const at = rowLocation(row); return at.line === moveTarget.line && at.side === moveTarget.side; });
        if (row) { row.scrollIntoView({ block: 'center' }); (node.closest<HTMLElement>('.fsec') ?? node).focus({ preventScroll: true }); }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [moveTarget, path, virtualized, host, instance]);
  return null;
}
