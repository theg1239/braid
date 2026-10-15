/*
 * The descent's sky, drawn on one canvas from cached pieces. On a laptop the far and mid star layers are rendered once
 * per size into tiles, two breathing groups each, and moved with drawImage offsets; only the near dust, the meteors,
 * the spine and the sea's light are drawn star by star or stroke by stroke. A phone has few enough stars that drawing
 * each one costs less than blending whole tiles, so there every star is stamped and thinned around text on its own.
 * Nothing here reads layout: sizes, text and pins arrive with `layout`, the scroll position with `scroll`.
 */

/** A rectangle of page text the stars thin out around, in page pixels. */
export interface Clearing {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The scroll range a pinned scene holds this text still for, if any. */
  pin: { start: number; end: number } | null;
  /** Footer text sits on the water, so main's reflection gives it room too. */
  water: boolean;
}

export interface Layout {
  width: number;
  height: number;
  maxScroll: number;
  /** Page y where main starts, under the hero's prompt, and where it meets the horizon at the close. */
  spineTop: number;
  horizon: number;
  clearings: Clearing[];
}

/**
 * A shooting star. `t` runs from 0 to 1 while its head travels from the outer sky to main, then on to DRAIN while its
 * trail runs into main after it. Points are fractions of the viewport.
 */
export interface Flight {
  t: number;
  from: [number, number];
  via: [number, number][];
  merge: number;
  trail: number;
  glow: number;
  /** Set for a flight drawn on the page rather than the sky: the scroll position its points are placed for. */
  anchor?: number;
}

export const DRAIN = 1.3;

interface Options {
  phone: boolean;
  still: boolean;
  pointer: boolean;
  /** Told where the sea's top edge is, in viewport pixels, whenever it moves. */
  sea: (y: number) => void;
}

interface Star {
  x: number;
  y: number;
  alpha: number;
  sprite: number;
  phase: number;
}

interface Layer {
  factor: number;
  period: number;
  stars: Star[];
  groups: HTMLCanvasElement[];
  phases: number[];
  seed: number;
}

interface Path {
  points: Float32Array;
  lengths: Float32Array;
  total: number;
}

interface Flying extends Flight {
  path: Path | null;
  merged: boolean;
  drawn: number;
}

const COOL = [207, 216, 255];
const WARM = [255, 241, 214];
const TINTS = 4;
const SIZES = 8;
const CELL = 12;
const BREATH = (Math.PI * 2) / 6000;
const PARTING = { radius: 90, push: 6 };
const LIGHT = '214,224,246';

/** Deterministic randomness, so every visit and every capture sees the same sky. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (n: number, seed: number) => {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function surface(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = Math.max(1, Math.ceil(width));
  element.height = Math.max(1, Math.ceil(height));
  return element;
}

/** A curve sampled once into an arc-length table: a cubic Bézier through four points, a Catmull-Rom spline through more. */
function curve(p: number[][]): Path {
  const xs: number[] = [];
  const ys: number[] = [];
  if (p.length === 4) {
    for (let i = 0; i <= 72; i++) {
      const t = i / 72;
      const u = 1 - t;
      xs.push(u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0]);
      ys.push(u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]);
    }
  } else {
    const q = [p[0], ...p, p[p.length - 1]];
    for (let k = 1; k < q.length - 2; k++) {
      for (let i = 0; i < 18; i++) {
        const t = i / 18;
        const [a, b, c, d] = [q[k - 1], q[k], q[k + 1], q[k + 2]];
        const at = (n: number) => 0.5 * (2 * b[n] + (c[n] - a[n]) * t + (2 * a[n] - 5 * b[n] + 4 * c[n] - d[n]) * t * t + (3 * b[n] - a[n] - 3 * c[n] + d[n]) * t * t * t);
        xs.push(at(0));
        ys.push(at(1));
      }
    }
    xs.push(p[p.length - 1][0]);
    ys.push(p[p.length - 1][1]);
  }
  const points = new Float32Array(xs.length * 2);
  const lengths = new Float32Array(xs.length);
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    if (i) total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    points[i * 2] = xs[i];
    points[i * 2 + 1] = ys[i];
    lengths[i] = total;
  }
  return { points, lengths, total };
}

