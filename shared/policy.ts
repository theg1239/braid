import type { Autonomy, ChangeCheck, ChangeReview, PolicyDecision, PolicyRequirement } from './types';
import { matchesAny } from './glob';
import type { MergeRules } from './merge';
import type { GuardFinding, GuardKind } from './guards';
import { plural, reviewerName } from './labels';

/** What happens when a guard fires: a person decides, the author must revise, or nothing. */
export type GuardAction = 'attention' | 'revise' | 'off';

/** Later rules override earlier ones for the same path, as in CODEOWNERS. */
export interface PolicyRule { paths: string[]; autonomy?: Autonomy; reviewers?: number; protected?: boolean; note?: string }
export interface Policy {
  version: 1;
  /** Set by the parser when the file is invalid; no path rule can waive person approval. */
  error?: string;
  /** Default for paths no rule covers: land automatically, after agent review, or only with a person's approval. */
  autonomy: Autonomy;
  /** Independent reviewer approvals required by default. */
  reviewers: number;
  /** Commands run against the combined result before a batch lands. */
  checks: string[];
  /** Prepares dependencies before the checks, such as `npm ci`. */
  install?: string;
  /**
   * Time budget for one verification, how often a lone failing change is
   * retried before it is blamed, and how many batches may verify at once, each
   * composed on the result of the one ahead of it.
   */
  verify: { minutes: number; retries: number; parallel: number; required: string[] };
  rules: PolicyRule[];
  merge: MergeRules;
  /**
   * Larger changes always need a person; after `revisions` rounds of being sent
   * back, a person looks instead of letting an agent loop; `dailyPerAuthor`
   * caps how many changes one author can land per day (0 means no cap).
   */
  limits: { files: number; lines: number; revisions: number; dailyPerAuthor: number };
  /** Test deletions and skips, dependency downgrades, credentials, and strings an instruction blocks. */
  guards: Record<GuardKind, GuardAction>;
  /** Authors earn unattended landing: until `earnedAfter` clean landings, their changes get at least `newAuthors` autonomy. */
  trust: { newAuthors: Autonomy; earnedAfter: number };
  /** Minutes a queued change waits before it may land, so a person can still stop it. */
  delay: { minutes: number };
  /** What a likely duplicate of another active change does: note it for the author, or ask a person. */
  duplicates: 'note' | 'attention' | 'off';
  /** Dependencies a change adds are looked up on OSV.dev: block malicious or high-severity ones, only report them, or skip the lookup. */
  dependencyReview: 'block' | 'warn' | 'off';
  /**
   * Review apps installed on GitHub that Braid asks to review each merge-queue
   * pull request, and how many minutes it waits for them before merging
   * without their review (recorded as a warning).
   */
  github: { reviewers: string[]; wait: number };
}

export const POLICY_PATH = '.braid/policy.json';
/** Where a repository keeps the instructions every agent follows, read from main like the policy. */
export const INSTRUCTIONS_PATH = '.braid/instructions.json';
/** Coding tools read AGENTS.md; Braid keeps the instructions in a section of it. */
export const AGENTS_PATH = 'AGENTS.md';
/** Short names for review apps whose GitHub login is not obvious. */
export const REVIEW_APPS: Record<string, string> = { copilot: 'copilot-pull-request-reviewer[bot]', coderabbit: 'coderabbitai[bot]', gemini: 'gemini-code-assist[bot]' };
/**
 * These paths decide what agents may do, so changing them always needs a
 * person, whatever the policy says: the policy itself, CI, code owners, the
 * instructions agents follow, and the settings review apps and scanners read
 * from the branch they review, so an agent cannot weaken its own review.
 */
export const GOVERNANCE = [POLICY_PATH, INSTRUCTIONS_PATH, '.github/workflows/**', '.github/CODEOWNERS', 'CODEOWNERS', '.github/dependabot.yml', '.github/codeql/**',
  AGENTS_PATH, 'CLAUDE.md', '.github/copilot-instructions.md', '.github/instructions/**', '.cursorrules', '.cursor/rules/**', '.cursor/BUGBOT.md',
  '.coderabbit.yaml', '.coderabbit.yml', '.pr_agent.toml', '.gemini/**', '.macroscope/**', '.gitleaks.toml', '.gitleaksignore', '.semgrepignore', 'osv-scanner.toml'];
