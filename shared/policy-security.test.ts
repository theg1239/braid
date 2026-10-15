import { describe, expect, it } from 'vitest';
import { parsePolicy } from './policy-file';
import { evaluatePolicy, type PolicySubject } from './policy';

const subject: PolicySubject = { paths: ['docs/readme.md'], additions: 1, deletions: 0, revision: 1,
  author: { kind: 'agent', id: 'writer' }, reviews: [], checks: [], approved: false, history: { landed: 10, sentBack: 0 } };

describe('policy security boundary', () => {
  it.each([
    { requireHuman: true },
    { verify: { requiredChecks: ['security'] } },
    { rules: [{ paths: ['**'], autonomy: 'auto', requireApproval: true }] },
    { guards: { secret: 'revise' } },
    { limits: { file: 0 } },
    { rules: [{ paths: ['src/{unclosed'], autonomy: 'auto' }] },
    { merge: { union: ['src/{unclosed'] } },
    JSON.parse('{"__proto__":{"autonomy":"human"}}'),
  ])('fails closed for unknown policy fields: %j', extra => {
    const parsed = parsePolicy(JSON.stringify({ autonomy: 'auto', reviewers: 0, trust: { earnedAfter: 0 }, ...extra }));
    expect(parsed.errors.length).toBeGreaterThan(0);
    const decision = evaluatePolicy(parsed.policy, subject);
    expect(decision.autonomy).toBe('human');
    expect(decision.requirements).toContainEqual(expect.objectContaining({ id: 'policy', satisfied: false }));
  });

  it('does not resolve GitHub logins through Object.prototype', () => {
    const { policy, errors } = parsePolicy('{"github":{"reviewers":["constructor","toString"]}}');
    expect(errors).toEqual([]);
    expect(policy.github.reviewers).toEqual(['constructor', 'toString']);
  });
});
