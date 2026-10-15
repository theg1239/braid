import { absoluteTime, relativeTime } from '../../lib/format';

/** A moment as GitHub shows one: how long ago, with the exact time on hover. */
export function RelativeTime({ at, now, className }: { at: string; now: number; className?: string }) {
  return (
    <time className={className} dateTime={at} title={absoluteTime(at)}>
      {relativeTime(at, now)}
    </time>
  );
}
