import type { ReactNode } from 'react';

/** Holds the room of the widest state it can show, so a changing badge or note never moves what follows it. */
export function Reserve({ children, states, className }: { children: ReactNode; states: ReactNode[]; className?: string }) {
  return (
    <span className={className ? `reserve ${className}` : 'reserve'}>
      <span>{children}</span>
      {states.map((state, index) => <span key={index} aria-hidden="true">{state}</span>)}
    </span>
  );
}
