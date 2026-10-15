import { CheckIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useElementWidth } from '../../lib/hooks';
import { OVERLAP } from './data';
import { EASE, gsap, onEnter, REVEAL, STEP, useMotion } from './motion';
import { Recorded } from './Recorded';
import { Agent, at, Commit, fall, Pane, Ring, Strand, sweep, TINT, WIDE, wideEnough, type Point } from './Stage';

/*
 * Two agents, one file. Claude Opus 5.5's and GPT-6.1 Sol's strands converge on src/limits.ts and part again into
 * their two versions, each shown by the line that decides what it does past the limit. The task's owner chooses one;
 * the other dims, and the chosen strand runs down into main at the stage's centre, on the page's own centre line.
 */

const [CHOSEN, OTHER] = OVERLAP.lanes;
/** The task ran its agents for its owner, who chooses between their versions. */
const OWNER = CHOSEN.owner;
const PILL = { width: 124, height: 28 };
const PANE = 86;

/** Where everything sits: a wide stage side by side, or a phone's, stacked with the strands in its margins. */
function geometry(width: number) {
  if (wideEnough(width)) {
    const w = WIDE, mid = w / 2;
    // The agents sit a quarter in from each side, their names kept clear of the centre line main runs down.
    const a: Point = [200, 52], b: Point = [680, 52], pill: Point = [mid, 196];
    const paneTop = 296, paneWidth = 420, dot: Point = [mid, 530];
    return {
      width: w, height: 560, a, b, dot,
      labels: { a: at(212, 42), b: at(692, 42) },
      pill: at(mid - PILL.width / 2, pill[1] - PILL.height / 2, PILL.width),
      panes: { a: at(0, paneTop, paneWidth), b: at(w - paneWidth, paneTop, paneWidth) },
      chosen: at(0, paneTop + PANE + 14),
      main: at(dot[0] + 14, dot[1] - 10),
      strands: {
        a1: sweep([a[0], a[1] + 4], [pill[0] - PILL.width / 2, pill[1]]),
        b1: sweep([b[0], b[1] + 4], [pill[0] + PILL.width / 2, pill[1]]),
        a2: fall([pill[0] - 16, pill[1] + PILL.height / 2], [paneWidth / 2, paneTop]),
        b2: fall([pill[0] + 16, pill[1] + PILL.height / 2], [w - paneWidth / 2, paneTop]),
        a3: `${fall([paneWidth - 44, paneTop + PANE], [mid, dot[1] - 30])} L${mid},${dot[1] - 5}`,
      },
    };
  }
  const w = Math.min(width, 480), mid = w / 2, edge = 8;
  const a: Point = [edge, 46], b: Point = [w - edge, 86], pill: Point = [mid, 170];
  const top = { a: 236, b: 380 }, dot: Point = [mid, 512];
  return {
    width: w, height: 532, a, b, dot,
    labels: { a: at(20, 36), b: at(null, 76, undefined, 20) },
    pill: at(mid - PILL.width / 2, pill[1] - PILL.height / 2, PILL.width),
    panes: { a: at(16, top.a, w - 32), b: at(16, top.b, w - 32) },
    chosen: at(16, top.a + PANE + 12),
    main: at(dot[0] + 14, dot[1] - 10),
    strands: {
      a1: sweep([a[0], a[1] + 4], [pill[0] - PILL.width / 2, pill[1]]),
      b1: sweep([b[0], b[1] + 4], [pill[0] + PILL.width / 2, pill[1]]),
      a2: fall([mid, pill[1] + PILL.height / 2], [mid, top.a]),
      // The other version's strand runs down the right margin, past the chosen pane, into the header of its own.
      b2: `M${mid + 30},${pill[1] + PILL.height / 2} C${mid + 30},${pill[1] + 40} ${w - edge},${pill[1] + 30} ${w - edge},${pill[1] + 70} L${w - edge},${top.b + 4} C${w - edge},${top.b + 12} ${w - 12},${top.b + 16} ${w - 16},${top.b + 16}`,
      // The chosen strand leaves its pane by the left margin and runs past the other into main.
      a3: `M16,${top.a + PANE - 16} C${edge},${top.a + PANE - 16} ${edge},${top.a + PANE - 12} ${edge},${top.a + PANE} L${edge},${dot[1] - 44} C${edge},${dot[1] - 12} ${mid},${dot[1] - 36} ${mid},${dot[1] - 5}`,
    },
  };
}

