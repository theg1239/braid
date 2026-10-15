import { useRef } from 'react';
import { useElementWidth } from '../../lib/hooks';
import { PROOF } from './data';
import desktopShot from './demo/status-desktop-tight.png';
import phoneShot from './demo/status-phone-tight.png';
import { EASE, gsap, onEnter, REVEAL, STEP, useMotion } from './motion';
import { Recorded } from './Recorded';
import { at, Commit, Ring, Strand, TINT, WIDE, wideEnough, type Point } from './Stage';

/*
 * Evidence assembling. #23's own screenshots, the page its agent captured on a desktop and on a phone, cropped to what
 * they show and set in thin frames; under them the pull request, whose strand runs down through each command as it
 * checks off, a hollow check where the agent ran it and a filled one where Braid did, and on into main.
 */

const [desktop, phone] = PROOF.tight;
const TINTED = TINT[PROOF.by.model];
/** Space between the check rows, and how far the strand travels from the last one to main. */
const ROW = { wide: 34, tall: 34 };

function geometry(width: number) {
  if (wideEnough(width)) {
    const w = WIDE, mid = w / 2;
    const frame = { left: 128, top: 16, width: 560 };
    const frameHeight = 28 + Math.round(((frame.width - 2) * desktop.height) / desktop.width) + 2;
    const phoneWidth = 168;
    const pull: Point = [136, frame.top + frameHeight + 76];
    const rows = PROOF.commands.map((_, index) => pull[1] + 58 + index * ROW.wide);
    const last = rows.at(-1)!;
    const dot: Point = [mid, last + 64];
    return {
      width: w, height: dot[1] + 24, pull, dot, rows,
      desktop: at(frame.left, frame.top, frame.width),
      phone: at(frame.left + frame.width - 112, frame.top + frameHeight - 132, phoneWidth),
      head: at(pull[0] + 16, pull[1] - 11),
      row: (y: number) => at(pull[0] + 20, y - 10, 600 - pull[0] - 20 + 160),
      main: at(dot[0] + 14, dot[1] - 10),
      strand: `M${pull[0]},${pull[1] + 4} L${pull[0]},${last + 8} C${pull[0]},${last + 44} ${mid},${dot[1] - 40} ${mid},${dot[1] - 5}`,
    };
  }
  const w = Math.min(width, 480), mid = w / 2;
  const frame = { left: 0, top: 30, width: w - 56 };
  const frameHeight = 28 + Math.round(((frame.width - 2) * desktop.height) / desktop.width) + 2;
  const phoneWidth = 116;
  const pull: Point = [8, frame.top + frameHeight + 92];
  const rows = PROOF.commands.map((_, index) => pull[1] + 58 + index * ROW.tall);
  const last = rows.at(-1)!;
  const dot: Point = [mid, last + 62];
  return {
    width: w, height: dot[1] + 24, pull, dot, rows,
    desktop: at(frame.left, frame.top, frame.width),
    phone: at(w - phoneWidth, frame.top + frameHeight - 84, phoneWidth),
    head: at(pull[0] + 12, pull[1] - 11),
    row: (y: number) => at(pull[0] + 18, y - 10, w - pull[0] - 18),
    main: at(dot[0] + 14, dot[1] - 10),
    strand: `M${pull[0]},${pull[1] + 4} L${pull[0]},${last + 8} C${pull[0]},${last + 40} ${mid},${dot[1] - 36} ${mid},${dot[1] - 5}`,
  };
}

/** A check on the strand: hollow where the agent ran the command, filled where Braid did. */
function Check({ at: [x, y], filled }: { at: Point; filled: boolean }) {
  return (
    <g className="lp-check" transform={`translate(${x} ${y})`}>
      <circle className="lp-check__wait" r={4} />
      <g className="lp-check__done">
        <circle r={8} style={filled ? { fill: TINTED, stroke: TINTED } : { stroke: TINTED }} />
        <path d="M-3.5,0.2 L-1,2.7 L3.6,-2.3" style={{ stroke: filled ? '#0b0c0e' : TINTED }} />
      </g>
    </g>
  );
}

