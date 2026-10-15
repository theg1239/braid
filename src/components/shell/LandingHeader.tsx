import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EXAMPLE_ADDRESS, paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { Mark } from './Mark';
import '../../styles/header.css';

/** Space between the groups once they gather into the capsule, and inside its ends. */
const GAP = 18;
const PAD = 10;

/**
 * The signed-out masthead: the brand, three places to look, and the way in. At the top it sits on the sky with
 * no surface of its own; once the page scrolls, its groups gather into a floating capsule in the middle. Only
 * transforms and opacity change, from widths measured once and again when the bar resizes, so nothing moves the page.
 */
export function LandingHeader() {
  const [floating, setFloating] = useState(false);
  const top = useRef<HTMLSpanElement>(null);
  const head = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // Floating once the top of the page has scrolled away; an observer, so the scroll itself never runs code here.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setFloating(!entry.isIntersecting));
    observer.observe(top.current!);
    return () => observer.disconnect();
  }, []);

  // Where each group goes in the capsule: packed side by side around the bar's centre. A layout effect, so the first
  // paint already has the positions and the observer disconnects in the same commit that removes the bar.
  useLayoutEffect(() => {
    const row = bar.current!;
    const style = head.current!.style;
    const measure = () => {
      const [brand, nav, actions] = [...row.children] as HTMLElement[];
      const width = row.clientWidth - parseFloat(getComputedStyle(row).paddingLeft) - parseFloat(getComputedStyle(row).paddingRight);
      const shown = nav.offsetWidth > 0;
      const total = brand.offsetWidth + (shown ? GAP + nav.offsetWidth : 0) + GAP + actions.offsetWidth;
      const start = (width - total) / 2;
      style.setProperty('--to-brand', `${start}px`);
      style.setProperty('--to-nav', `${start + brand.offsetWidth + GAP - (width - nav.offsetWidth) / 2}px`);
      style.setProperty('--to-actions', `${start + total - width}px`);
      style.setProperty('--capsule', `${total + 2 * PAD}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <span ref={top} className="site-head__top" aria-hidden="true" />
      <header ref={head} className="site-head site-head--landing" data-floating={floating || undefined}>
        <div ref={bar} className="site-head__bar">
          <RouterLink href={paths.site()} className="brand" aria-label="Braid">
            <Mark />
            <span className="brand__name">Braid</span>
          </RouterLink>
          <nav className="site-head__nav" aria-label="Site">
            <RouterLink href={paths.repo(EXAMPLE_ADDRESS)} className="site-head__link">
              Tour
            </RouterLink>
            <RouterLink href={paths.explore()} className="site-head__link">
              Explore
            </RouterLink>
            <a href="/setup.md" className="site-head__link">
              Docs
            </a>
          </nav>
          <div className="site-head__actions">
            <RouterLink href={paths.signin()} className="site-head__cta">
              Get started
            </RouterLink>
          </div>
        </div>
      </header>
    </>
  );
}