export function Overlap() {
  const scope = useRef<HTMLElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const g = width ? geometry(width) : null;
  useMotion(
    scope,
    () => {
      if (!g) return;
      // The other version starts as bright as the chosen one, and dims once the choice is made.
      gsap.set('.lp-pane[data-lane="other"]', { attr: { 'data-dim': '0' } });
      gsap
        .timeline({ defaults: { ease: EASE }, scrollTrigger: onEnter(scope.current!, 'top 70%') })
        .from('.lp-stage__agent, [data-node]', { opacity: 0, y: 8, duration: REVEAL * 0.7, stagger: 0.1 }, 0)
        .from('[data-strand="a1"], [data-strand="b1"]', { drawSVG: '0%', duration: REVEAL * 1.1, ease: 'power2.inOut' }, 0.2)
        .from('.lp-stage__pill', { opacity: 0, scale: 0.85, duration: REVEAL * 0.6 }, 1.05)
        .from('[data-strand="a2"], [data-strand="b2"]', { drawSVG: '0%', duration: REVEAL * 0.8, ease: 'power2.inOut' }, 1.35)
        .from('.lp-pane', { opacity: 0, y: 14, duration: REVEAL * 0.8, stagger: 0.12 }, 1.8)
        .from('.lp-overlap__chosen', { opacity: 0, y: 6, duration: REVEAL * 0.6 }, 2.7)
        .set('.lp-pane[data-lane="other"]', { attr: { 'data-dim': '1' } }, 2.75)
        .from('[data-strand="b1"], [data-strand="b2"], [data-node="other"]', { opacity: 1, duration: REVEAL * 0.6 }, 2.75)
        .from('[data-strand="a3"]', { drawSVG: '0%', duration: REVEAL, ease: 'power2.inOut' }, 3.05)
        .from('.lp-stage__commit, .lp-overlap__main', { opacity: 0, scale: 0.6, transformOrigin: '50% 50%', duration: STEP }, 3.9);
    },
    [g ? (wideEnough(width) ? 'wide' : 'tall') : 'none'],
  );
  return (
    <figure
      ref={scope}
      className="lp-figure lp-stage-wrap"
      aria-label={`Recorded run of the tour repository: ${CHOSEN.model} and ${OTHER.model} each wrote ${OVERLAP.path}; ${OWNER} chooses ${CHOSEN.model}'s version, which goes on to main`}
    >
      <div ref={measure} className="lp-stage-measure">
        {g ? (
          <div className="lp-stage" style={{ width: g.width, height: g.height }}>
            <svg className="lp-stage__art" width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true">
              <Strand name="a1" d={g.strands.a1} tint={TINT[CHOSEN.model]} />
              <Strand name="b1" d={g.strands.b1} tint={TINT[OTHER.model]} />
              <Strand name="a2" d={g.strands.a2} tint={TINT[CHOSEN.model]} />
              <Strand name="b2" d={g.strands.b2} tint={TINT[OTHER.model]} />
              <Strand name="a3" d={g.strands.a3} tint={TINT.main} />
              <Ring at={g.a} tint={TINT[CHOSEN.model]} label="chosen" />
              <Ring at={g.b} tint={TINT[OTHER.model]} label="other" />
              <Commit at={g.dot} />
            </svg>
            <Recorded />
            <Agent model={CHOSEN.model} owner={CHOSEN.owner} style={g.labels.a} />
            <Agent model={OTHER.model} owner={OTHER.owner} style={g.labels.b} align={wideEnough(width) ? 'left' : 'right'} />
            <p className="lp-stage__pill" style={g.pill}>
              <code>{OVERLAP.path}</code>
            </p>
            <Pane data-lane="chosen" model={CHOSEN.model} number={CHOSEN.number} line={CHOSEN.line} style={g.panes.a} />
            <Pane data-lane="other" data-dim="1" model={OTHER.model} number={OTHER.number} line={OTHER.line} style={g.panes.b} />
            <p className="lp-overlap__chosen" style={g.chosen}>
              <CheckIcon size={13} weight="bold" aria-hidden="true" />
              <b>{OWNER}</b> chooses this version
            </p>
            <p className="lp-overlap__main" style={g.main}>
              main
            </p>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
