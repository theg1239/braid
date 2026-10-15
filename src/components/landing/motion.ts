import type { RefObject } from 'react';
import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { useGSAP } from '@gsap/react';

/*
 * The landing page's motion, and the only place GSAP is loaded from: the landing chunk is lazy, so none of this
 * reaches the app shell. Every figure renders its final state; motion only sets where things start, before the
 * first paint, and plays them in. With reduced motion nothing is set, so everything simply shows.
 */
gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin);

export { gsap, ScrollTrigger, SplitText };

/** Tall desktops get the scrubbed, pinned scene; phones and short windows play it once instead. */
const MEDIA = { motion: '(prefers-reduced-motion: no-preference)', wide: '(min-width: 1000px) and (min-height: 760px)', narrow: '(max-width: 760px)' };

/** What a figure's motion may depend on: whether a scene may be held and scrubbed, and whether it is drawn for a phone. */
interface Media {
  wide: boolean;
  narrow: boolean;
}

export const EASE = 'expo.out';
/** One reveal's length, and one step's, so every scene keeps the same pace. */
export const REVEAL = 1;
export const STEP = 0.5;

/** Text the running build changed, put back when its motion is reverted. */
let restores: (() => void)[] = [];

/**
 * Builds a figure's motion inside its own scope, reverted on unmount (the landing page unmounts when someone
 * signs in) and rebuilt when the viewer's media or `dependencies` change.
 */
export function useMotion(scope: RefObject<HTMLElement | null>, build: (media: Media) => void, dependencies: unknown[] = []) {
  useGSAP(
    () => {
      gsap.matchMedia().add(MEDIA, (context) => {
        const { motion, wide, narrow } = context.conditions ?? {};
        if (!motion) return;
        const own: (() => void)[] = (restores = []);
        build({ wide: !!wide, narrow: !!narrow });
        return () => own.forEach((restore) => restore());
      });
    },
    { scope, dependencies, revertOnUpdate: true },
  );
}

/** Listens for as long as the motion that needs it is built. */
export function listen(target: EventTarget, type: string, listener: (event: Event) => void) {
  target.addEventListener(type, listener);
  restores.push(() => target.removeEventListener(type, listener));
}

/**
 * Links and buttons fade with opacity alone, so they stay in the Tab order before they are played in; focusing
 * one inside a picture or sentence that has not played yet finishes it at once, so focus never lands on something unseen.
 */
export function revealOnFocus(root: Element) {
  listen(root, 'focusin', (event) => {
    for (const trigger of ScrollTrigger.getAll()) {
      const { animation, vars } = trigger;
      if (animation && !vars.scrub && trigger.trigger instanceof Element && trigger.trigger.contains(event.target as Node)) animation.progress(1);
    }
  });
}

/** Shows `text` in place of what `target` renders until the motion is reverted. */
export function holdText(target: Element, text: string) {
  const final = target.textContent ?? '';
  target.textContent = text;
  restores.push(() => {
    target.textContent = final;
  });
  return final;
}

/** Plays once when `trigger` is a little way into the viewport. */
export const onEnter = (trigger: Element | string, start = 'top 82%') => ({ trigger, start, once: true });

/** Lines rise into place from behind their own masks. Re-split on resize and font load, keeping progress. */
export function riseLines(target: Element, vars: gsap.TweenVars = {}) {
  SplitText.create(target, {
    type: 'lines',
    mask: 'lines',
    linesClass: 'lp-line',
    autoSplit: true,
    onSplit: (split) => gsap.from(split.lines, { yPercent: 115, duration: 0.9, ease: EASE, stagger: 0.08, ...vars }),
  });
}

/**
 * Characters appear one after another, as typed, and become plain text again once typed so screen readers
 * read the command whole. Returns the tween so a timeline can place it.
 */
export function typeOut(target: Element, perChar = 0.022) {
  const split = SplitText.create(target, { type: 'chars', reduceWhiteSpace: false, aria: 'none' });
  return gsap.from(split.chars, { autoAlpha: 0, duration: 0.01, stagger: perChar, ease: 'none', onComplete: () => split.revert() });
}

/** A number counting up to the value it renders, with its decimals. Its box is sized for the final value. */
export function countUp(target: Element, vars: gsap.TweenVars, decimals = 0) {
  const counter = { value: 0 };
  const final = holdText(target, counter.value.toFixed(decimals));
  return gsap.to(counter, {
    value: Number(final),
    ease: 'power2.out',
    ...vars,
    onUpdate: () => {
      target.textContent = counter.value.toFixed(decimals);
    },
  });
}