const ORDER: Autonomy[] = ['auto', 'review', 'human'];

export const DEFAULT_POLICY: Policy = {
  version: 1, autonomy: 'review', reviewers: 1, checks: [], verify: { minutes: 20, retries: 1, parallel: 3, required: [] },
  rules: [
    { paths: ['*.md', 'docs/**'], autonomy: 'auto', reviewers: 0, note: 'Documentation lands once it merges cleanly.' },
    { paths: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**'], autonomy: 'auto', reviewers: 0, note: 'Tests land once they merge cleanly.' },
  ],
  merge: {}, limits: { files: 100, lines: 5000, revisions: 4, dailyPerAuthor: 0 },
  guards: { tests: 'attention', dependencies: 'attention', secrets: 'revise', instructions: 'revise' },
  trust: { newAuthors: 'review', earnedAfter: 3 },
  delay: { minutes: 0 },
  duplicates: 'note', dependencyReview: 'block', github: { reviewers: [], wait: 15 },
};

export interface PolicySubject {
  paths: string[]; additions: number; deletions: number; revision: number;
  author: { kind: string; id: string; name?: string };
  /** Clean landings this author already has in the repository, and how often this change was sent back. */
  history?: { landed: number; sentBack: number };
  guards?: GuardFinding[];
  duplicates?: { number: number; similarity: number }[];
  reviews: ChangeReview[]; checks: ChangeCheck[];
  /** A person approved this exact revision. */
  approved: boolean;
}

type Reviewed = Pick<PolicySubject, 'reviews' | 'revision' | 'author'>;
/** This revision's reviews by anyone but its author. */
const independent = (subject: Reviewed) => subject.reviews.filter(review => review.revision === subject.revision && review.reviewer !== subject.author.id);
/** This revision's reviews that hand the change to a person. */
export const escalations = (subject: Reviewed) => independent(subject).filter(review => review.verdict === 'escalate' || review.risk === 'high');
export const failedChecks = (subject: Pick<PolicySubject, 'checks' | 'revision'>) => subject.checks.filter(check => check.revision === subject.revision && check.status === 'failed');

/** Pure policy evaluation: the strictest requirement across a change's paths applies. */
export function evaluatePolicy(policy: Policy, subject: PolicySubject): PolicyDecision {
  let level = policy.error ? ORDER.indexOf('human') : 0, reviewers = 0;
  const matched = new Set<number>(), protectedPaths: string[] = [];
  for (const path of subject.paths) {
    let pathAutonomy = policy.autonomy, pathReviewers = policy.reviewers;
    policy.rules.forEach((rule, index) => {
      if (!matchesAny(path, rule.paths)) return;
      matched.add(index);
      if (rule.autonomy) pathAutonomy = rule.autonomy;
      if (rule.reviewers !== undefined) pathReviewers = rule.reviewers;
      if (rule.protected) protectedPaths.push(path);
    });
    if (matchesAny(path, GOVERNANCE)) pathAutonomy = 'human';
    level = Math.max(level, ORDER.indexOf(pathAutonomy));
    if (pathAutonomy !== 'auto') reviewers = Math.max(reviewers, pathReviewers);
  }
  const approvals = new Set(independent(subject).filter(review => review.verdict === 'approve').map(review => review.reviewer)).size;
  const escalated = escalations(subject);
  const failed = failedChecks(subject);
  const lines = subject.additions + subject.deletions;
  const oversized = subject.paths.length > policy.limits.files || lines > policy.limits.lines;
  const flagged = (subject.guards ?? []).filter(guard => policy.guards[guard.kind] === 'attention');
  const sentBack = subject.history?.sentBack ?? 0;
  const looping = sentBack >= policy.limits.revisions;
  const duplicate = policy.duplicates === 'attention' ? subject.duplicates?.[0] : undefined;
  if (oversized || escalated.length || protectedPaths.length || flagged.length || looping || duplicate) level = ORDER.indexOf('human');
  // Unattended landing is earned: a new author's changes get at least the configured floor.
  const landed = subject.history?.landed ?? 0;
  const untrusted = !!subject.history && landed < policy.trust.earnedAfter && ORDER.indexOf(policy.trust.newAuthors) > level;
  if (untrusted) { level = ORDER.indexOf(policy.trust.newAuthors); reviewers = Math.max(reviewers, 1); }
  const autonomyLevel = ORDER[level];
  const requirements: PolicyRequirement[] = [];
  if (policy.error) requirements.push({ id: 'policy', label: 'Policy file error', satisfied: subject.approved, detail: policy.error });
  if (protectedPaths.length) requirements.push({ id: 'protected', label: 'Protected paths', satisfied: subject.approved, detail: `${protectedPaths.slice(0, 5).join(', ')}${protectedPaths.length > 5 ? ` and ${protectedPaths.length - 5} more` : ''} may only change with a person's approval.` });
  if (oversized) requirements.push({ id: 'size', label: 'Change size', satisfied: subject.approved, detail: `${subject.paths.length} files and ${lines} changed lines exceed the policy limit of ${policy.limits.files} files or ${policy.limits.lines} lines.` });
  // A person's approval of this exact revision is at least as strong as an agent review.
  if (reviewers) requirements.push({ id: 'reviews', label: 'Independent reviews', satisfied: approvals >= reviewers || subject.approved, detail: approvals >= reviewers ? `${plural(approvals, 'independent review')} approved this version.` : subject.approved ? 'A person approved this version.' : `Waiting for ${plural(reviewers - approvals, `${approvals ? 'more ' : ''}independent review`)}.` });
  if (escalated.length) requirements.push({ id: 'risk', label: 'Reviewer escalation', satisfied: subject.approved, detail: escalated.map(review => `${reviewerName(review.reviewer)}: ${review.summary}`).join(' ').slice(0, 600) });
  if (flagged.length) requirements.push({ id: 'guard', label: 'Guards', satisfied: subject.approved, detail: flagged.map(guard => guard.detail).join(' ').slice(0, 600) });
  if (duplicate) requirements.push({ id: 'duplicate', label: 'Possible duplicate', satisfied: subject.approved, detail: `This pull request's intent closely matches open pull request #${duplicate.number}; a person should decide whether both are needed.` });
  if (looping) requirements.push({ id: 'rounds', label: 'Revision rounds', satisfied: subject.approved, detail: sentBack ? `Sent back ${sentBack} times; a person should look before the author tries again.` : 'This repository sends every pull request to a person.' });
  if (untrusted) requirements.push({ id: 'trust', label: 'Earned autonomy', satisfied: true, detail: `${subject.author.name ?? 'This author'} has ${landed} of ${plural(policy.trust.earnedAfter, 'clean landing')} needed to land without ${policy.trust.newAuthors === 'human' ? 'a person' : 'review'}.` });
  if (autonomyLevel === 'human' && !requirements.some(requirement => requirement.id !== 'reviews')) requirements.push({ id: 'human', label: 'Person approval', satisfied: subject.approved, detail: 'Policy requires a person to approve this change.' });
  requirements.push({ id: 'checks', label: 'Checks', satisfied: !failed.length, detail: failed.length ? failed.map(check => check.label).join(', ') : 'No checks have failed.' });
  return { autonomy: autonomyLevel, reviewers, requirements, rules: [...matched].sort((a, b) => a - b), protected: protectedPaths };
}

/** Changes the author must address before anyone else acts, each with what asked for it. */
export function revisionRequested(subject: Reviewed & Pick<PolicySubject, 'checks' | 'guards'>, policy: Policy): { from: 'review' | 'checks' | 'guard'; text: string }[] | null {
  const reviews = independent(subject).filter(review => review.verdict === 'revise' || review.verdict === 'reject');
  const checks = failedChecks(subject);
  const guards = (subject.guards ?? []).filter(guard => policy.guards[guard.kind] === 'revise');
  return reviews.length || checks.length || guards.length ? [...reviews.map(review => ({ from: 'review' as const, text: `${reviewerName(review.reviewer)}: ${review.summary}` })),
    ...checks.map(check => ({ from: 'checks' as const, text: `Failed: ${check.label}` })), ...guards.map(guard => ({ from: 'guard' as const, text: guard.detail }))] : null;
}
