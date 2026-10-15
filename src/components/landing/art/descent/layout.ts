import { ScrollTrigger } from '../../motion';
import type { Clearing, Layout } from './sky';

/*
 * Where the page puts its text and its cards, read once per refresh, never per frame. Text that sits on the sky gets
 * a clearing; text inside an opaque card needs none, since the card hides the sky. Along the centre line, the gaps
 * between them are where a meteor's merge into main can be seen.
 */

/** A stretch of the centre line that a card or a line of text covers, in unpinned page pixels. */
export interface Cover {
  y0: number;
  y1: number;
  pin: { start: number; end: number } | null;
}

export interface Plan extends Layout {
  covers: Cover[];
  /** The merge queue's heading, where three meteors braid into main. */
  queue: Cover | null;
}

interface Pin {
  element: Element;
  start: number;
  end: number;
}

interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pin: Pin | null;
  water: boolean;
}

/** The alpha of a computed background colour, whichever syntax the browser serializes it in. */
function alphaOf(colour: string) {
  if (colour === 'transparent') return 0;
  const numbers = colour.match(/-?[\d.]+%?/g) ?? [];
  if (colour.startsWith('rgba(')) return parseFloat(numbers[3] ?? '1');
  if (!colour.includes('/')) return 1;
  const last = numbers.at(-1) ?? '1';
  return last.endsWith('%') ? parseFloat(last) / 100 : parseFloat(last);
}

export function measure(width: number, height: number): Plan | null {
  const main = document.querySelector<HTMLElement>('.landing main');
  const hero = document.querySelector('[data-breath="hero"]');
  if (!main || !hero) return null;
  const scrolled = window.scrollY;
  const maxScroll = ScrollTrigger.maxScroll(window);
  const pins: Pin[] = ScrollTrigger.getAll()
    .filter((trigger) => trigger.pin)
    .map((trigger) => ({ element: trigger.pin!, start: trigger.start, end: trigger.end }));
  const pinOf = (element: Element) => pins.find((pin) => pin.element.contains(element)) ?? null;
  // A pinned scene sits where the page held it; its unpinned page position is its screen position plus the scroll it skipped.
  const pageY = (top: number, pin: Pin | null) => top + scrolled - (pin ? Math.min(pin.end - pin.start, Math.max(0, scrolled - pin.start)) : 0);

  const opaque = new Map<Element, boolean>();
  const isOpaque = (element: Element) => {
    let known = opaque.get(element);
    if (known === undefined) {
      known = alphaOf(getComputedStyle(element).backgroundColor) >= 0.9;
      opaque.set(element, known);
    }
    return known;
  };
  const cards = new Set<Element>();
  const cardOf = (element: Element) => {
    let card: Element | null = null;
    for (let at: Element | null = element; at && at !== main; at = at.parentElement) if (isOpaque(at)) card = at;
    return card;
  };

  const blocks = new Map<Element, Block>();
  const grow = (key: Element, box: { left: number; top: number; right: number; bottom: number }) => {
    const pin = pinOf(key);
    const y0 = pageY(box.top, pin);
    const y1 = pageY(box.bottom, pin);
    const block = blocks.get(key);
    if (block) {
      block.x0 = Math.min(block.x0, box.left);
      block.x1 = Math.max(block.x1, box.right);
      block.y0 = Math.min(block.y0, y0);
      block.y1 = Math.max(block.y1, y1);
    } else blocks.set(key, { x0: box.left, y0, x1: box.right, y1, pin, water: !!key.closest('footer') });
  };
  const range = document.createRange();
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !/\S/.test(node.nodeValue ?? '')) continue;
    const card = cardOf(parent);
    if (card) {
      cards.add(card);
      continue;
    }
    if (parent instanceof SVGElement) {
      // A figure's labels can move as it plays, so the whole figure is given room.
      const figure = parent.ownerSVGElement ?? parent;
      if (!blocks.has(figure)) grow(figure, figure.getBoundingClientRect());
      continue;
    }
    range.selectNodeContents(node);
    // Split heading lines rise from below as they play; the heading's own box is where they come to rest.
    const heading = parent.closest('h1, h2, h3, h4');
    const container = heading ?? parent.closest('p, li, a, dt, dd, figcaption, label') ?? parent;
    const rest = heading?.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) continue;
      grow(container, rest ? { left: rect.left, right: rect.right, top: rest.top, bottom: rest.bottom } : rect);
    }
  }

  // Neighbouring text shares one clearing.
  const merged: Block[] = [];
  for (const block of blocks.values()) {
    const near = merged.find((other) => other.pin === block.pin && other.water === block.water && block.x0 < other.x1 + 20 && block.x1 > other.x0 - 20 && block.y0 < other.y1 + 20 && block.y1 > other.y0 - 20);
    if (!near) {
      merged.push({ ...block });
      continue;
    }
    near.x0 = Math.min(near.x0, block.x0);
    near.x1 = Math.max(near.x1, block.x1);
    near.y0 = Math.min(near.y0, block.y0);
    near.y1 = Math.max(near.y1, block.y1);
  }
  const clearings: Clearing[] = merged.map((block) => ({
    x: block.x0,
    y: block.y0,
    w: block.x1 - block.x0,
    h: block.y1 - block.y0,
    pin: block.pin ? { start: block.pin.start, end: block.pin.end } : null,
    water: block.water,
  }));

  const centre = width / 2;
  const heroBox = hero.getBoundingClientRect();
  const spineTop = pageY(heroBox.bottom, null) + 18;
  const footer = main.querySelector('footer');
  const close = document.querySelector('[data-breath="close"]');
  let horizon = maxScroll + height * 0.78;
  if (close && footer) {
    // The horizon lies between the close's last card, its prompt, and the footer, so the footer sits on the water.
    let last = close.getBoundingClientRect().top;
    for (const card of cards) if (close.contains(card)) last = Math.max(last, card.getBoundingClientRect().bottom);
    const foot = footer.getBoundingClientRect().top;
    horizon = pageY(last + (foot - last) * 0.5, null);
  }
  horizon = Math.min(maxScroll + height - 96, Math.max(maxScroll + height * 0.5, horizon));

  // Along main, what each card and each line of text covers; a pinned one covers it only while it is in view.
  const covers: Cover[] = [];
  const plain = (pin: Pin | null) => (pin ? { start: pin.start, end: pin.end } : null);
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (box.left > centre || box.right < centre) continue;
    const pin = pinOf(card);
    covers.push({ y0: pageY(box.top, pin) - 10, y1: pageY(box.bottom, pin) + 10, pin: plain(pin) });
  }
  for (const block of merged) {
    if (block.x0 > centre + 48 || block.x1 < centre - 48) continue;
    covers.push({ y0: block.y0 - 40, y1: block.y1 + 40, pin: plain(block.pin) });
  }
  const heading = document.querySelector('[data-breath="queue"] h2');
  let queue: Cover | null = null;
  if (heading) {
    const pin = pinOf(heading);
    const box = heading.getBoundingClientRect();
    queue = { y0: pageY(box.top, pin), y1: pageY(box.bottom, pin), pin: plain(pin) };
  }
  return { width, height, maxScroll, spineTop, horizon, clearings, covers, queue };
}
