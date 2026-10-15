import { useEffect, useRef, useState } from 'react';
import { gsap, ScrollTrigger } from '../../motion';
import { schedule } from './flights';
import { measure } from './layout';
import { descentSky, DRAIN } from './sky';
import './style.css';

const PHONE = '(max-width: 760px)';

/*
 * A night descent. The page is one continuous night the reader moves down through: deep sky at the hero, where the
 * stars breathe and part around the text; shooting stars, the agents' work, that sweep into main, a hairline of light
 * down the page's centre; and at the close the sea, where main meets the horizon and its reflection breathes.
 */
export default function Descent() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sea = useRef<HTMLDivElement>(null);
  const [water, setWater] = useState(false);

  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add({ still: '(prefers-reduced-motion: reduce)', phone: PHONE, fine: '(hover: hover) and (pointer: fine)' }, (context) => {
      const { still = false, phone = false, fine = false } = context.conditions ?? {};
      const element = canvas.current!;
      const surface = sea.current!;
      let seaAt = Number.NaN;
      const sky = descentSky(element, {
        phone,
        still,
        pointer: fine,
        sea: (y) => {
          if (Math.abs(y - seaAt) < 0.25) return;
          seaAt = y;
          surface.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`;
        },
      });
      let width = 0;
      let height = 0;
      let tweens: gsap.core.Tween[] = [];
      let plotted = '';

      // Text, cards and pins are read once per refresh; the meteors are rescheduled only when the page has changed.
      const plan = () => {
        if (!width) return;
        const layout = measure(width, height);
        if (!layout) return;
        sky.layout(layout);
        if (still) return;
        const flights = schedule(layout, phone);
        const key = flights.map(({ start, end }) => `${Math.round(start)}:${Math.round(end)}`).join() + width;
        if (key === plotted) return;
        plotted = key;
        for (const tween of tweens) tween.kill();
        const moving = sky.fly(flights.map(({ flight }) => flight));
        tweens = flights.map(({ start, end }, index) =>
          gsap.fromTo(
            moving[index],
            { t: 0 },
            {
              t: DRAIN,
              ease: 'none',
              immediateRender: false,
              onUpdate: sky.wake,
              scrollTrigger: { start, end: end + (end - start) * (DRAIN - 1), scrub: phone ? 0.5 : 0.8 },
            },
          ),
        );
      };

      const observer = new ResizeObserver(([entry]) => {
        width = entry.contentRect.width;
        height = entry.contentRect.height;
        sky.resize(width, height);
        plan();
      });
      observer.observe(element);
      ScrollTrigger.addEventListener('refresh', plan);
      void document.fonts.ready.then(plan);

      // The page's own scroll position, read by ScrollTrigger and handed over; nothing here listens to scroll.
      const reader = ScrollTrigger.create({ start: 0, end: 'max', onUpdate: (self) => sky.scroll(self.scroll()), onRefresh: (self) => sky.scroll(self.scroll()) });
      sky.scroll(reader.scroll());
      gsap.to('.descent-art__sky', { opacity: 1, ease: 'power1.in', scrollTrigger: { start: 0, end: 'max', scrub: true } });
      // The sea is fetched only once the close is near.
      ScrollTrigger.create({ start: () => ScrollTrigger.maxScroll(window) * 0.55, once: true, onEnter: () => setWater(true) });

      const move = (event: PointerEvent) => {
        if (event.pointerType === 'mouse') sky.point(event.clientX, event.clientY, true);
      };
      const leave = (event: PointerEvent) => sky.point(event.clientX, event.clientY, false);
      const visible = () => (document.hidden ? sky.stop() : sky.start());
      if (fine && !still) {
        window.addEventListener('pointermove', move, { passive: true });
        document.documentElement.addEventListener('pointerleave', leave);
      }
      document.addEventListener('visibilitychange', visible);
      visible();
      root.current!.dataset.ready = 'true';

      return () => {
        observer.disconnect();
        ScrollTrigger.removeEventListener('refresh', plan);
        window.removeEventListener('pointermove', move);
        document.documentElement.removeEventListener('pointerleave', leave);
        document.removeEventListener('visibilitychange', visible);
        for (const tween of tweens) tween.kill();
        sky.stop();
        delete root.current?.dataset.ready;
      };
    });
    return () => mm.revert();
  }, []);

  return (
    <div ref={root} className="descent-art" aria-hidden="true">
      <div className="descent-art__sky" />
      <div ref={sea} className="descent-art__sea">
        {water ? (
          <picture>
            <source media={PHONE} type="image/avif" srcSet="/art/descent/sea-phone.avif" />
            <source media={PHONE} type="image/webp" srcSet="/art/descent/sea-phone.webp" />
            <source type="image/avif" srcSet="/art/descent/sea-desktop.avif" />
            <img src="/art/descent/sea-desktop.webp" width="1760" height="621" alt="" decoding="async" draggable={false} onLoad={(event) => (event.currentTarget.dataset.loaded = 'true')} />
          </picture>
        ) : null}
      </div>
      <canvas ref={canvas} className="descent-art__stars" />
    </div>
  );
}
