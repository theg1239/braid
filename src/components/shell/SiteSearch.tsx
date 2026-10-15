import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { isModifierKey } from '../../lib/format';
import { lazyComponent } from '../../lib/lazy';
import { onOpenPalette } from '../../lib/palette';

const SiteCommandMenu = lazyComponent(() => import('./SiteCommandMenu'), m => m.SiteCommandMenu).Component;

/** Site pages have no workspace shell, so the account controls host their command menu. */
export function SiteSearch() {
  // Undefined until first opened, so the menu's chunk loads on demand.
  const [open, setOpen] = useState<boolean>();
  const trigger = useRef<HTMLElement | null>(null);
  const changeOpen = useCallback((next: boolean) => {
    if (next) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(next);
  }, []);
  useEffect(() => onOpenPalette(() => changeOpen(true)), [changeOpen]);
  useEffect(() => {
    if (open !== false) return;
    const frame = requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isModifierKey(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        changeOpen(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, changeOpen]);
  return open === undefined ? null : <Suspense fallback={null}><SiteCommandMenu open={open} onOpenChange={changeOpen} /></Suspense>;
}
