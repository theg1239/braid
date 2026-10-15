import type { Change, ChangeCloseReason, PolicyRequirement } from './types';
import { escalations, failedChecks, GOVERNANCE, type GuardAction, type Policy } from './policy';
import { matchesAny } from './glob';
import { plural, reviewerName } from './labels';

export { progressOf } from './labels';

/** One way a person can answer. Each maps to a single request on the change. */
export type Answer =
  /** POST /api/changes/:id/approve with the current revision. */
  | { action: 'approve'; label: string }
  /** POST /api/changes/:id/reviews with verdict `revise` and the person's note as the summary. */
  | { action: 'send-back'; label: string; suggestion?: string }
  /** POST /api/changes/:id/close with the reason. */
  | { action: 'close'; label: string; reason: ChangeCloseReason };

/**
 * Why a change waits for a person and what they can do about it, stated once.
 * `label` is a two- or three-word tag for lists; `heading` says who or what
 * handed it over; `detail` is the reason in full, for the change's own page.
 */
interface ChangeQuestion {
  kind: 'escalated' | 'guard' | 'duplicate' | 'stuck' | 'size' | 'protected' | 'rule' | 'unreviewed';
  label: string; heading: string; detail: string; answers: Answer[];
}

type QuestionSubject = Pick<Change, 'status' | 'policy' | 'reviews' | 'guards' | 'duplicates' | 'revision' | 'author' | 'files' | 'next'>;

const land = (label = 'Approve and merge'): Answer => ({ action: 'approve', label });
const sendBack = (suggestion?: string): Answer => ({ action: 'send-back', label: 'Request changes', ...(suggestion ? { suggestion } : {}) });
const close = (reason: ChangeCloseReason = 'rejected', label = 'Close pull request'): Answer => ({ action: 'close', label, reason });

/** The current version's checks in one state for lists: any failure fails, any warning or pending run waits. */
export function checkStateOf(change: Pick<Change, 'revision' | 'checks'>): 'passed' | 'failed' | 'pending' | undefined {
  const current = change.checks.filter(check => check.revision === change.revision && check.source !== 'agent');
  if (!current.length) return undefined;
  if (current.some(check => check.status === 'failed')) return 'failed';
  return current.every(check => check.status === 'passed') ? 'passed' : 'pending';
}

/** Why a change went back to its author, as a short tag for lists. */
function sentBackLabel(change: Pick<Change, 'status' | 'revision' | 'conflicts' | 'checks' | 'guards'>): string | undefined {
  if (change.status !== 'revise') return undefined;
  if (change.conflicts.length) return 'Conflicts';
  if (change.guards?.some(guard => guard.kind === 'secrets')) return 'Secret found';
  if (change.guards?.some(guard => guard.kind === 'instructions')) return 'Breaks an instruction';
  const failed = failedChecks(change);
  if (failed.some(check => check.kind === 'dependencies')) return 'Vulnerable dependency';
  if (failed.length) return 'Checks failed';
  return 'Changes requested';
}
/** The tag a list shows for a change: why it needs a person, or why it went back. */
export function labelFor(change: QuestionSubject & Pick<Change, 'conflicts' | 'checks'>, policy?: Policy): string | undefined {
  return questionFor(change, policy)?.label ?? sentBackLabel(change);
}

