import { Button } from '@cloudflare/kumo';
import type { ChangeReference } from '../../../shared/types';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { PullStateIcon } from '../pulls/Bits';

export function QueueStacks({ stacks, onNext, onPrevious }: { stacks: ChangeReference[][]; onNext?: () => void; onPrevious?: () => void }) {
  if (!stacks.length && !onPrevious) return null;
  return <section className="section" aria-labelledby="stacks-title">
    <h2 className="section__title" id="stacks-title">Stacks</h2>
    <div className="queue-stacks">{stacks.map(stack => <ol className="queue-stack" key={stack[0].id} aria-label="Merge order">
      {stack.map((item, index) => <li key={item.id}>
        <span className="queue-stack__position">{index + 1}</span>
        <PullStateIcon status={item.status} />
        <RouterLink className="text-link" href={paths.pull(item.number)}>#{item.number}</RouterLink>
        <span className="quiet">{item.status === 'landed' ? 'Merged' : item.status === 'closed' ? 'Closed' : item.status === 'queued' ? 'Queued' : item.status === 'landing' ? 'Merging' : 'Open'}</span>
      </li>)}
    </ol>)}</div>
    {onPrevious || onNext ? <nav className="queue-stacks__pages" aria-label="Stack pages">
      <Button size="sm" variant="secondary" disabled={!onPrevious} onClick={onPrevious}>Previous</Button>
      <Button size="sm" variant="secondary" disabled={!onNext} onClick={onNext}>Next</Button>
    </nav> : null}
  </section>;
}
