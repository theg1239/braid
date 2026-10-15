import './stack.css';
import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { changes, errorMessage } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { liveBlocker, useSnapshot } from '../../store/workspace';
import { StackIcon } from '@phosphor-icons/react';
import type { Change, ChangeReference, ChangeSummary } from '../../../shared/types';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';

export function StackPosition({ stack }: { stack: ChangeSummary['stack'] }) {
  return stack ? <span className="pr-stack" role="img" title={`Stack: ${stack.position} of ${stack.total}`} aria-label={`Stack: ${stack.position} of ${stack.total}`}>
    <StackIcon size={15} aria-hidden="true" />{stack.position} of {stack.total}
  </span> : null;
}
export function PullReferences({ items }: { items: ChangeReference[] }) {
  return items.map((item, index) => <span key={item.id}>{index ? ', ' : ''}<RouterLink className="text-link" href={paths.pull(item.number)}>#{item.number}</RouterLink></span>);
}
export function StackLinks({ change }: { change: ChangeSummary | Omit<ChangeSummary, 'files'> }) {
  if (!change.dependsOn?.length && !change.requiredBy?.length) return null;
  return <div className="pull-stack" aria-label="Pull request dependencies">
    <StackPosition stack={change.stack} />
    {change.dependsOn?.length ? <span>Depends on <PullReferences items={change.dependsOn} /></span> : null}
    {change.requiredBy?.length ? <span>Required by <PullReferences items={change.requiredBy} /></span> : null}
  </div>;
}

export function Restack({ change, onUpdated }: { change: Change; onUpdated: (next: Change) => void }) {
  const blocker = liveBlocker(useSnapshot());
  const attempt = useIdempotencyKey();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const next = await changes.restack(change.id, change.revision, attempt.key(['restack', change.id, change.revision]));
      attempt.settle(); onUpdated(next); refreshLive('changes'); refreshLive('queue');
    } catch (error) { attempt.settle(error); setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="pull-restack">
    <span><PullReferences items={change.outdated ?? []} /> changed since this was built</span>
    <Button size="sm" variant="secondary" disabled={!!blocker} title={blocker ?? undefined} loading={busy} onClick={() => void submit()}>Restack</Button>
    {error ? <p role="alert" className="pull-restack__error">{error}</p> : null}
  </div>;
}
