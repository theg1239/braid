import { CheckCircleIcon, ClockIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import type { Activity, Mission } from '../../../shared/types';
import { isMissionActive } from '../../lib/task-state';
import { isResolved } from '../../lib/derive';
import { useNow } from '../../lib/hooks';
import { ScrollArea } from '../ui/Scroll';
import { RelativeTime } from '../ui/Time';

type Step = 'done' | 'running' | 'waiting' | 'failed';
/** About eight steps show at once; the rest scroll, opening on the latest. */
const HEIGHT = 8 * 37;

function StepIcon({ step }: { step: Step }) {
  if (step === 'running') return <ClockIcon size={16} className="task-step__icon" aria-label="Running" />;
  const props = { size: 16, className: 'task-step__icon', 'aria-hidden': true as const };
  if (step === 'failed') return <XCircleIcon {...props} weight="fill" />;
  if (step === 'waiting') return <WarningCircleIcon {...props} weight="fill" />;
  return <CheckCircleIcon {...props} weight="fill" />;
}

/**
 * What the task did, as a list of steps in the order they ran: done, running now, waiting for
 * a choice, or failed. One state icon per step, the step, and when, as a running job reads.
 */
export function ActivityList({ items, mission }: { items: Activity[]; mission: Mission }) {
  const now = useNow();
  if (!items.length) return <p className="quiet">No activity yet.</p>;
  // missionActivity sorts newest first, keeping same-second steps in order, so reversing gives the order they ran.
  const steps = [...items].reverse();
  const active = isMissionActive(mission);
  const undecided = mission.collisions.some((collision) => !isResolved(collision));
  const stepOf = (item: Activity, last: boolean): Step =>
    item.type === 'context' ? 'done' : item.type === 'error' ? 'failed' : item.type === 'conflict' && undecided ? 'waiting' : last && active ? 'running' : 'done';
  return (
    <ScrollArea className="task-steps" maxHeight={HEIGHT} label="Task activity" start="end">
      <ol className="task-steps__list">
        {steps.map((item, index) => {
          const step = stepOf(item, index === steps.length - 1);
          return (
            <li key={item.id} className="task-step" data-step={step} title={item.detail}>
              <StepIcon step={step} />
              <span className="task-step__name">{item.message}{item.type === 'context' && item.detail ? <span className="task-step__instruction">{item.detail}</span> : null}</span>
              <RelativeTime at={item.timestamp} now={now} className="task-step__time" />
            </li>
          );
        })}
      </ol>
    </ScrollArea>
  );
}
