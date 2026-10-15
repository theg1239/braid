import type { ReactNode } from 'react';
import { Collapsible } from '@cloudflare/kumo';
import { CaretRightIcon } from '@phosphor-icons/react';

/** The toggle of a collapsible section: a caret that turns as the panel below opens, and its label. */
export function DisclosureTrigger({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <Collapsible.Trigger className={small ? 'disclosure disclosure--sm' : 'disclosure'}>
      <CaretRightIcon size={12} weight="bold" className="disclosure__caret" aria-hidden="true" />
      {children}
    </Collapsible.Trigger>
  );
}
