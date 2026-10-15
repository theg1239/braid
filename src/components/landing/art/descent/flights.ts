import type { Cover, Plan } from './layout';
import type { Flight } from './sky';

/*
 * The scroll ranges and curves of the shooting stars. Each single falls from the outer sky and sweeps into main the
 * way the close's strands do, crossing the centre a little before it joins, and arrives where main can be seen
 * between the page's cards and text when a nearby moment allows; otherwise it dives behind a card on its way in.
 */

export interface Scheduled {
  flight: Flight;
  /** Scroll positions where the flight starts and where its head meets main; its trail drains a little after. */
  start: number;
  end: number;
}

const SINGLES = 11;

const hash = (n: number) => {
  const x = Math.sin(n * 91.345 + 17.2) * 43758.5453;
  return x - Math.floor(x);
};

/** A single's curve, from a point in the outer sky to main at height `merge`, joining it heading down. */
function single(index: number, merge: number, phone: boolean): Flight {
  const left = index % 2 === 0;
  const side = left ? 1 : -1;
  const fromTop = hash(index) < 0.55;
  const x0 = fromTop ? 0.5 - side * (0.3 + hash(index + 9) * 0.17) : 0.5 - side * (0.53 + hash(index + 4) * 0.04);
  const y0 = fromTop ? -0.04 : 0.04 + hash(index + 2) * 0.16;
  const dy = merge - y0;
  return {
    t: 0,
    from: [x0, y0],
    via: [
      [x0 + (0.5 - x0) * (fromTop ? 0.16 : 0.42), y0 + dy * (fromTop ? 0.46 : 0.14)],
      [0.5 + side * (phone ? 0.05 : 0.035), merge - dy * 0.34],
    ],
    merge,
    trail: (phone ? 180 : 210) + hash(index + 7) * (phone ? 70 : 110),
    glow: 0.82 + hash(index + 3) * 0.18,
  };
}

/**
 * The braid: three arrive together, as the merge queue's figure draws them. The outer two sweep in from either side
 * and cross each other on main's line twice, swinging narrower each time; the third weaves down between them. It is
 * drawn on the page, in the open stretch of sky above the queue's heading, so all of it can be seen.
 */
function braid(top: number, merge: number, anchor: number, width: number, height: number): Flight[] {
  const phone = width <= 760;
  // The swings keep the braid's proportions in whatever height of open sky it has: about half as wide as it is tall.
  const swing = Math.min(phone ? 0.36 : 0.28, (0.62 * (merge - top) * height) / width);
  const x = (offset: number) => Math.min(0.97, Math.max(0.03, 0.5 + offset * swing));
  const y = (f: number) => top + (merge - top) * f;
  const outer = (side: number): Flight => ({
    t: 0,
    from: [0.5 - side * 0.58, y(0.02)],
    via: [
      [x(-side), y(0.18)],
      [0.5, y(0.4)],
      [x(side * 0.55), y(0.58)],
      [0.5, y(0.74)],
      [x(-side * 0.18), y(0.87)],
    ],
    merge,
    trail: phone ? 220 : 300,
    glow: 1,
    anchor,
  });
  const middle: Flight = {
    t: 0,
    from: [0.5, y(-0.7)],
    via: [
      [x(-0.1), y(0.1)],
      [x(0.12), y(0.42)],
      [x(-0.1), y(0.7)],
    ],
    merge,
    trail: phone ? 190 : 250,
    glow: 0.9,
    anchor,
  };
  return [outer(1), outer(-1), middle];
}

/** Where a pinned or unpinned stretch of the page is on screen at scroll `at`. */
const onScreen = (cover: Cover, at: number) => {
  const held = cover.pin ? Math.min(cover.pin.end - cover.pin.start, Math.max(0, at - cover.pin.start)) : 0;
  return [cover.y0 - at + held, cover.y1 - at + held];
};

/** The open stretches of main between `top` and `bottom` on screen at scroll `at`, in viewport pixels. */
function stretches(plan: Plan, at: number, top: number, bottom: number) {
  const spans = plan.covers.map((cover) => onScreen(cover, at)).sort((a, b) => a[0] - b[0]);
  const found: [number, number][] = [];
  let cursor = Math.max(top, plan.spineTop - at + 30);
  for (const [y0, y1] of [...spans, [bottom, bottom]]) {
    const end = Math.min(y0, bottom);
    if (end - cursor >= 56) found.push([cursor, end]);
    cursor = Math.max(cursor, y1);
    if (cursor >= bottom) break;
  }
  return found;
}

/** The height, as a fraction of the viewport, where a meteor can be seen to meet main near `prefer` at scroll `at`. */
function openAt(plan: Plan, at: number, prefer: number) {
  const { height } = plan;
  let best: number | null = null;
  for (const [y0, y1] of stretches(plan, at, height * 0.16, height * 0.66)) {
    const y = Math.min(y1 - 28, Math.max(y0 + 28, prefer * height));
    if (best === null || Math.abs(y - prefer * height) < Math.abs(best - prefer * height)) best = y;
  }
  return best === null ? null : best / height;
}

export function schedule(plan: Plan, phone: boolean): Scheduled[] {
  const { height, maxScroll } = plan;
  const flights: Scheduled[] = [];
  const span = height * 0.62;
  // The braid plays in the open sky above the merge queue's heading, finishing as that stretch reaches mid-window.
  let braidAt: [number, number] | null = null;
  if (plan.queue) {
    const settle = plan.queue.y0 - height * 0.8;
    const open = settle > 0 && settle < maxScroll ? stretches(plan, settle, height * 0.04, height * 0.78) : [];
    const widest = open.reduce<[number, number] | null>((a, b) => (!a || b[1] - b[0] > a[1] - a[0] ? b : a), null);
    if (widest) {
      // The stretch's lower edge comes to rest at 62% of the window when the three meet main.
      const end = settle + widest[1] - 24 - height * 0.62;
      const top = (widest[0] + 8 - (widest[1] - 24) + height * 0.62) / height;
      for (const flight of braid(Math.max(0.06, top), 0.62, end, plan.width, height)) flights.push({ flight, start: Math.max(0, end - height * 0.5), end });
      braidAt = [end - height * 0.5, end + height * 0.3];
    }
  }
  // The singles are spread evenly down the scroll the braid leaves free, each arriving where main can be seen if a
  // moment nearby allows it.
  const from = maxScroll * 0.05;
  const to = maxScroll * 0.97;
  const skip = braidAt ? Math.max(0, Math.min(to, braidAt[1]) - Math.max(from, braidAt[0])) : 0;
  for (let index = 0; index < SINGLES; index++) {
    let slot = from + ((to - from - skip) * index) / (SINGLES - 1);
    if (braidAt && slot > braidAt[0]) slot += skip;
    const prefer = 0.3 + hash(index + 11) * 0.16;
    let end = slot;
    let merge: number | null = null;
    for (const nudge of [0, -0.12, 0.12, -0.24, 0.24]) {
      const at = Math.min(maxScroll, Math.max(span * 0.6, slot + nudge * height));
      merge = openAt(plan, at, prefer);
      if (merge !== null) {
        end = at;
        break;
      }
    }
    flights.push({ flight: single(index, merge ?? prefer, phone), start: Math.max(0, end - span * (0.85 + hash(index + 5) * 0.3)), end });
  }
  return flights.sort((a, b) => a.start - b.start);
}
