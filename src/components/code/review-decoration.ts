import type { FileDiff, FileDiffMetadata } from '@pierre/diffs';
import { hunkFunctionContext, type FunctionContext } from './function-context';
import type { MoveEnd, MovedBlock } from './moves';

export const REVIEW_CSS = `
[data-function-context]{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-2);font:inherit;border:0;background:none;padding:0;max-width:100%;text-align:left;cursor:pointer;}
[data-function-context]:focus-visible,[data-move-link]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px;}
[data-line][data-moved]{position:relative;background:var(--panel);}
[data-line][data-moved]>span{opacity:.8;}
[data-move-link]{position:absolute;right:max(8px,calc(100% - 100cqi + var(--diffs-column-number-width,32px) + 8px));top:0;z-index:1;max-width:75cqi;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--line);border-radius:5px;background:var(--sunken);color:var(--fg-2);padding:0 6px;font:11px/18px var(--font-sans);text-decoration:none;}
[data-move-link]:hover{color:var(--fg);border-color:var(--fg-3);}
[data-move-target]{outline:2px solid var(--focus);outline-offset:-2px;}`;

export function sourceRows(node: HTMLElement) {
  return [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[data-content] [data-line][data-line-type]') ?? [])];
}
export function rowLocation(row: HTMLElement): { line: number; side: MoveEnd['side'] } {
  const side = row.dataset.lineType === 'change-deletion' || row.closest('[data-deletions]') ? 'deletions' : 'additions';
  const values = (row.dataset.line ?? '').split(',');
  return { line: Number(side === 'deletions' ? values[0] : values.at(-1)), side };
}

/** Decorations live in existing rows; asynchronous discoveries never add vertical space. */
export function decorateMoves(node: HTMLElement, path: string, moves: readonly MovedBlock[], onMove?: (end: MoveEnd) => void, target?: MoveEnd | null) {
  for (const row of sourceRows(node)) {
    const at = rowLocation(row);
    row.toggleAttribute('data-move-target', target?.path === path && target.line === at.line && target.side === at.side);
    row.removeAttribute('data-moved');
    row.querySelector('[data-move-link]')?.remove();
    for (const move of moves) {
      const origin = move.from.path === path && at.side === 'deletions';
      const end = origin ? move.from : move.to, other = origin ? move.to : move.from;
      if (end.path !== path || at.side !== end.side || at.line < end.line || at.line >= end.line + move.count) continue;
      row.dataset.moved = '';
      if (at.line !== end.line) break;
      const anchor = document.createElement('a');
      anchor.dataset.moveLink = '';
      const destination = new URL(window.location.href);
      destination.pathname = destination.pathname.replace(/\/guide$/, '/files');
      destination.searchParams.set('file', other.path);
      destination.hash = `diff-${other.side === 'deletions' ? 'L' : 'R'}${other.line}`;
      anchor.href = destination.href;
      anchor.textContent = `Moved ${origin ? 'to' : 'from'} ${other.path}:${other.line}`;
      anchor.title = anchor.textContent;
      if (onMove) anchor.onclick = event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); event.stopPropagation(); onMove(other);
      };
      row.appendChild(anchor);
      break;
    }
  }
}

export function decorateHunks(node: HTMLElement, instance: Pick<FileDiff, 'expandHunk'>, diff: FileDiffMetadata, context: FunctionContext, expanded: Set<number>) {
  for (const separator of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-separator][data-expand-index]') ?? []) {
    const index = Number(separator.dataset.expandIndex);
    const hunk = diff.hunks[index];
    if (!hunk) continue;
    const anchor = hunkFunctionContext(hunk, context);
    const content = separator.querySelector<HTMLElement>('[data-separator-content]');
    if (!anchor || !content) continue;
    let button = content.querySelector<HTMLButtonElement>('[data-function-context]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button'; button.dataset.functionContext = '';
      content.replaceChildren(button);
    }
    button.textContent = anchor.declaration.signature;
    const canExpand = anchor.leading > 0 && !diff.isPartial && !expanded.has(index);
    button.title = canExpand ? 'Expand context' : anchor.declaration.signature;
    button.disabled = !canExpand;
    button.onclick = event => {
      event.stopPropagation();
      if (canExpand) { expanded.add(index); instance.expandHunk(index, 'down', anchor.leading); }
    };
    // Expanding below the viewport cannot move visible rows. Never grow a hunk above the reader.
    if (canExpand && separator.getBoundingClientRect().top > window.innerHeight) {
      expanded.add(index);
      requestAnimationFrame(() => { if (node.isConnected && separator.getBoundingClientRect().top > window.innerHeight) instance.expandHunk(index, 'down', anchor.leading); else expanded.delete(index); });
    }
  }
}
