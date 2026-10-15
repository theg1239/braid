import { PlayCircleIcon } from '@phosphor-icons/react';

/**
 * The tour repository's figures replay a recording, never live agents, and each says so once in its own chrome,
 * with the play icon the app's banner for the tour uses.
 */
export function Recorded() {
  return (
    <span className="lp-rec">
      <PlayCircleIcon size={12} weight="fill" aria-hidden="true" />
      Recorded
    </span>
  );
}
