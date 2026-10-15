import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluatePolicy, type PolicySubject } from './policy';
import { parsePolicy } from './policy-file';
import { checkStateOf, describePolicy, labelFor, progressOf, questionFor } from './questions';
import type { Change, ChangeReview } from './types';

const author = { kind: 'agent' as const, id: 'agent:atlas', name: 'Atlas' };
function attention(subject: Partial<PolicySubject> & { paths: string[] }, extra: Partial<Change> = {}, policy = DEFAULT_POLICY) {
  const full: PolicySubject = { additions: 1, deletions: 0, revision: 1, author, reviews: [], checks: [], approved: false, ...subject };
  return {
    status: 'attention' as const, revision: 1, author, reviews: full.reviews, guards: full.guards, duplicates: [],
    files: full.paths.map(path => ({ path, additions: 1, deletions: 0, beforeHash: null, afterHash: null })),
    policy: evaluatePolicy(policy, full), next: 'Needs a person.', ...extra,
  };
}
const review = (verdict: ChangeReview['verdict'], summary: string, risk?: ChangeReview['risk']): ChangeReview =>
  ({ id: 'rv', revision: 1, reviewer: 'braid-reviewer:@cf/model', kind: 'agent', verdict, summary, createdAt: '', findings: [], ...(risk ? { risk } : {}) });

describe('questions a change puts to a person', () => {
  it('explains a policy error and shows every ruleset as requiring a person', () => {
    const { policy } = parsePolicy('{');
    expect(questionFor(attention({ paths: ['docs/setup.md'], history: { landed: 3, sentBack: 0 } }, {}, policy), policy)).toMatchObject({
      label: 'Policy file error', heading: 'The policy file has an error', detail: 'Pull requests wait for a person until the policy file is fixed.',
    });
    const summary = describePolicy(policy);
    expect(summary.fallback.decides).toBe('human');
    expect(summary.areas.every(area => area.decides === 'human' && !area.note)).toBe(true);
  });
  it('asks nothing unless the change waits for a person', () => {
    expect(questionFor({ ...attention({ paths: ['src/a.ts'] }), status: 'queued' })).toBeNull();
  });

  it('attributes an escalation to the reviewer and quotes its reason once', () => {
    const reason = 'Whether to round half-up or to even is a finance decision.';
    const question = questionFor(attention({ paths: ['src/ledger.ts'], reviews: [review('escalate', reason, 'high')] }))!;
    expect(question).toMatchObject({ kind: 'escalated', label: 'Reviewer flagged', heading: 'Braid reviewer asked for a person', detail: reason });
    expect(question.answers.map(answer => answer.action)).toEqual(['approve', 'send-back', 'close']);
  });

  it('turns a guard into an allow-or-send-back choice with a suggested note', () => {
    const question = questionFor(attention({ paths: ['test/a.test.ts'], guards: [{ kind: 'tests', path: 'test/a.test.ts', detail: 'Skips 1 more test in test/a.test.ts.' }] }))!;
    expect(question).toMatchObject({ kind: 'guard', label: 'Skips tests', heading: 'It skips or removes tests', detail: 'Skips 1 more test in test/a.test.ts.' });
    expect(question.answers[0]).toEqual({ action: 'approve', label: 'Approve and merge' });
    expect(question.answers[1]).toMatchObject({ action: 'send-back', suggestion: expect.stringContaining('tests pass') });
  });

  it('names the instruction a change goes against when the rules hand that to a person', () => {
    const { policy } = parsePolicy(JSON.stringify({ guards: { instructions: 'attention' } }));
    const detail = 'Adds "—" to src/copy.ts at line 3, against "No em dashes in UI copy".';
    const question = questionFor(attention({ paths: ['src/copy.ts'], guards: [{ kind: 'instructions', path: 'src/copy.ts', detail }] }, {}, policy), policy)!;
    expect(question).toMatchObject({ kind: 'guard', label: 'Breaks an instruction', heading: 'It goes against an instruction', detail });
    expect(question.answers.map(answer => answer.action)).toEqual(['approve', 'send-back', 'close']);
  });

  it('offers to keep both or close a likely duplicate', () => {
    const policy = { ...DEFAULT_POLICY, duplicates: 'attention' as const };
    const question = questionFor(attention({ paths: ['src/a.ts'], duplicates: [{ number: 12, similarity: 0.95 }] }, { duplicates: [{ changeId: 'ch_1', number: 12, title: 'Add retries', similarity: 0.95 }] }, policy), policy)!;
    expect(question).toMatchObject({ kind: 'duplicate', heading: 'It may duplicate #12' });
    expect(question.answers).toEqual([{ action: 'approve', label: 'Approve and keep both' }, { action: 'close', label: 'Close as duplicate', reason: 'superseded' }]);
  });

  it('explains a rule with its own note, and governance files in plain words', () => {
    const { policy } = parsePolicy(JSON.stringify({ rules: [{ paths: ['src/billing/**'], autonomy: 'human', note: 'Refunds and invoices need a person.' }] }));
    expect(questionFor(attention({ paths: ['src/billing/ledger.ts'] }, {}, policy), policy)).toMatchObject({ kind: 'rule', heading: 'Your rules ask you to decide', detail: 'Refunds and invoices need a person.' });
    expect(questionFor(attention({ paths: ['.braid/policy.json'] }))).toMatchObject({ kind: 'rule', heading: 'It changes rules, CI or agent instructions', detail: expect.stringContaining('.braid/policy.json') });
    expect(questionFor(attention({ paths: ['.coderabbit.yaml'] }))).toMatchObject({ label: 'Protected files' });
  });

  it('says where a change is in the words GitHub uses', () => {
    expect(progressOf('revise')).toBe('Changes requested');
    expect(progressOf('queued')).toBe('Queued to merge');
  });
});