/** The point `s` pixels along a path. */
function along(path: Path, s: number, out: number[]) {
  const { points, lengths, total } = path;
  const at = Math.min(total, Math.max(0, s));
  let low = 0;
  let high = lengths.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (lengths[mid] < at) low = mid;
    else high = mid;
  }
  const f = (at - lengths[low]) / (lengths[high] - lengths[low] || 1);
  out[0] = points[low * 2] + (points[high * 2] - points[low * 2]) * f;
  out[1] = points[low * 2 + 1] + (points[high * 2 + 1] - points[low * 2 + 1]) * f;
  return out;
}

/** Star sprites by size and colour temperature: a crisp core and a soft natural bloom, centred on a device pixel. */
function sprites(ratio: number) {
  const cell = Math.ceil(CELL * ratio) | 1;
  const atlas = surface(cell * SIZES, cell * TINTS);
  const c = atlas.getContext('2d')!;
  const centre = (cell - 1) / 2;
  for (let tint = 0; tint < TINTS; tint++) {
    const mix = tint / (TINTS - 1);
    const rgb = COOL.map((cool, i) => Math.round(cool + (WARM[i] - cool) * mix)).join(',');
    for (let size = 0; size < SIZES; size++) {
      const core = ((0.5 + (1.3 * size) / (SIZES - 1)) / 2) * ratio;
      const bloom = core * (2.4 + size * 0.45);
      const x = size * cell + centre + 0.5;
      const y = tint * cell + centre + 0.5;
      const g = c.createRadialGradient(x, y, 0, x, y, bloom);
      g.addColorStop(0, `rgba(${rgb},1)`);
      g.addColorStop(Math.min(0.8, (core / bloom) * 0.7), `rgba(${rgb},0.9)`);
      g.addColorStop(Math.min(0.9, (core / bloom) * 1.35), `rgba(${rgb},${0.1 + size * 0.02})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = g;
      c.fillRect(x - bloom - 1, y - bloom - 1, bloom * 2 + 2, bloom * 2 + 2);
    }
  }
  return { atlas, cell, centre };
}

export function descentSky(element: HTMLCanvasElement, options: Options) {
  const ctx = element.getContext('2d')!;
  const { phone, still } = options;
  const sparse = phone;
  const ratio = Math.min(window.devicePixelRatio || 1, phone ? 1.5 : 2);
  const sprite = sprites(ratio);
  let width = 0;
  let height = 0;
  let layout: Layout | null = null;
  let layers: Layer[] = [];
  let near: Star[] = [];
  let clearings: { box: Clearing; mask: HTMLCanvasElement }[] = [];
  let flights: Flying[] = [];
  const pulses: { y: number; born: number; strength: number }[] = [];
  let idle: { path: Path; born: number; duration: number; trail: number; merged: boolean } | null = null;
  let nextIdle = performance.now() + 3000;
  let scroll = 0;
  let movedAt = 0;
  let frame = 0;
  let drawnAt = 0;
  let running = false;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, strength: 0, target: 0, movedAt: 0 };
  const head = [0, 0];
  const point = [0, 0];
  /** This frame's clearings on screen: the text's box, and how far around it the stars stay thinned. */
  let open: { x0: number; y0: number; x1: number; y1: number; pad: number; reach: number; water: boolean; mask: HTMLCanvasElement }[] = [];

  /** Text keeps PAD pixels of empty sky around it, and the stars return over the next FEATHER. */
  const PAD = phone ? 8 : 18;
  const REACH = PAD + (phone ? 30 : 76);
  /** Device-pixel snapping keeps every star a crisp point as its layer moves. */
  const snap = (v: number) => Math.round(v * ratio) / ratio;
  /** Every star breathes on one six-second cycle, each a little out of step: a shimmer, never a blink. */
  const breath = (now: number, phase: number) => (still ? 1 : 1 + 0.2 * Math.sin(now * BREATH + phase)) / 1.2;

  function stars(count: number, area: [number, number], rand: () => number, sizes: [number, number], alphas: [number, number]) {
    const list: Star[] = [];
    for (let i = 0; i < count; i++) {
      const size = sizes[0] + (sizes[1] - sizes[0]) * rand() ** 1.7;
      list.push({
        x: rand() * area[0],
        y: CELL / 2 + rand() * (area[1] - CELL),
        alpha: alphas[0] + (alphas[1] - alphas[0]) * rand() ** 1.3,
        sprite: Math.round(((size - 0.5) / 1.3) * (SIZES - 1)) + Math.min(TINTS - 1, Math.floor(rand() ** 1.5 * TINTS)) * SIZES,
        phase: (rand() - 0.5) * 1.8,
      });
    }
    return list;
  }

  /** Stamps one star in device pixels; the transform must be the identity. */
  function stamp(c: CanvasRenderingContext2D, star: Star, x: number, y: number, alpha: number) {
    c.globalAlpha = alpha;
    c.drawImage(sprite.atlas, (star.sprite % SIZES) * sprite.cell, Math.floor(star.sprite / SIZES) * sprite.cell, sprite.cell, sprite.cell, Math.round(x * ratio - sprite.centre), Math.round(y * ratio - sprite.centre), sprite.cell, sprite.cell);
  }

  /** A star layer as a wrapping tile, its stars split between two groups that breathe a little out of step. A phone keeps only the list. */
  function layer(list: Star[], period: number, factor: number, phases: number[], seed: number): Layer {
    if (sparse) return { factor, period, stars: list, groups: [], phases, seed };
    const groups = phases.map(() => surface(width * ratio, period * ratio));
    const contexts = groups.map((group) => group.getContext('2d')!);
    for (const [index, star] of list.entries()) {
      const c = contexts[index % groups.length];
      stamp(c, star, star.x, star.y, star.alpha);
      // Seamless across the tile's left and right edges, which a repeat may turn to any position.
      if (star.x < CELL) stamp(c, star, star.x + width, star.y, star.alpha);
      if (star.x > width - CELL) stamp(c, star, star.x - width, star.y, star.alpha);
    }
    return { factor, period, stars: list, groups, phases, seed };
  }

  function build() {
    const area = width * height;
    // About 260 stars on a phone and 700 on a laptop, scaled by the viewport's area.
    const small = 390 * 844;
    const large = 1440 * 900;
    const total = Math.round(area <= large ? 260 + 440 * Math.max(0, (area - small) / (large - small)) : Math.min(1100, (700 * area) / large));
    const rand = random(0x0b1020);
    const period = Math.round(height * 0.5 * ratio) / ratio;
    const factors = still ? [1, 1, 1] : [0.04, 0.12, 0.3];
    const share = period / height;
    // A phone's coarser canvas softens the smallest stars, so its sizes lean toward the top of the range.
    const lift = phone ? 0.2 : 0;
    layers = [
      layer(stars(Math.round(total * 0.62 * share), [width, period], rand, [0.5 + lift, 0.95 + lift], [0.4, 0.78]), period, factors[0], [-0.6, 0.55], 3),
      layer(stars(Math.round(total * 0.28 * share), [width, period], rand, [0.8 + lift, 1.4 + lift], [0.52, 0.92]), period, factors[1], [-0.35, 0.75], 7),
    ];
    // The near dust is few enough to draw star by star, so each keeps its own breath and the cursor can part it.
    const reach = height + factors[2] * (layout?.maxScroll ?? height * 5) + CELL;
    near = stars(Math.round((total * 0.1 * reach) / height), [width, reach], rand, [1.2, 1.8], [0.62, 1]).sort((a, b) => a.y - b.y);
  }

  /** Each clearing's soft mask at a quarter resolution: empty around the text, the stars returning over REACH pixels. */
  function makeClearings() {
    if (!layout) return;
    const pad = PAD;
    const reach = REACH;
    const scale = 0.25;
    clearings = layout.clearings.map((box) => {
      const w = box.w + reach * 2;
      const h = box.h + reach * 2;
      const mask = surface(w * scale, h * scale);
      const c = mask.getContext('2d')!;
      const image = c.createImageData(mask.width, mask.height);
      for (let j = 0; j < mask.height; j++) {
        const y = (j + 0.5) / scale;
        const dy = Math.max(reach - y, 0, y - (h - reach));
        for (let i = 0; i < mask.width; i++) {
          const x = (i + 0.5) / scale;
          const d = Math.hypot(Math.max(reach - x, 0, x - (w - reach)), dy);
          image.data[(j * mask.width + i) * 4 + 3] = Math.round(255 * (1 - smooth(pad, reach, d)));
        }
      }
      c.putImageData(image, 0, 0);
      return { box, mask };
    });
  }

  function makePaths() {
    for (const flight of flights) flight.path = curve([flight.from, ...flight.via, [0.5, flight.merge]].map(([x, y]) => [x * width, y * height]));
  }

  /** The screen y of a page y, for text a pinned scene holds still while the page scrolls under it. */
  const screenY = (y: number, pin: Clearing['pin']) => y - scroll + (pin ? Math.min(pin.end - pin.start, Math.max(0, scroll - pin.start)) : 0);

  /** Main grows with the reader's progress, from under the hero's prompt to the horizon at the close, always reaching well down the window. */
  function spineTip(at: Layout) {
    const start = at.spineTop + 90;
    if (still || at.maxScroll <= 0) return at.horizon;
    return Math.min(at.horizon, Math.max(start + (at.horizon - start) * Math.min(1, scroll / at.maxScroll), scroll + height * 0.72));
  }

  /** The horizon rises from below through the last quarter of the scroll, more slowly than the page. */
  function seaLine(at: Layout) {
    const final = at.horizon - at.maxScroll;
    if (still) return at.horizon - scroll;
    return final + (at.maxScroll - scroll) * ((height + 40 - final) / Math.max(1, at.maxScroll * 0.26));
  }

  function drawLayer({ factor, period, groups, phases, seed }: Layer, now: number, sea: number) {
    const offset = scroll * factor;
    let p = Math.floor(offset / period);
    for (let top = p * period - offset; top < sea; top += period, p++) {
      const y0 = Math.max(0, -top);
      const y1 = Math.min(period, sea - top);
      if (y1 <= y0) continue;
      // Each repeat of the tile is turned by its own amount, so the field never visibly repeats.
      const shift = p ? Math.round(hash(p, seed) * width * ratio) : 0;
      const sy = Math.round(y0 * ratio);
      const sh = Math.round((y1 - y0) * ratio);
      const dy = Math.round((top + y0) * ratio);
      for (const [g, group] of groups.entries()) {
        ctx.globalAlpha = breath(now, phases[g]);
        const right = group.width - shift;
        ctx.drawImage(group, 0, sy, right, sh, shift, dy, right, sh);
        if (shift) ctx.drawImage(group, right, sy, shift, sh, 0, dy, shift, sh);
      }
    }
  }

  /** How much room the text leaves a star at this point: 0 beside the text, rising to 1 at the clearing's edge. */
  function clearance(x: number, y: number, water = false) {
    let room = 1;
    for (const c of open) {
      if (water && !c.water) continue;
      const dx = Math.max(c.x0 - x, 0, x - c.x1);
      const dy = Math.max(c.y0 - y, 0, y - c.y1);
      if (dx >= c.reach || dy >= c.reach) continue;
      room *= smooth(c.pad, c.reach, Math.hypot(dx, dy));
      if (room <= 0) return 0;
    }
    return room;
  }

  /** Pushes a star gently away from the cursor, up to six pixels at its centre and none past its radius. */
  function parted(x: number, y: number) {
    point[0] = x;
    point[1] = y;
    if (pointer.strength < 0.01) return point;
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    const d = Math.hypot(dx, dy);
    if (d >= PARTING.radius || d < 0.5) return point;
    const push = (PARTING.push * pointer.strength * (1 - d / PARTING.radius) ** 2) / d;
    point[0] += dx * push;
    point[1] += dy * push;
    return point;
  }

  /** Visits a layer's stars on screen, through every repeat of its tile, each with its own breath. */
  function eachStar({ factor, period, stars: list, phases, seed }: Layer, sea: number, from: number, to: number, visit: (star: Star, x: number, y: number, phase: number) => void) {
    const offset = scroll * factor;
    for (let p = Math.floor((from + offset) / period); p * period - offset < Math.min(to, sea); p++) {
      const shift = p ? Math.round(hash(p, seed) * width * ratio) / ratio : 0;
      const top = p * period - offset;
      for (const [index, star] of list.entries()) {
        const y = top + star.y;
        if (y < from - CELL || y > to + CELL || y > sea) continue;
        let x = star.x + shift;
        if (x >= width) x -= width;
        visit(star, x, y, sparse ? star.phase : phases[index % phases.length]);
      }
    }
  }

  /** A phone stamps each star on its own, thinned by the text around it. */
  function drawStars(each: Layer, now: number, sea: number) {
    eachStar(each, sea, 0, height, (star, x, y, phase) => {
      const room = clearance(x, y);
      if (room <= 0.02) return;
      const [px, py] = parted(x, y);
      stamp(ctx, star, px, py, star.alpha * breath(now, phase) * room);
    });
  }

  /** On a laptop, clears a disc around the cursor and redraws the tile stars inside it, pushed gently outward. */
  function part(now: number, sea: number) {
    const r = PARTING.radius + 4;
    for (const each of layers) {
      eachStar(each, sea, pointer.y - r, pointer.y + r, (star, x, y, phase) => {
        if (Math.hypot(x - pointer.x, y - pointer.y) > r) return;
        const [px, py] = parted(x, y);
        stamp(ctx, star, px, py, star.alpha * breath(now, phase));
      });
    }
  }

  function drawNear(now: number, sea: number) {
    const offset = scroll * (still ? 1 : 0.3);
    let low = 0;
    let high = near.length;
    while (low < high) {
      const m = (low + high) >> 1;
      if (near[m].y - offset < -CELL) low = m + 1;
      else high = m;
    }
    for (let i = low; i < near.length; i++) {
      const star = near[i];
      const y = star.y - offset;
      if (y > sea) break;
      const room = sparse ? clearance(star.x, y) : 1;
      if (room <= 0.02) continue;
      const [px, py] = parted(star.x, y);
      stamp(ctx, star, px, py, star.alpha * breath(now, star.phase) * room);
    }
  }

  /** A vertical gradient for a line of light from `top` to `bottom`, given its alpha at any screen y. */
  function line(top: number, bottom: number, alpha: (y: number) => number) {
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, `rgba(${LIGHT},${alpha(top + ((bottom - top) * i) / 8).toFixed(3)})`);
    return g;
  }

  function drawSpine(at: Layout, now: number, sea: number) {
    // A one-pixel line, kept on whole device pixels so it stays a hairline at any ratio.
    const device = Math.max(1, Math.round(ratio));
    const x = (Math.floor((width / 2) * ratio) + (device % 2) / 2) / ratio;
    const origin = at.spineTop - scroll;
    const tip = Math.min(spineTip(at) - scroll, sea);
    const meets = spineTip(at) - scroll >= sea - 1;
    const top = Math.max(0, origin);
    if (tip <= top) return;
    const strength = still ? 0.1 : 0.1 + 0.02 * Math.sin(now * BREATH);
    ctx.globalAlpha = 1;
    ctx.lineWidth = device / ratio;
    ctx.strokeStyle = line(top, tip, (y) => strength * smooth(origin, origin + 70, y) * (meets ? 1 : 1 - smooth(tip - 150, tip, y)));
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, tip);
    ctx.stroke();
    // Each merge runs down main as a short brightening of the line.
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i];
      const age = (now - pulse.born) / 1000;
      const y = pulse.y + age * 480 - scroll;
      const life = 1 - age / 1.9;
      if (life <= 0 || y - 100 > tip) {
        pulses.splice(i, 1);
        continue;
      }
      const a = Math.min(0.85, 0.5 * pulse.strength) * life * life;
      const from = Math.max(top, y - 110);
      const to = Math.min(tip, y + 6);
      if (to <= from) continue;
      ctx.strokeStyle = line(y - 110, y + 6, (v) => a * smooth(y - 110, y - 8, v) * (1 - smooth(y - 2, y + 6, v)));
      ctx.lineWidth = (device + 1) / ratio;
      ctx.beginPath();
      ctx.moveTo(x, from);
      ctx.lineTo(x, to);
      ctx.stroke();
    }
  }

  /** A meteor: a fine strand fading to nothing behind a small bright head with a soft natural glow. */
  function drawMeteor(path: Path, s: number, trail: number, strength: number, ending: number, lift = 0) {
    along(path, s, head);
    head[1] += lift;
    const start = Math.max(0, s - trail * (1 - ending));
    let alpha = strength;
    if (sparse) {
      // A phone fades a meteor as it passes behind text, instead of clearing whole areas of the canvas.
      along(path, (s + start) / 2, point);
      alpha *= Math.min(clearance(head[0], head[1]), clearance(point[0], point[1] + lift));
    }
    if (s - start < 1 || alpha <= 0.01) return;
    const stroke = (from: number, width: number, stops: [number, number][]) => {
      along(path, from, point);
      const g = ctx.createLinearGradient(point[0], point[1] + lift, head[0], head[1]);
      for (const [at, a] of stops) g.addColorStop(at, `rgba(222,230,255,${(a * alpha).toFixed(3)})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        along(path, from + ((s - from) * i) / 16, point);
        if (i) ctx.lineTo(point[0], point[1] + lift);
        else ctx.moveTo(point[0], point[1] + lift);
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    stroke(start, phone ? 1.1 : 1.25, [[0, 0], [0.35, 0.07], [0.75, 0.32], [1, 0.95]]);
    stroke(Math.max(start, s - (s - start) * 0.4), phone ? 3 : 3.6, [[0, 0], [1, 0.13]]);
    const fade = alpha * (1 - ending) ** 2;
    if (fade <= 0.01) return;
    const bloom = phone ? 18 : 24;
    const halo = ctx.createRadialGradient(head[0], head[1], 0, head[0], head[1], bloom);
    halo.addColorStop(0, `rgba(250,251,255,${fade.toFixed(3)})`);
    halo.addColorStop(0.06, `rgba(240,244,255,${(0.85 * fade).toFixed(3)})`);
    halo.addColorStop(0.16, `rgba(222,230,255,${(0.28 * fade).toFixed(3)})`);
    halo.addColorStop(0.42, `rgba(200,214,255,${(0.06 * fade).toFixed(3)})`);
    halo.addColorStop(1, 'rgba(200,214,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(head[0] - bloom, head[1] - bloom, bloom * 2, bloom * 2);
  }

  /** Draws the scrubbed meteors; true while any of them moved since the last frame. */
  function drawFlights(now: number) {
    let moving = false;
    for (const flight of flights) {
      const { path, t } = flight;
      if (!path) continue;
      if (t !== flight.drawn) moving = true;
      flight.drawn = t;
      if (t >= 1 && !flight.merged) {
        flight.merged = true;
        // Strands arriving together are one merge, brighter.
        const last = pulses.at(-1);
        if (last && now - last.born < 200) last.strength = Math.min(2.6, last.strength + 0.8);
        else pulses.push({ y: flight.merge * height + (flight.anchor ?? scroll), born: now, strength: 1 });
      } else if (t < 0.97) flight.merged = false;
      if (t <= 0.002 || t >= DRAIN) continue;
      drawMeteor(path, Math.min(1, t) * path.total, flight.trail, flight.glow * smooth(0, 0.07, t), t > 1 ? (t - 1) / (DRAIN - 1) : 0, flight.anchor === undefined ? 0 : flight.anchor - scroll);
    }
    return moving;
  }

  /** While the reader rests, every eight to fourteen seconds one shooting star crosses toward main. Only one at a time. */
  function drawIdle(at: Layout, now: number) {
    if (!idle) {
      if (now < nextIdle || now - movedAt < 1500) return false;
      const rand = random(Math.floor(now));
      const side = rand() < 0.5 ? 1 : -1;
      const x0 = 0.5 - side * (0.56 + rand() * 0.06);
      const y0 = 0.03 + rand() * 0.2;
      const merge = 0.3 + rand() * 0.2;
      const points = [
        [x0, y0],
        [x0 + side * (0.24 + rand() * 0.12), y0 + 0.03 + rand() * 0.05],
        [0.5 + side * 0.04, merge - 0.15],
        [0.5, merge],
      ];
      idle = { path: curve(points.map(([x, y]) => [x * width, y * height])), born: now, duration: 1250 + rand() * 650, trail: (phone ? 180 : 220) + rand() * (phone ? 50 : 100), merged: false };
    }
    const t = (now - idle.born) / idle.duration;
    if (t >= 1 && !idle.merged) {
      idle.merged = true;
      const y = idle.path.points[idle.path.points.length - 1] + scroll;
      if (y > at.spineTop && y < spineTip(at)) pulses.push({ y, born: now, strength: 0.8 });
    }
    if (t >= DRAIN) {
      idle = null;
      nextIdle = now + 8000 + Math.random() * 6000;
      return false;
    }
    drawMeteor(idle.path, (1 - (1 - Math.min(1, t)) ** 1.5) * idle.path.total, idle.trail, 0.85 * smooth(0, 0.1, t), t > 1 ? (t - 1) / (DRAIN - 1) : 0);
    return true;
  }

  /** The stars thin out around every line of text, and the clearings breathe a little with the sky. */
  function clear(water: boolean) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const c of open) if (!water || c.water) ctx.drawImage(c.mask, c.x0 - c.reach, c.y0 - c.reach, c.x1 - c.x0 + c.reach * 2, c.y1 - c.y0 + c.reach * 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** On a phone only main's own few pixels of each clearing are applied, where the line passes behind text. */
  function clearLine(x: number) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    for (const c of open) {
      const left = c.x0 - c.reach;
      const w = c.x1 - c.x0 + c.reach * 2;
      if (x < left || x > left + w) continue;
      const scale = c.mask.width / w;
      ctx.drawImage(c.mask, (x - 3 - left) * scale, 0, 6 * scale, c.mask.height, x - 3, c.y0 - c.reach, 6, c.y1 - c.y0 + c.reach * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The horizon's silver glow, and below it main's reflection: a pillar of glints that breathes with the sky. */
  function drawSea(now: number, sea: number) {
    if (sea >= height) return;
    const cx = width / 2;
    const lift = still ? 1 : 1 + 0.28 * Math.sin(now * BREATH);
    const near = Math.min(1, (height - sea) / (height * 0.3));
    // A wide, low glow: the sky warms to silver-blue at the horizon.
    ctx.save();
    ctx.translate(cx, sea);
    ctx.scale(1, 0.32);
    const radius = Math.max(width * 0.62, 420);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, `rgba(170,188,226,${(0.2 * near).toFixed(3)})`);
    glow.addColorStop(0.4, `rgba(140,160,206,${(0.075 * near).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(120,140,190,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = glow;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
    const horizon = ctx.createLinearGradient(0, 0, width, 0);
    horizon.addColorStop(0, 'rgba(190,204,232,0.04)');
    horizon.addColorStop(0.5, `rgba(${LIGHT},${(0.4 * near).toFixed(3)})`);
    horizon.addColorStop(1, 'rgba(190,204,232,0.04)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, snap(sea), width, 1);
    // Main's reflection: short glints that widen and scatter as the water comes nearer.
    const depth = height - sea;
    const rows = phone ? 30 : 44;
    const spread = phone ? 18 : 34;
    ctx.fillStyle = `rgb(${LIGHT})`;
    for (let j = 0; j < rows; j++) {
      const f = (j + 0.5) / rows;
      const y = sea + 3 + (depth - 3) * f ** 1.3;
      const w = 1.5 + spread * f ** 1.2 * (0.35 + 0.65 * Math.sin(now * 0.0017 + j * 2.7) ** 2);
      const drift = Math.sin(now * 0.0011 + j * 1.9) * spread * 0.22 * f;
      const a = (0.46 - 0.3 * f) * (0.5 + 0.5 * Math.sin(now * 0.0029 + j * 4.1)) * lift * near * (sparse ? clearance(cx + drift, y, true) : 1);
      if (a <= 0.012) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillRect(snap(cx - w / 2 + drift), snap(y), Math.max(snap(w), 1 / ratio), j % 4 === 0 ? 1.5 : 1);
    }
    // Main continues a little way into the water before it breaks into glints.
    ctx.globalAlpha = 1;
    ctx.fillStyle = line(sea, sea + depth * 0.36, (y) => 0.24 * lift * near * (1 - smooth(sea, sea + depth * 0.36, y)));
    ctx.fillRect(Math.floor(cx * ratio) / ratio, sea, Math.max(1, Math.round(ratio)) / ratio, depth * 0.36);
  }

  function draw(now: number) {
    drawnAt = now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, element.width, element.height);
    const at = layout;
    if (!at || !layers.length) return false;
    const sea = Math.min(height, seaLine(at));
    options.sea(sea);
    const swell = still ? 0 : (0.5 + 0.5 * Math.sin(now * BREATH)) * (phone ? 4 : 10);
    open = [];
    for (const { box, mask } of clearings) {
      const y = screenY(box.y, box.pin);
      if (y + box.h + REACH + swell > 0 && y - REACH - swell < height) open.push({ x0: box.x, y0: y, x1: box.x + box.w, y1: y + box.h, pad: PAD + swell, reach: REACH + swell, water: box.water, mask });
    }
    if (!sparse) {
      for (const each of layers) drawLayer(each, now, sea);
      if (pointer.strength > 0.01) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pointer.x * ratio, pointer.y * ratio, (PARTING.radius + 4) * ratio, 0, Math.PI * 2);
        ctx.clip();
        ctx.clearRect((pointer.x - PARTING.radius - 6) * ratio, (pointer.y - PARTING.radius - 6) * ratio, (PARTING.radius * 2 + 12) * ratio, (PARTING.radius * 2 + 12) * ratio);
        part(now, sea);
        ctx.restore();
      }
      drawNear(now, sea);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, sea);
    ctx.clip();
    drawSpine(at, now, sea);
    if (sparse) clearLine(Math.floor((width / 2) * ratio) / ratio);
    let moving = false;
    if (!still) {
      ctx.globalCompositeOperation = 'lighter';
      moving = drawFlights(now);
      moving = drawIdle(at, now) || moving;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    if (sparse) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const each of layers) drawStars(each, now, sea);
      drawNear(now, sea);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawSea(now, sea);
    } else {
      clear(false);
      drawSea(now, sea);
      clear(true);
    }
    return moving || pulses.length > 0;
  }

  function tick(now: number) {
    frame = 0;
    if (!running) return;
    pointer.x += (pointer.tx - pointer.x) * 0.2;
    pointer.y += (pointer.ty - pointer.y) * 0.2;
    pointer.strength += (pointer.target - pointer.strength) * 0.07;
    const busy = now - movedAt < 250 || now - pointer.movedAt < 500;
    // While anything moves it draws every frame; at rest only the breath and the odd meteor do, at about 30 fps.
    if (busy || now - drawnAt >= 31) {
      if (draw(now)) movedAt = Math.max(movedAt, now - 200);
    }
    frame = requestAnimationFrame(tick);
  }

  function wake() {
    if (still) {
      frame ||= requestAnimationFrame((now) => {
        frame = 0;
        draw(now);
      });
      return;
    }
    movedAt = performance.now();
    if (running && !frame) frame = requestAnimationFrame(tick);
  }

  return {
    /** Replaces the scrubbed meteors; the returned objects are what their tweens move. */
    fly(next: Flight[]) {
      flights = next.map((flight) => ({ ...flight, path: null, merged: flight.t >= 1, drawn: flight.t }));
      if (width) makePaths();
      return flights as Flight[];
    },
    resize(w: number, h: number) {
      // A canvas taken out of the page reports 0×0 before its cleanup runs; an empty sky has no stars to build.
      if (!w || !h || (w === width && h === height)) return;
      width = w;
      height = h;
      element.width = Math.round(w * ratio);
      element.height = Math.round(h * ratio);
      build();
      makePaths();
      wake();
    },
    layout(next: Layout) {
      const rebuild = !layout || Math.abs(next.maxScroll - layout.maxScroll) > height * 0.25;
      layout = next;
      if (rebuild && width) build();
      makeClearings();
      wake();
    },
    scroll(y: number) {
      scroll = y;
      wake();
    },
    point(x: number, y: number, inside: boolean) {
      if (!options.pointer || still) return;
      if (pointer.strength < 0.01) {
        pointer.x = x;
        pointer.y = y;
      }
      pointer.tx = x;
      pointer.ty = y;
      pointer.target = inside ? 1 : 0;
      pointer.movedAt = performance.now();
      wake();
    },
    wake,
    start() {
      running = !still;
      wake();
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

export type DescentSky = ReturnType<typeof descentSky>;
