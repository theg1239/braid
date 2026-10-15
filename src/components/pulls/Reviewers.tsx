import type { Change } from '../../../shared/types';
import type { Policy } from '../../../shared/policy';
import { reviewerLabel, reviewsFor } from '../../lib/changes';
import { paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { CheckStateIcon, VerdictIcon } from './Bits';
import { checkRows } from './Checks';

/** Checks can send work back without a review; name them beside the reviewers. */
export function Reviewers({ change, policy }: { change: Change; policy?: Policy }) {
  const reviews = reviewsFor(change.reviews, change.revision);
  const failed = change.status === 'revise' ? checkRows(change, policy).filter((row) => row.status === 'failed') : [];
  if (!reviews.length && !failed.length) return <p className="quiet">No reviews yet</p>;
  return (
    <ul className="pull-side__list">
      {reviews.map((review) => (
        <li key={review.id} className="pull-side__reviewer">
          <VerdictIcon verdict={review.verdict} size={15} />
          {reviewerLabel(review).name}
        </li>
      ))}
      {failed.map((row) => (
        <li key={row.key} className="pull-side__reviewer">
          <CheckStateIcon state="failed" label="Sent back by checks" size={15} />
          <RouterLink href={paths.pull(change.number, { tab: 'checks' })} className="text-link">{row.label}</RouterLink>
        </li>
      ))}
    </ul>
  );
}