describe('tags for lists', () => {
  it('says why a change went back, in two or three words', () => {
    const base = { status: 'revise' as const, revision: 2, author, reviews: [], conflicts: [], checks: [], guards: [], files: [] };
    expect(labelFor({ ...base, conflicts: [{ path: 'a.ts', kind: 'content' }] })).toBe('Conflicts');
    expect(labelFor({ ...base, guards: [{ kind: 'secrets', path: 'a.ts', detail: 'x' }] })).toBe('Secret found');
    expect(labelFor({ ...base, guards: [{ kind: 'instructions', path: 'a.ts', detail: 'x' }] })).toBe('Breaks an instruction');
    expect(labelFor({ ...base, checks: [{ revision: 2, kind: 'dependencies', label: 'Dependency review', status: 'failed', detail: '', source: 'braid' }] })).toBe('Vulnerable dependency');
    expect(labelFor({ ...base, checks: [{ revision: 2, label: 'Dependency review', status: 'failed', detail: '', source: 'github' }] })).toBe('Checks failed');
    expect(labelFor({ ...base, checks: [{ revision: 2, label: 'npm test', status: 'failed', detail: '', source: 'braid' }] })).toBe('Checks failed');
    expect(labelFor({ ...base, checks: [{ revision: 1, label: 'npm test', status: 'failed', detail: '', source: 'braid' }] })).toBe('Changes requested');
    expect(labelFor({ ...base, status: 'queued' })).toBeUndefined();
    expect(labelFor({ ...attention({ paths: ['src/a.ts'], reviews: [review('escalate', 'Why', 'high')] }), conflicts: [], checks: [] })).toBe('Reviewer flagged');
  });
});

describe('one check state per pull request', () => {
  it('fails on any failure, waits on warnings, and ignores agent reports and older versions', () => {
    const check = (status: 'passed' | 'failed' | 'warning', revision = 2, source: 'braid' | 'agent' = 'braid') => ({ revision, label: 'x', status, detail: '', source });
    expect(checkStateOf({ revision: 2, checks: [] })).toBeUndefined();
    expect(checkStateOf({ revision: 2, checks: [check('passed'), check('failed', 1)] })).toBe('passed');
    expect(checkStateOf({ revision: 2, checks: [check('passed'), check('warning')] })).toBe('pending');
    expect(checkStateOf({ revision: 2, checks: [check('warning'), check('failed')] })).toBe('failed');
    expect(checkStateOf({ revision: 2, checks: [check('passed', 2, 'agent')] })).toBeUndefined();
  });
});

describe('policy in sentences', () => {
  it('describes every behaviour-changing field once', () => {
    const { policy } = parsePolicy(JSON.stringify({ checks: ['npm test'], install: 'npm ci', delay: { minutes: 10 }, limits: { dailyPerAuthor: 20 },
      rules: [{ paths: ['src/billing/**'], autonomy: 'human', note: 'Refunds need a person.' }] }));
    const summary = describePolicy(policy);
    expect(summary.fallback).toEqual({ decides: 'review', reviewers: 1 });
    expect(summary.areas).toEqual([{ paths: ['src/billing/**'], decides: 'human', reviewers: 1, note: 'Refunds need a person.' }]);
    expect(summary.checks).toEqual({ install: 'npm ci', commands: ['npm test'], minutes: 20, required: [] });
    expect(summary.security).toEqual({ secrets: 'revise', dependencies: 'block', tests: 'attention', downgrades: 'attention', instructions: 'revise', reviewApps: [], reviewWait: 15 });
    expect(describePolicy(parsePolicy(JSON.stringify({ github: { reviewers: ['copilot', 'coderabbit'] } })).policy).security.reviewApps).toEqual(['Copilot', 'CodeRabbit']);
    expect(summary.safeguards.map(safeguard => safeguard.text)).toEqual([
      'A pull request that deletes or skips tests or downgrades a dependency goes to a person.',
      'A pull request that adds a token or private key or breaks an instruction goes back to its author.',
      'A pull request over 100 files or 5,000 changed lines goes to a person.',
      'A pull request sent back 4 times goes to a person instead of another round.',
      "A new author's pull requests need a review until 3 of theirs have merged.",
      'Dependencies a pull request adds are checked on OSV.dev, and a malicious or high-severity one sends it back.',
      'A pull request that repeats another open one is pointed out to its author.',
      'Approved pull requests wait 10 minutes before merging, so a person can still stop them.',
      'Each author can merge at most 20 pull requests a day.',
      'Changes to the rules, CI, code owners, agent instructions and review-app settings always need a person.',
    ]);
  });
});
