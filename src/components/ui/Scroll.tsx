import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './scroll.css';

/**
 * A bounded list that scrolls inside itself. A soft shadow sits on each edge with more past it, so the end of the list
 * is visible without a count or a button. `start="end"` opens at the bottom, where a log's latest line is.
 */
export function ScrollArea({ children, maxHeight, label, start = 'top', className = '' }: { children: ReactNode; maxHeight: number; label: string; start?: 'top' | 'end'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    if (start === 'end' && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [start]);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    const measure = () => setEdges({ above: area.scrollTop > 1, below: area.scrollTop + area.clientHeight < area.scrollHeight - 1 });
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(area);
    if (area.firstElementChild) resize.observe(area.firstElementChild);
    area.addEventListener('scroll', measure, { passive: true });
    return () => { resize.disconnect(); area.removeEventListener('scroll', measure); };
  }, []);
  return (
    <div className={`scroll-area ${className}`} data-above={edges.above || undefined} data-below={edges.below || undefined}>
      {/* Focusable, so a keyboard scrolls it like a mouse wheel does. */}
      <div ref={ref} className="scroll-area__viewport" style={{ maxHeight }} tabIndex={0} role="region" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/**
 * Where a list asks for its next page: once this comes within a screen of view, `more` runs, and again after each
 * page while there is one. A keyboard still has the button it renders. After a failed page it waits for Try again,
 * so a failing read is never asked again on its own.
 */
export function LoadMore({ more, busy, failed = false, label = 'Load more' }: { more: () => unknown; busy: boolean; failed?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(more);
  latest.current = more;
  useEffect(() => {
    const sentinel = ref.current;
    if (!sentinel || busy || failed) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void latest.current(); }, { rootMargin: '0px 0px 100% 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [busy, failed]);
  return (
    <div ref={ref} className="load-more" aria-busy={busy || undefined} data-failed={failed || undefined}>
      <button type="button" className="load-more__button" disabled={busy} onClick={() => void more()}>{busy ? 'Loading…' : failed ? 'Try again' : label}</button>
    </div>
  );
}