/** The question a change in `attention` puts to a person, or null when nothing waits for one. */
export function questionFor(change: QuestionSubject, policy?: Policy): ChangeQuestion | null {
  if (change.status !== 'attention') return null;
  const unmet = new Map((change.policy?.requirements ?? []).filter(requirement => !requirement.satisfied).map(requirement => [requirement.id, requirement]));
  const detail = (id: PolicyRequirement['id']) => unmet.get(id)?.detail ?? change.next ?? '';
  if (unmet.has('risk')) {
    const escalation = escalations(change).at(-1);
    return { kind: 'escalated', label: 'Reviewer flagged', heading: escalation ? `${reviewerName(escalation.reviewer)} asked for a person` : 'A reviewer asked for a person', detail: escalation?.summary ?? detail('risk'), answers: [land(), sendBack(), close()] };
  }
  if (unmet.has('guard')) {
    const guards = change.guards ?? [];
    const tests = guards.some(guard => guard.kind === 'tests'), dependencies = guards.some(guard => guard.kind === 'dependencies'), secrets = guards.some(guard => guard.kind === 'secrets');
    if (secrets) return { kind: 'guard', label: 'Secret found', heading: 'It adds a token or private key', detail: guards.filter(guard => guard.kind === 'secrets').map(guard => guard.detail).join(' '),
      answers: [sendBack('Remove the credential and load it from an environment secret instead.'), close()] };
    if (!tests && !dependencies && guards.some(guard => guard.kind === 'instructions')) return { kind: 'guard', label: 'Breaks an instruction', heading: 'It goes against an instruction',
      detail: guards.filter(guard => guard.kind === 'instructions').map(guard => guard.detail).join(' '), answers: [land(), sendBack('Follow the instruction instead.'), close()] };
    return { kind: 'guard', label: tests ? 'Skips tests' : 'Older dependency', heading: tests && dependencies ? 'It weakens tests and downgrades a dependency' : tests ? 'It skips or removes tests' : 'It downgrades a dependency',
      detail: guards.map(guard => guard.detail).join(' ') || detail('guard'),
      answers: [land(), sendBack(tests ? 'Make the tests pass instead of skipping or removing them.' : 'Keep the current dependency versions.'), close()] };
  }
  if (unmet.has('duplicate')) {
    const duplicate = change.duplicates?.[0];
    return { kind: 'duplicate', label: 'Possible duplicate', heading: duplicate ? `It may duplicate #${duplicate.number}` : 'It may duplicate another change',
      detail: duplicate ? `Its intent closely matches #${duplicate.number}, “${duplicate.title}”.` : detail('duplicate'),
      answers: [land('Approve and keep both'), close('superseded', 'Close as duplicate')] };
  }
  if (unmet.has('rounds')) {
    return { kind: 'stuck', label: 'Keeps failing', heading: 'Its author keeps getting it sent back', detail: detail('rounds'), answers: [land(), sendBack(), close('abandoned')] };
  }
  if (unmet.has('size')) {
    return { kind: 'size', label: 'Too large', heading: 'It is larger than your rules allow', detail: detail('size'), answers: [land(), sendBack('Split this into smaller changes.'), close()] };
  }
  if (unmet.has('protected')) {
    return { kind: 'protected', label: 'Protected files', heading: 'It changes protected files', detail: detail('protected'), answers: [land(), sendBack(), close()] };
  }
  if (unmet.has('policy')) return { kind: 'rule', label: 'Policy file error', heading: 'The policy file has an error', detail: detail('policy'), answers: [land(), sendBack(), close()] };
  if (unmet.has('human')) {
    const governance = change.files.filter(file => matchesAny(file.path, GOVERNANCE)).map(file => file.path);
    if (governance.length) return { kind: 'rule', label: 'Protected files', heading: 'It changes rules, CI or agent instructions', detail: `${governance.slice(0, 3).join(', ')}${governance.length > 3 ? ` and ${governance.length - 3} more` : ''} decide what agents may do, so a person always approves changes to them.`, answers: [land(), sendBack(), close()] };
    const notes = (change.policy?.rules ?? []).flatMap(index => { const rule = policy?.rules[index]; return rule?.autonomy === 'human' && rule.note ? [rule.note] : []; });
    return { kind: 'rule', label: 'Your call', heading: 'Your rules ask you to decide', detail: notes.length ? notes.join(' ') : 'A rule for these files asks a person to approve every change.', answers: [land(), sendBack(), close()] };
  }
  if (unmet.has('reviews')) {
    return { kind: 'unreviewed', label: 'Not reviewed', heading: 'Automatic review was unavailable', detail: change.next ?? detail('reviews'), answers: [land(), sendBack(), close()] };
  }
  return { kind: 'rule', label: 'Your call', heading: 'It needs a person', detail: change.next ?? 'A person needs to decide whether this lands.', answers: [land(), sendBack(), close()] };
}

