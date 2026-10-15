import { useRef } from 'react';
import { SCALE } from './scale-data';
import { countUp, gsap, onEnter, useMotion } from './motion';

const QUEUES = [
  { key: 'braid', name: 'Braid' },
  { key: 'git', name: 'Git queue' },
] as const;

/** The experiment's largest fleet: a hundred agents. */
const RUN = SCALE.runs.at(-1)!;

/**
 * A hundred agents beside the tour's queue: one cell per agent's change, lit when it merged, for Braid and for a
 * Git merge queue, with a link to how the run was made. The cells light and the counts climb as the figure comes
 * into view.
 */
export function Scale() {
  const scope = useRef<HTMLElement>(null);
  useMotion(scope, () => {
    const tl = gsap.timeline({ scrollTrigger: onEnter(scope.current!, 'top 85%') });
    for (const row of gsap.utils.toArray<HTMLElement>('.lp-scale__row')) {
      const lit = row.querySelectorAll('[data-on] > i');
      tl.from(lit, { autoAlpha: 0, scale: 0.4, duration: 0.3, ease: 'power3.out', stagger: 0.016 }, 0).add(countUp(row.querySelector('.lp-scale__n b')!, { duration: lit.length * 0.016 + 0.2, ease: 'none' }), 0);
    }
  });
  return (
    <figure ref={scope} className="lp-scale" aria-label={`${RUN.agents} agents: changes merged by Braid and by a Git merge queue`}>
      <p className="lp-scale__head">
        {RUN.agents} agents
        <a className="lp-rec" href={SCALE.evidence}>
          Method
        </a>
      </p>
      {QUEUES.map(({ key, name }) => (
        <p key={key} className={`lp-scale__row lp-scale__row--${key}`}>
          <span className="lp-scale__name">{name}</span>
          <span className="lp-scale__n">
            <b>{RUN[key]}</b> merged<span className="sr-only"> of {RUN.agents}</span>
          </span>
          <span className="lp-scale__cells" aria-hidden="true">
            {Array.from({ length: RUN.agents }, (_, index) => (
              <span key={index} data-on={index < RUN[key] || undefined}>
                {index < RUN[key] ? <i /> : null}
              </span>
            ))}
          </span>
        </p>
      ))}
    </figure>
  );
}
