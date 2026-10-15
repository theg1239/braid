import { useEffect, useRef, type RefObject } from 'react';
import { isEditableTarget } from '../../lib/format';

/** A key press the review's j, k, n and p may take: no modifier, not typing, and no dialog, menu or list open. */
export function navigationKey(event: KeyboardEvent): boolean {
  return !(event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.composedPath()[0] ?? null) || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]'));
}

/** Adjacent additions and deletions are one change, including the two sides of a split diff. */
export function changeStarts<T extends { index: number }>(lines: T[]): T[] {
  const sorted = [...lines].sort((a, b) => a.index - b.index);
  return sorted.filter((line, index) => index === 0 || line.index > sorted[index - 1].index + 1);
}

function changesIn(section: HTMLElement) {
  return [...section.querySelectorAll('diffs-container')].flatMap((host) => {
    const lines = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-content] [data-line][data-line-type^="change-"]') ?? [])];
    return changeStarts(lines.map((node) => ({ node, index: Number(node.dataset.lineIndex!.split(',')[0]) })));
  });
}

export function useFileNavigation(root: RefObject<HTMLDivElement | null>, onJump: (path: string) => void) {
  const cursor = useRef<{ path: string; index: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let movement = 0;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const sections = () => [...(root.current?.querySelectorAll<HTMLElement>('.fsec') ?? [])];
    const active = (files: HTMLElement[]) => {
      const focused = document.activeElement?.closest<HTMLElement>('.fsec');
      if (focused && focused.getBoundingClientRect().bottom > 80 && focused.getBoundingClientRect().top < window.innerHeight) return files.indexOf(focused);
      const index = files.findIndex((file) => file.getBoundingClientRect().bottom > 80);
      return Math.max(0, index);
    };
    const jumpChange = async (direction: 1 | -1) => {
      running = true;
      const request = ++movement;
      const files = sections();
      let index = active(files);
      // A long diff renders in windows. Move through them until its next change appears.
      for (let step = 0; step < 120 && !cancelled && request === movement; step++) {
        const section = files[index];
        if (!section) break;
        const path = section.dataset.path!;
        if (!section.hasAttribute('data-open')) {
          section.querySelector<HTMLButtonElement>('.fsec__toggle')!.click();
          section.scrollIntoView({ block: 'start' });
          await frame();
          await frame();
        }
        const body = section.querySelector('.fsec__body');
        const viewer = body?.querySelector('diffs-container');
        if (body && (!body.childElementCount || body.querySelector('[aria-busy="true"]') || (viewer && !viewer.shadowRoot?.querySelector('[data-line]')))) {
          if (!body.childElementCount) section.scrollIntoView({ block: 'start' });
          await frame();
          await frame();
          continue;
        }
        const starts = changesIn(section);
        const current = cursor.current?.path === path ? cursor.current : null;
        const candidates = direction === 1 ? starts : [...starts].reverse();
        const target = candidates.find((line) => current ? direction * (line.index - current.index) > 0 : direction === 1 ? line.node.getBoundingClientRect().top >= 60 : line.node.getBoundingClientRect().top < window.innerHeight);
        if (target) {
          cursor.current = { path, index: target.index };
          target.node.scrollIntoView({ block: 'center' });
          section.focus({ preventScroll: true });
          break;
        }
        const rect = section.getBoundingClientRect();
        if (direction === 1 ? rect.bottom > window.innerHeight : rect.top < 0) {
          window.scrollBy(0, direction * window.innerHeight * 0.7);
        } else {
          index += direction;
          const next = files[index];
          if (!next) break;
          cursor.current = null;
          next.scrollIntoView({ block: direction === 1 ? 'start' : 'end' });
        }
        await frame();
        await frame();
      }
      running = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (!navigationKey(event)) return;
      if (!['j', 'k', 'n', 'p'].includes(event.key)) return;
      const files = sections();
      if (!files.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'n' || event.key === 'p') {
        if (!running) void jumpChange(event.key === 'n' ? 1 : -1);
      } else {
        movement++;
        const direction = event.key === 'j' ? 1 : -1;
        const index = Math.max(0, Math.min(files.length - 1, active(files) + direction));
        cursor.current = null;
        onJump(files[index].dataset.path!);
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { cancelled = true; window.removeEventListener('keydown', keydown, true); };
  }, [root, onJump]);
}
