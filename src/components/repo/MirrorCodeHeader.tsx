import { ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import { authorLine } from '../../lib/changes';
import { shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { paths } from '../../lib/router';
import { useSnapshot } from '../../store/workspace';
import { RouterLink } from '../ui/Link';
import { CommitSkeleton } from '../ui/ScreenSkeleton';
import { ImportBar } from './ImportBar';
import { useMirrorHistory } from './mirror-history';
import { RelativeTime } from '../ui/Time';

/** The same commit row as a regular repository; contributor totals live under Agents. */
export function MirrorCodeHeader() {
  const snapshot = useSnapshot();
  const history = useMirrorHistory();
  const now = useNow();
  const latest = history.value?.items[0];
  if (snapshot.importing && !snapshot.project.id) return <ImportBar importing={snapshot.importing} />;
  if (!history.value && !history.error) return <CommitSkeleton />;
  return <div className="commit-bar commit-bar--mirror">
      {latest ? <span className="commit-bar__author">{authorLine(latest.author)}</span> : null}
      <RouterLink className="commit-bar__title" href={paths.commit(latest?.hash ?? history.head)}>{latest?.title ?? shortHash(history.head)}</RouterLink>
      <span className="commit-bar__right">
        <span className="mono commit-bar__hash">{shortHash(latest?.hash ?? history.head)}</span>
        {latest ? <RelativeTime at={latest.at} now={now} /> : null}
        <RouterLink className="commit-bar__history" href={paths.commits(snapshot.project.branch)}><ClockCounterClockwiseIcon size={14} aria-hidden="true" />Commits</RouterLink>
      </span>
  </div>;
}
