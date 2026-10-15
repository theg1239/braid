import { Button } from '@cloudflare/kumo';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { changes } from '../../lib/api';
import { queueInterval } from '../../lib/lists';
import { useLive } from '../../lib/live';
import { paths } from '../../lib/router';
import { useLandingToggle } from '../queue/QueueControl';
import { RouterLink } from '../ui/Link';
import { SkeletonLine } from '../ui/Skeleton';
import { Row, Section } from './Section';

/** Merging on or paused, with the owner's one control, and the way to the queue. */
export function Queue() {
  const queue = useLive('queue', changes.queue, queueInterval);
  const landing = useLandingToggle();
  const data = queue.data;
  const state = !data ? null : !data.enabled ? 'off' : data.paused ? 'paused' : 'on';
  return (
    <Section id="queue" rows>
      <Row compact label="Merging" hint={state ? (state === 'on' ? 'On' : state === 'paused' ? `Paused: ${data!.paused}` : 'Off') : queue.error ?? <SkeletonLine width={48} height={10} />}>
        {data && landing ? (
          data.enabled ? (
            <Button variant="secondary" size="sm" icon={PauseIcon} loading={landing.busy} onClick={() => void landing.toggle(false)}>
              Pause
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={PlayIcon} loading={landing.busy} onClick={() => void landing.toggle(true)}>
              Resume
            </Button>
          )
        ) : null}
      </Row>
      <Row label="Queue">
        <RouterLink href={paths.queue()} className="text-link">
          View merge queue
        </RouterLink>
      </Row>
    </Section>
  );
}
