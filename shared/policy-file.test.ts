import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluatePolicy, type PolicySubject } from './policy';
import { parsePolicy } from './policy-file';

const subject: PolicySubject = {
  paths: ['docs/setup.md'], additions: 1, deletions: 0, revision: 1,
  author: { kind: 'agent', id: 'audit-author' }, reviews: [], checks: [], approved: false,
  history: { landed: 3, sentBack: 0 },
};

function needsPerson(text: string) {
  const parsed = parsePolicy(text);
  expect(parsed.errors.length).toBeGreaterThan(0);
  for (const paths of [['docs/setup.md'], ['src/a.test.ts'], ['src/a.ts'], []]) {
    const decision = evaluatePolicy(parsed.policy, { ...subject, paths });
    expect(decision.autonomy).toBe('human');
    expect(decision.requirements).toContainEqual(expect.objectContaining({ id: 'policy', satisfied: false }));
    const approved = evaluatePolicy(parsed.policy, { ...subject, paths, approved: true });
    expect(approved.requirements.every(requirement => requirement.satisfied)).toBe(true);
  }
  return parsed;
}

describe('invalid policy requires a person', () => {
  it.each(['{', '{\n  "autonomy": "auto",\n}', 'null', '[]', '"auto"'])('blocks default path rules for malformed policy %s', text => {
    needsPerson(text);
  });

  it.each([
    { version: 2 }, { autonomy: 'invalid' }, { reviewers: 9 }, { checks: 'npm test' }, { install: '' },
    { verify: [] }, { verify: { checks: [1] } }, { verify: { install: 1 } },
    { verify: { minutes: 0 } }, { verify: { retries: -1 } }, { verify: { parallel: 0 } }, { verify: { required: [1] } },
    { rules: 'docs/**' }, { rules: [null] }, { rules: [{ autonomy: 'auto' }] }, { rules: [{ paths: [] }] },
    { rules: [{ paths: ['**'], autonomy: 'invalid' }] }, { rules: [{ paths: ['**'], reviewers: -1 }] },
    { rules: [{ paths: ['**'], protected: 'true' }] }, { rules: [{ paths: ['**'], note: 1 }] },
    { merge: null }, { merge: { union: 'docs/**' } }, { merge: { json: 'false' } },
    { limits: null }, { limits: { files: -1 } }, { limits: { lines: -1 } }, { limits: { revisions: -1 } }, { limits: { dailyPerAuthor: -1 } },
    { guards: null }, { guards: { tests: 'invalid' } }, { guards: { dependencies: 'invalid' } }, { guards: { secrets: 'invalid' } }, { guards: { instructions: 'invalid' } },
    { trust: null }, { trust: { newAuthors: 'invalid' } }, { trust: { earnedAfter: -1 } },
    { delay: null }, { delay: { minutes: -1 } }, { duplicates: 'invalid' },
    { github: null }, { github: { reviewers: [1] } }, { github: { wait: -1 } }, { dependencyReview: 'invalid' },
  ])('blocks permissive rules when a field is invalid: %j', invalid => {
    needsPerson(JSON.stringify({ autonomy: 'auto', reviewers: 0, rules: [{ paths: ['**'], autonomy: 'auto' }], ...invalid }));
  });

  it('identifies the syntax error line without quoting policy contents', () => {
    expect(parsePolicy('{\n  "autonomy": "auto",\n}').errors).toEqual(['The policy file must be a valid JSON object.']);
  });

  it('keeps valid defaults and rules unchanged after the file is fixed', () => {
    needsPerson('{"autonomy":"invalid"}');
    expect(parsePolicy(null)).toEqual({ policy: DEFAULT_POLICY, errors: [] });
    expect(parsePolicy('{}')).toEqual({ policy: DEFAULT_POLICY, errors: [] });
    const valid = parsePolicy('{"autonomy":"auto","reviewers":0,"rules":[{"paths":["**"],"autonomy":"auto"}]}');
    expect(valid.errors).toEqual([]);
    expect(evaluatePolicy(valid.policy, subject).autonomy).toBe('auto');
    expect(evaluatePolicy(DEFAULT_POLICY, subject).autonomy).toBe('auto');
  });
});
