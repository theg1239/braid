import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluatePolicy, revisionRequested, type PolicySubject } from './policy';
import { parsePolicy } from './policy-file';
import type { ChangeReview } from './types';

const subject = (paths: string[], extra: Partial<PolicySubject> = {}): PolicySubject => ({ paths, additions: 10, deletions: 2, revision: 1, author: { kind: 'agent', id: 'agent-a' }, reviews: [], checks: [], approved: false, ...extra });
const review = (reviewer: string, verdict: ChangeReview['verdict'], extra: Partial<ChangeReview> = {}): ChangeReview => ({ id: reviewer, revision: 1, reviewer, kind: 'agent', verdict, summary: `${reviewer} says ${verdict}`, createdAt: '2026-10-07T00:00:00Z', findings: [], ...extra });
const unmet = (decision: ReturnType<typeof evaluatePolicy>) => decision.requirements.filter(requirement => !requirement.satisfied).map(requirement => requirement.id);

describe('policy', () => {
  it('sends every pull request to a person when no revision rounds are allowed, even without history', () => {
    const strict = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, revisions: 0 } };
    expect(evaluatePolicy(strict, subject(['docs/setup.md'])).requirements.find(requirement => requirement.id === 'rounds'))
      .toMatchObject({ satisfied: false, detail: 'This repository sends every pull request to a person.' });
  });
  it('lets documentation land automatically and asks for one reviewer on code by default', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, subject(['docs/setup.md', 'README.md']))).toMatchObject({ autonomy: 'auto', reviewers: 0 });
    const code = evaluatePolicy(DEFAULT_POLICY, subject(['src/index.ts', 'docs/setup.md']));
    expect(code).toMatchObject({ autonomy: 'review', reviewers: 1 });
    expect(unmet(code)).toEqual(['reviews']);
    expect(unmet(evaluatePolicy(DEFAULT_POLICY, subject(['src/index.ts'], { reviews: [review('reviewer-1', 'approve')] })))).toEqual([]);
  });

  it('ignores self-review and stale approvals', () => {
    const decision = evaluatePolicy(DEFAULT_POLICY, subject(['src/a.ts'], { revision: 2, reviews: [review('agent-a', 'approve', { revision: 2 }), review('reviewer-1', 'approve', { revision: 1 })] }));
    expect(unmet(decision)).toEqual(['reviews']);
  });

  it('always needs a person for governance files, whatever the policy says', () => {
    const { policy } = parsePolicy(JSON.stringify({ autonomy: 'auto', reviewers: 0, rules: [{ paths: ['**'], autonomy: 'auto' }] }));
    const decision = evaluatePolicy(policy, subject(['.braid/policy.json']));
    expect(decision.autonomy).toBe('human');
    expect(unmet(decision)).toEqual(['human']);
    expect(unmet(evaluatePolicy(policy, subject(['.braid/policy.json'], { approved: true })))).toEqual([]);
  });

  it('applies the last matching rule per path and the strictest result across paths', () => {
    const { policy, errors } = parsePolicy(JSON.stringify({
      autonomy: 'auto', reviewers: 0,
      rules: [{ paths: ['src/**'], autonomy: 'review', reviewers: 1 }, { paths: ['src/billing/**'], autonomy: 'human', reviewers: 2 }, { paths: ['src/generated/**'], autonomy: 'auto' }, { paths: ['vendor/**'], protected: true }],
    }));
    expect(errors).toEqual([]);
    expect(evaluatePolicy(policy, subject(['src/generated/schema.ts'])).autonomy).toBe('auto');
    expect(evaluatePolicy(policy, subject(['src/api.ts', 'src/billing/charge.ts']))).toMatchObject({ autonomy: 'human', reviewers: 2, rules: [0, 1] });
    expect(unmet(evaluatePolicy(policy, subject(['vendor/lib.js'])))).toEqual(['protected']);
  });

  it('escalates high risk, oversized changes and failed checks to the right party', () => {
    const risky = evaluatePolicy(DEFAULT_POLICY, subject(['src/a.ts'], { reviews: [review('reviewer-1', 'approve', { risk: 'high' })] }));
    expect(risky.autonomy).toBe('human');
    expect(unmet(risky)).toEqual(['risk']);
    expect(unmet(evaluatePolicy(DEFAULT_POLICY, subject(['src/a.ts'], { additions: 6000, reviews: [review('reviewer-1', 'approve')] })))).toEqual(['size']);
    const failing = subject(['src/a.ts'], { checks: [{ revision: 1, label: 'npm test', status: 'failed', detail: 'exit 1', source: 'agent' }] });
    expect(unmet(evaluatePolicy(DEFAULT_POLICY, failing))).toEqual(['reviews', 'checks']);
    expect(revisionRequested(failing, DEFAULT_POLICY)).toEqual([{ from: 'checks', text: 'Failed: npm test' }]);
    expect(revisionRequested(subject(['src/a.ts'], { reviews: [review('reviewer-1', 'revise')] }), DEFAULT_POLICY)).toEqual([{ from: 'review', text: 'reviewer-1: reviewer-1 says revise' }]);
  });

  it('reports invalid policy fields and fails closed on invalid JSON', () => {
    expect(parsePolicy('{').policy.autonomy).toBe('human');
    const { policy, errors } = parsePolicy(JSON.stringify({ autonomy: 'yolo', reviewers: 9, rules: [{ autonomy: 'auto' }], merge: { union: ['CHANGELOG.md'] } }));
    expect(policy.autonomy).toBe('human');
    expect(policy.merge).toEqual({ union: ['CHANGELOG.md'] });
    expect(errors).toEqual(['autonomy must be "auto", "review" or "human".', 'reviewers must be a whole number from 0 to 5.', 'rules[0].paths is required.']);
  });
});
