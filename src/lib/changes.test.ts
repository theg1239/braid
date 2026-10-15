import { describe, expect, it } from 'vitest';
import type { BatchSummary } from '../../shared/types';
import { personHandle } from '../../shared/people';
import { authorLine, batchSentence, retried } from './changes';

const batch = (over: Partial<BatchSummary>): BatchSummary => ({ id: 'b1', status: 'failed', base: 'a'.repeat(40), startedAt: '2026-10-13T07:00:00Z', landed: [], ejected: [], strategies: {}, ...over });

describe('merge queue history', () => {
  it('counts the pull requests a failed batch put back, as a merge does, and names them for links', () => {
    const requeued = [{ changeId: 'c69', number: 69 }, { changeId: 'c70', number: 70 }];
    expect(batchSentence(batch({ note: 'Checks failed for #69 alone; retrying once in case a test is flaky.', requeued: requeued.slice(0, 1) }))).toBe('Did not merge 1 pull request');
    expect(retried(batch({ note: 'Checks failed on 2 combined changes; narrowing down which one caused it.', requeued }))).toEqual([69, 70]);
    expect(batchSentence(batch({ ejected: [{ changeId: 'c69', number: 69, reason: 'Checks failed: npm test' }] }))).toBe('Removed #69 from the queue');
    expect(batchSentence(batch({ note: 'Braid could not reach the sandbox.' }))).toBe('Did not merge');
    // A note names pull requests on GitHub too; only the batch's own record says what it put back.
    expect(retried(batch({ note: 'Someone closed pull request #12 on GitHub, so merging paused.' }))).toEqual([]);
    expect(batchSentence(batch({}))).toBe('Did not merge');
  });
});

describe('people', () => {
  it('names a bot without replacing it with its human co-author', () => {
    expect(authorLine({ kind: 'bot', id: 'dependabot', name: 'Dependabot', owner: { name: 'Owner', github: 'owner' } })).toBe('Dependabot');
  });

  it('reads a GitHub noreply commit address as the login', () => {
    expect(personHandle({ name: 'theg', email: '41898282+theg1239@users.noreply.github.com' })).toBe('@theg1239');
    expect(personHandle({ name: 'theg', email: 'theg1239@users.noreply.github.com' })).toBe('@theg1239');
    expect(personHandle({ name: 'Maya Chen', github: 'maya-chen', email: '1+someone@users.noreply.github.com' })).toBe('@maya-chen');
    expect(personHandle({ name: 'theg1239', email: 'theg@example.com' })).toBe('theg1239');
    expect(personHandle({ name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' })).toBe('github-actions[bot]');
  });
});