/** Policy in sentences, for people. Every field of `.braid/policy.json` that changes behaviour appears in exactly one place. */
export interface PolicySummary {
  /** Path rules in file order; later rules win for the same path. */
  areas: { paths: string[]; decides: 'auto' | 'review' | 'human'; reviewers: number; note?: string; protected?: boolean }[];
  /** What applies to every path no rule covers. */
  fallback: { decides: 'auto' | 'review' | 'human'; reviewers: number };
  checks: { install?: string; commands: string[]; minutes: number; required: string[] };
  /**
   * Code security, as GitHub names it: what each scan does when it finds
   * something ('revise' sends the change back, 'attention' asks a person),
   * and the review apps requested on GitHub merge-queue pull requests.
   */
  security: { secrets: GuardAction; dependencies: Policy['dependencyReview']; tests: GuardAction; downgrades: GuardAction; instructions: GuardAction; reviewApps: string[]; reviewWait: number };
  /** Standing safeguards as plain sentences, each with what it is about. */
  safeguards: { about: Safeguard[]; text: string }[];
}
/** What a safeguard is about, so a screen that states some of them elsewhere can leave those out. */
export type Safeguard = 'tests' | 'dependencies' | 'secrets' | 'instructions' | 'size' | 'rounds' | 'trust' | 'dependency-review' | 'duplicates' | 'delay' | 'daily' | 'governance';
export function describePolicy(policy: Policy): PolicySummary {
  const safeguards: PolicySummary['safeguards'] = [];
  const say = (about: Safeguard[], text: string) => { safeguards.push({ about, text }); };
  const guarded = (['tests', 'dependencies', 'secrets', 'instructions'] as const).filter(kind => policy.guards[kind] !== 'off');
  const guardText = { tests: 'deletes or skips tests', dependencies: 'downgrades a dependency', secrets: 'adds a token or private key', instructions: 'breaks an instruction' };
  for (const action of ['attention', 'revise'] as const) {
    const kinds = guarded.filter(kind => policy.guards[kind] === action);
    if (kinds.length) say(kinds, `A pull request that ${kinds.map(kind => guardText[kind]).join(' or ')} ${action === 'attention' ? 'goes to a person' : 'goes back to its author'}.`);
  }
  say(['size'], `A pull request over ${plural(policy.limits.files, 'file')} or ${policy.limits.lines.toLocaleString('en-US')} changed lines goes to a person.`);
  say(['rounds'], `A pull request sent back ${plural(policy.limits.revisions, 'time')} goes to a person instead of another round.`);
  if (policy.trust.earnedAfter > 0 && policy.trust.newAuthors !== 'auto')
    say(['trust'], `A new author's pull requests ${policy.trust.newAuthors === 'human' ? 'need a person' : 'need a review'} until ${policy.trust.earnedAfter} of theirs ${policy.trust.earnedAfter === 1 ? 'has' : 'have'} merged.`);
  if (policy.dependencyReview !== 'off') say(['dependency-review'], policy.dependencyReview === 'block' ? 'Dependencies a pull request adds are checked on OSV.dev, and a malicious or high-severity one sends it back.' : 'Dependencies a pull request adds are checked on OSV.dev and reported.');
  if (policy.duplicates !== 'off') say(['duplicates'], policy.duplicates === 'attention' ? 'A pull request that repeats another open one goes to a person.' : 'A pull request that repeats another open one is pointed out to its author.');
  if (policy.delay.minutes > 0) say(['delay'], `Approved pull requests wait ${plural(policy.delay.minutes, 'minute')} before merging, so a person can still stop them.`);
  if (policy.limits.dailyPerAuthor > 0) say(['daily'], `Each author can merge at most ${plural(policy.limits.dailyPerAuthor, 'pull request')} a day.`);
  say(['governance'], 'Changes to the rules, CI, code owners, agent instructions and review-app settings always need a person.');
  return {
    areas: policy.rules.map(rule => ({ paths: rule.paths, decides: policy.error ? 'human' : rule.autonomy ?? policy.autonomy, reviewers: (rule.autonomy ?? policy.autonomy) === 'auto' ? 0 : rule.reviewers ?? policy.reviewers,
      ...(rule.note && !policy.error ? { note: rule.note } : {}), ...(rule.protected ? { protected: true } : {}) })),
    fallback: { decides: policy.autonomy, reviewers: policy.autonomy === 'auto' ? 0 : policy.reviewers },
    checks: { ...(policy.install ? { install: policy.install } : {}), commands: policy.checks, minutes: policy.verify.minutes, required: policy.verify.required },
    security: { secrets: policy.guards.secrets, dependencies: policy.dependencyReview, tests: policy.guards.tests, downgrades: policy.guards.dependencies, instructions: policy.guards.instructions,
      reviewApps: policy.github.reviewers.map(reviewerName), reviewWait: policy.github.wait },
    safeguards,
  };
}
