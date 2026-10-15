import type { ChangeStatus } from './types';
import { appSlug } from './people';

/*
 * Words the server and every screen share: where a change is, who reviewed it, and counts. They
 * stay apart from the policy and the questions a change asks, which only its own page and the
 * server need, so the shell carries these alone.
 */

/** "1 file", "3 files". */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Where a change is, in the words GitHub uses for pull requests. */
export function progressOf(status: ChangeStatus): string {
  return status === 'open' ? 'Review required' : status === 'revise' ? 'Changes requested' : status === 'queued' ? 'Queued to merge' : status === 'landing' ? 'Merging' : status === 'attention' ? 'Needs your review' : status === 'landed' ? 'Merged' : 'Closed';
}

/** A readable name for a reviewer identity such as `braid-reviewer:<model>` or `github:coderabbitai[bot]`. */
export function reviewerName(reviewer: string) {
  if (reviewer.startsWith('braid-reviewer')) return 'Braid reviewer';
  if (reviewer === 'simulated-reviewer') return 'Simulated reviewer';
  if (/copilot-pull-request-reviewer/i.test(reviewer)) return 'Copilot';
  if (/^(?:github:)?coderabbitai/i.test(reviewer)) return 'CodeRabbit';
  return appSlug(reviewer.replace(/^github:/, '')).replace(/^agent:/, '');
}