export function Proof() {
  const scope = useRef<HTMLElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const g = width ? geometry(width) : null;
  useMotion(
    scope,
    () => {
      if (!g) return;
      const tl = gsap.timeline({ defaults: { ease: EASE }, scrollTrigger: onEnter(scope.current!, 'top 70%') });
      tl.from('.lp-device--desktop', { opacity: 0, y: 28, duration: REVEAL }, 0)
        .from('.lp-device--phone', { opacity: 0, x: 20, y: 36, duration: REVEAL }, 0.25)
        .from('[data-node="pull"], .lp-proof__head', { opacity: 0, y: 8, duration: REVEAL * 0.6 }, 0.7)
        .from('[data-strand="proof"]', { drawSVG: '0%', duration: STEP * PROOF.commands.length + REVEAL, ease: 'none' }, 0.95);
      gsap.utils.toArray<HTMLElement>('.lp-proof__run').forEach((row, index) => {
        const time = 1.1 + index * STEP;
        const check = scope.current!.querySelectorAll('.lp-check')[index];
        // Each check waits as an empty ring that arrives with its row, then fills in.
        tl.from(row, { opacity: 0, x: -6, duration: STEP }, time)
          .fromTo(check.querySelector('.lp-check__wait'), { opacity: 0 }, { opacity: 1, duration: 0.2, immediateRender: true }, time)
          .to(check.querySelector('.lp-check__wait'), { opacity: 0, duration: 0.15 }, time + STEP * 0.7)
          .from(check.querySelector('.lp-check__done'), { opacity: 0, scale: 0.4, transformOrigin: '50% 50%', duration: STEP * 0.7 }, time + STEP * 0.7);
      });
      tl.from('.lp-stage__commit, .lp-proof__main', { opacity: 0, scale: 0.6, transformOrigin: '50% 50%', duration: STEP }, '>-0.1');
    },
    [g ? (wideEnough(width) ? 'wide' : 'tall') : 'none'],
  );
  return (
    <figure ref={scope} className="lp-figure lp-stage-wrap" aria-label={`Recorded run of the tour repository: pull request #${PROOF.number}, the screenshots its agent took and every command that ran`}>
      <div ref={measure} className="lp-stage-measure">
        {g ? (
          <div className="lp-stage" style={{ width: g.width, height: g.height }}>
            <div className="lp-device lp-device--desktop" style={g.desktop}>
              <p className="lp-device__bar" aria-hidden="true">
                <i />
                <i />
                <i />
                <span>/status.html</span>
              </p>
              <img src={desktopShot} width={desktop.width} height={desktop.height} alt={`The status page #${PROOF.number} adds, on a desktop, as its agent captured it`} decoding="async" />
            </div>
            <div className="lp-device lp-device--phone" style={g.phone}>
              <span className="lp-device__notch" aria-hidden="true" />
              <img src={phoneShot} width={phone.width} height={phone.height} alt="The same page on a phone" decoding="async" />
            </div>
            <svg className="lp-stage__art" width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true">
              <Strand name="proof" d={g.strand} tint={TINTED} />
              <Ring at={g.pull} tint={TINTED} label="pull" />
              {g.rows.map((y, index) => (
                <Check key={index} at={[g.pull[0], y]} filled={PROOF.commands[index].where === 'Braid'} />
              ))}
              <Commit at={g.dot} />
            </svg>
            <Recorded />
            <p className="lp-proof__head" style={g.head}>
              <b>
                {PROOF.title} <span>#{PROOF.number}</span>
              </b>
              <span className="lp-proof__by">
                {PROOF.by.model} for {PROOF.by.owner}
              </span>
            </p>
            {PROOF.commands.map((command, index) => (
              <p key={index} className="lp-proof__run" data-where={command.where === 'Braid' ? 'braid' : 'agent'} style={g.row(g.rows[index])}>
                <code>{command.command}</code>
                <span className="lp-proof__time">{command.seconds.toFixed(1)}s</span>
                <span className="lp-proof__where">{command.where}</span>
              </p>
            ))}
            <p className="lp-proof__main" style={g.main}>
              main <span>{PROOF.merged}</span>
            </p>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
