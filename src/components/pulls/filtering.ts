import type { ChangeCounts, ChangeSummary } from '../../../shared/types';
import { authorLine } from '../../lib/changes';

/** Match every word across the title, number and author, then count that same set. */
export function filterPulls(changes: ChangeSummary[], query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = changes.filter((change) => {
    const searchable = `#${change.number} ${change.title} ${authorLine(change.author)}`.toLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
  const counts: ChangeCounts = { open: 0, revise: 0, attention: 0, queued: 0, landing: 0, landed: 0, closed: 0 };
  for (const item of items) counts[item.status]++;
  return { items, counts };
}
