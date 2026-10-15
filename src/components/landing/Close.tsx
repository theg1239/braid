import { useRef } from 'react';
import { MERGED } from './data';
import { EASE, gsap, onEnter, riseLines, useMotion } from './motion';
import { Prompt } from './Prompt';

/*
 * The close: every pull request main took in the tour, one strand each under whoever made it, drawn into one main
 * in the order they merged as the reader arrives. The tour's background fleet is one fine bundle in the middle,
 * left unnamed, so every strand is still there. Main runs on into the line and the prompt that sets Braid up.
 */

const WIDTH = 1120;
const HEIGHT = 300;
const TOP = 48;
const JOIN = { x: WIDTH / 2, y: 238 };

/** Who made them, in the order each first merged, with the background fleet's place in the middle. */
const FLEET = MERGED.find((merge) => merge.simulated)!.by;
const AUTHORS = (() => {
  const people = [...new Set(MERGED.filter((merge) => !merge.simulated).map((merge) => merge.by))];
  return [...people.slice(0, Math.ceil(people.length / 2)), FLEET, ...people.slice(Math.ceil(people.length / 2))];
})();
const xOf = (index: number) => 100 + (index * (WIDTH - 200)) / (AUTHORS.length - 1);

/** Where each strand starts: under its author's name, side by side, the simulated bundle packed finer. */
const STRANDS = MERGED.map((merge) => {
  const group = MERGED.filter((other) => other.by === merge.by);
  const spread = merge.simulated ? 3.2 : 9;
  const x = xOf(AUTHORS.indexOf(merge.by)) + (group.indexOf(merge) - (group.length - 1) / 2) * spread;
  // Each strand crosses the middle a little before it joins, so they braid rather than fan.
  const d = `M${x},${TOP} C${x},${TOP + 104} ${JOIN.x - (x - JOIN.x) * 0.22},${JOIN.y - 112} ${JOIN.x},${JOIN.y}`;
  return { ...merge, d };
});

export function Close() {
  const scope = useRef<HTMLElement>(null);
  useMotion(scope, ({ wide }) => {
    // Tall desktops draw it with the scroll; elsewhere it draws once. Strands start in the order main took them,
    // the agents a beat apart and the simulated fleet, which merged within one second, in a quick run.
    const draw = gsap.timeline({
      defaults: { ease: wide ? 'none' : 'power2.inOut' },
      scrollTrigger: wide ? { trigger: scope.current, start: 'top 88%', end: 'top 22%', scrub: 0.6 } : onEnter(scope.current!, 'top 80%'),
    });
    let at = 0;
    for (const [index, merge] of STRANDS.entries()) {
      draw.from(`[data-merge="${merge.pull}"]`, { drawSVG: '0%', duration: 1 }, at);
      if (!merge.simulated && STRANDS.findIndex((other) => other.by === merge.by) === index) draw.from(`[data-author="${AUTHORS.indexOf(merge.by)}"]`, { autoAlpha: 0, duration: 0.4 }, at);
      at += merge.simulated ? 0.035 : 0.22;
    }
    draw
      .from('.lp-close__main', { drawSVG: '0%', duration: 0.35 }, '>-0.2')
      .from('.lp-close__dot', { autoAlpha: 0, scale: 0, transformOrigin: '50% 50%', duration: 0.3, ease: EASE }, '>-0.1');
    riseLines(scope.current!.querySelector('.lp-close__say')!, { scrollTrigger: onEnter('.lp-close__say', 'top 92%') });
    // The prompt fades with opacity alone, so its button stays in the Tab order before it plays in.
    gsap.from('.lp-close .lp-prompt-slot', { opacity: 0, y: 12, duration: 0.7, ease: EASE, delay: 0.25, scrollTrigger: onEnter('.lp-close .lp-prompt-slot', 'top 96%') });
  });
  return (
    <section ref={scope} className="lp-close" data-breath="close" aria-labelledby="lp-close">
      {/* A phone sees the middle of the braid at full height, the outer strands sweeping in from its edges. */}
      <svg className="lp-close__braid" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        {AUTHORS.map((author, index) =>
          author === FLEET ? null : (
            <text key={author} className="lp-close__who" data-author={index} x={xOf(index)} y={TOP - 20} textAnchor="middle">
              {author}
            </text>
          ),
        )}
        {STRANDS.map((merge) => (
          <path key={merge.pull} className="lp-close__strand" data-merge={merge.pull} data-simulated={merge.simulated ? '' : undefined} vectorEffect="non-scaling-stroke" d={merge.d} />
        ))}
        <path className="lp-close__main" vectorEffect="non-scaling-stroke" d={`M${JOIN.x},${JOIN.y} V${HEIGHT - 2}`} />
        <circle className="lp-close__dot" cx={JOIN.x} cy={JOIN.y} r={5} />
      </svg>
      <h2 id="lp-close" className="lp-close__say">
        One main.
      </h2>
      <Prompt />
    </section>
  );
}
