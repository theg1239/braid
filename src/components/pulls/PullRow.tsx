import { memo } from 'react';
import { ChatCircleIcon } from '@phosphor-icons/react';
import type { ChangeSummary } from '../../../shared/types';
import { authorLine, labelTone, pullState, statusLabel } from '../../lib/changes';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { Stats } from '../ui/Status';
import { StackPosition } from './Stack';
import { Label, PullStateIcon } from './Bits';
import { RelativeTime } from '../ui/Time';

const CHECKS: Record<NonNullable<ChangeSummary['checkState']>, string> = { passed: 'Checks passed', failed: 'Checks failed', pending: 'Checks pending' };

/**
 * One pull request in a list, as on GitHub: the state icon, the title with its labels, then number,
 * time and author, and on the right its lines added and removed and the checks link. The label is
 * the server's: why it needs a person or why it went back. Memoized: a poll that changes one row
 * re-renders one row.
 */
export const PullRow = memo(function PullRow({ change, now }: { change: ChangeSummary; now: number }) {
  const state = pullState(change.status);
  const when = state === 'open' ? change.createdAt : change.updatedAt;
  const time = <RelativeTime at={when} now={now} />;
  const progress = state === 'open' ? change.outdated?.length ? `${change.outdated.map(item => `#${item.number}`).join(', ')} changed since this was built` : change.waitingOn?.length && change.status === 'open' ? `Waiting on ${change.waitingOn.map(item => `#${item.number}`).join(', ')}` : statusLabel(change).label : null;
  return (
    <li className="pr" data-state={state} data-status={change.status}>
      <PullStateIcon status={change.status} />
      <div className="pr__main">
        <div className="pr__title-row">
          <RouterLink href={paths.pull(change.number)} className="pr__title">
            {change.title}
          </RouterLink>
          <StackPosition stack={change.stack} />
          {change.label ? <Label tone={labelTone(change.status)}>{change.label}</Label> : null}
        </div>
        <p className="pr__meta">
          <span className="pr__num">#{change.number}</span>
          {state === 'open' ? <> opened {time} by {authorLine(change.author)}</> : <> by {authorLine(change.author)} was {state} {time}</>}
          {progress && progress !== change.label ? <> · <span className="pr__progress">{progress}</span></> : null}
        </p>
      </div>
      <span className="pr__right">
        {change.commentCount ? <RouterLink href={paths.pull(change.number)} className="pr__comments" aria-label={`${change.commentCount} comments`}><ChatCircleIcon size={16} aria-hidden="true" />{change.commentCount}</RouterLink> : null}
        <Stats additions={change.additions} deletions={change.deletions} className="pr__stats" />
        {change.checkState && change.label !== CHECKS[change.checkState] ? <RouterLink href={paths.pull(change.number, { tab: 'checks' })} className="pr__checks" data-state={change.checkState}>{CHECKS[change.checkState]}</RouterLink> : null}
      </span>
    </li>
  );
});
