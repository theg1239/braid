import { useState, type ReactNode } from 'react';
import { Banner, Button, Checkbox, Collapsible, InlineCopyText, InputArea, Tooltip, useKumoToastManager } from '@cloudflare/kumo';
import { ArrowUUpLeftIcon, ClockIcon, CaretDownIcon, GitMergeIcon, GitPullRequestIcon, ImagesSquareIcon } from '@phosphor-icons/react';
import type { Change } from '../../../shared/types';
import type { Policy } from '../../../shared/policy';
import { progressOf, questionFor, type Answer } from '../../../shared/questions';
import { changes, errorMessage } from '../../lib/api';
import { VERDICT, authorLine, reviewState, reviewerLabel, reviewsFor } from '../../lib/changes';
import { SOURCE_LABEL, VIEWPORT_LABEL, commandState, proofLabel, proofOf } from '../../lib/evidence';
import { plural, shortHash } from '../../lib/format';
import { useIdempotencyKey, useNow } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { navigate, paths } from '../../lib/router';
import { answerBlocker, liveBlocker, useSnapshot } from '../../store/workspace';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { RouterLink } from '../ui/Link';
import { CheckStateIcon, ReviewStateIcon, VerdictIcon } from './Bits';
import { PullReferences, Restack } from './Stack';
import { checkRowsAsChecks, checkWord, mergeChecksSummary } from './Checks';
import { revertBlocker, useRevert } from './revert';
import { RelativeTime } from '../ui/Time';
import { DisclosureTrigger } from '../ui/Disclosure';

const DECIDES = { auto: 'merges automatically', review: 'requires review', human: 'requires a person' } as const;
const CLOSE_TEXT = { rejected: 'It will not merge.', superseded: 'Another pull request carries this work.', abandoned: 'Nothing more happens to it.' } as const;
/** An instruction every agent reads is at most this long, so a comment that becomes one is capped here. */
const INSTRUCTION_LIMIT = 500;

/** A merge box row. With a list behind it, the row opens as GitLab's gate rows do; without one it is a line. */
function Row({ state, icon, label, children }: { state: string; icon: ReactNode; label: ReactNode; children?: ReactNode }) {
  if (!children) {
    return (
      <li className="mergebox__row" data-state={state}>
        {icon}
        <span className="mergebox__label">{label}</span>
      </li>
    );
  }
  return (
    <li className="mergebox__row mergebox__row--fold" data-state={state}>
      <details className="mergebox__fold">
        <summary className="mergebox__summary">
          {icon}
          <span className="mergebox__label">{label}</span>
          <CaretDownIcon size={12} weight="bold" className="mergebox__caret" aria-hidden="true" />
        </summary>
        {children}
      </details>
    </li>
  );
}

/**
 * Why a sent-back pull request went back, when the merge box's rows do not already say it: a failed
 * check is named in the checks row and a conflict in the conflicts row, so only other reasons repeat.
 */
export function sentBackDetail(change: Pick<Change, 'status' | 'next' | 'sentBack'>): string | undefined {
  if (change.status !== 'revise' || change.sentBack === 'checks' || change.sentBack === 'conflicts') return undefined;
  return change.next;
}

/**
 * GitHub's merge box: status rows for review, checks and conflicts, then what happens next.
 * When a pull request needs a person it asks its question here, once, with its answers.
 */
export function MergeBox({ change, policy, branch, onUpdated, comment = '', onCommentUsed }: { change: Change; policy: Policy | undefined; branch: string; onUpdated: (next: Change) => void; comment?: string; onCommentUsed?: () => void }) {
  if (change.status === 'landed') return <MergedBox change={change} branch={branch} />;
  if (change.status === 'closed') return <ClosedBox change={change} />;
  const review = reviewState(change);
  const reviews = reviewsFor(change.reviews, change.revision);
  const rows = checkRowsAsChecks(change, policy);
  const checks = mergeChecksSummary(rows);
  const conflicts = change.conflicts.length;
  const proof = proofOf(change.evidence, change.revision);
  const shown = proof ? proofLabel(proof) : null;
  const unmetReviews = change.policy?.requirements.find((requirement) => requirement.id === 'reviews' && !requirement.satisfied)?.detail;
  // The rows above already say the review state; the heading only adds what they do not.
  const heading = change.waitingOn?.length ? null : progressOf(change.status) !== review.label ? progressOf(change.status) : null;
  const detail = change.outdated?.length && !change.conflicts.length ? undefined : change.status === 'revise' ? sentBackDetail(change) : change.status === 'open' ? unmetReviews : undefined;
  const moving = change.status === 'queued' || change.status === 'landing';
  const failedChecks = change.status === 'revise' && checks.state === 'failed';
  return (
    <section id="merge-status" tabIndex={-1} className="mergebox" data-status={change.status} aria-label="Merge status">
      <ul className="mergebox__rows">
        {change.waitingOn?.length && !change.waitingOn.some(item => item.status === 'closed') ? <Row state="waiting" icon={<ClockIcon size={16} className="check-state" aria-hidden="true" />} label={<span>Waiting on <PullReferences items={change.waitingOn} /></span>} /> : null}
        <Row state={review.state} icon={<ReviewStateIcon state={review.state} label="" />} label={review.label}>
          {reviews.length ? (
            <ul className="mergebox__list" aria-label="Reviews">
              {reviews.map((review) => {
                const who = reviewerLabel(review);
                return (
                  <li key={review.id} className="mergebox__item">
                    <VerdictIcon verdict={review.verdict} size={15} />
                    <span className="mergebox__item-name">{who.name}</span>
                    <span className="mergebox__item-state">{VERDICT[review.verdict].label}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Row>
        <Row state={checks.state} icon={<CheckStateIcon state={checks.state} label="" />} label={checks.state === 'none' ? 'No checks ran' : checks.label}>
          {rows.length ? (
            <ul className="mergebox__list" aria-label="Checks">
              {rows.map((check, index) => (
                <li key={index} className="mergebox__item">
                  <CheckStateIcon state={check.status === 'failed' ? 'failed' : check.source === 'agent' ? 'reported' : check.status} label="" size={15} />
                  <span className="mergebox__item-name">{check.label}</span>
                  <span className="mergebox__item-state">{checkWord(check.status, check.source === 'agent')}</span>
                </li>
              ))}
              <li className="mergebox__item mergebox__item--link">
                <RouterLink href={paths.pull(change.number, { tab: 'checks' })} className="text-link">
                  Checks
                </RouterLink>
              </li>
            </ul>
          ) : null}
        </Row>
        {proof && shown ? (
          <Row
            state={shown.state}
            icon={shown.state === 'none' ? <ImagesSquareIcon size={16} className="check-state" aria-hidden="true" /> : <CheckStateIcon state={shown.state} label="" />}
            label={shown.state === 'failed' && change.status === 'revise' ? `${shown.label} · sent back` : shown.label}
          >
            <ul className="mergebox__list" aria-label="Proof">
              {proof.pages.map((page) => (
                <li key={page.page} className="mergebox__item">
                  <ImagesSquareIcon size={15} className="check-state" aria-hidden="true" />
                  <span className="mergebox__item-name mono">{page.page}</span>
                  <span className="mergebox__item-state">{page.shots.map((shot) => VIEWPORT_LABEL[shot.viewport]).join(' · ')}</span>
                </li>
              ))}
              {proof.commands.map((command, index) => (
                <li key={index} className="mergebox__item">
                  <CheckStateIcon state={commandState(command)} label="" size={15} />
                  <span className="mergebox__item-name mono">{command.command}</span>
                  <span className="mergebox__item-state">
                    {command.exitCode === 0 ? 'Passed' : `Exit ${command.exitCode}`} · {SOURCE_LABEL[command.source]}
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
        <Row
          state={conflicts ? 'failed' : 'passed'}
          icon={<GitMergeIcon size={16} weight="bold" className="check-state" data-state={conflicts ? 'failed' : 'passed'} aria-hidden="true" />}
          label={
            conflicts ? (
              <RouterLink href={paths.pull(change.number, { tab: 'files' })} className="text-link">
                {plural(conflicts, 'conflict')} with {change.outdated?.length ? 'prerequisites' : branch}
              </RouterLink>
            ) : (
              `No conflicts with ${branch}`
            )
          }
        />
      </ul>
      {change.outdated?.length && !change.waitingOn?.some(item => item.status === 'closed') ? <div className="mergebox__action"><Restack change={change} onUpdated={onUpdated} /></div> : null}
      {change.status === 'attention' ? (
        <div className="mergebox__action">
          <Question change={change} policy={policy} onUpdated={onUpdated} comment={comment} onCommentUsed={onCommentUsed} />
        </div>
      ) : heading || detail || moving || failedChecks ? (
        <div className="mergebox__action">
          {heading ? <p className="mergebox__heading">{heading}</p> : null}
          {detail ? <p className="mergebox__detail">{detail}</p> : null}
          {moving ? (
            <RouterLink href={paths.queue()} className="text-link mergebox__link">
              View merge queue
            </RouterLink>
          ) : null}
          {failedChecks ? <RouterLink href={paths.pull(change.number, { tab: 'checks' })} className="text-link mergebox__link">View failed checks</RouterLink> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The question a pull request asks a person: its reason once, then at most three answers that name their effect. */
function Question({ change, policy, onUpdated, comment, onCommentUsed }: { change: Change; policy: Policy | undefined; onUpdated: (next: Change) => void; comment: string; onCommentUsed?: () => void }) {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  const reviewAttempt = useIdempotencyKey();
  const blocker = answerBlocker(snapshot);
  // An instruction is a change to the repository, so the recorded example and members cannot add one.
  const instructBlocker = liveBlocker(snapshot);
  const [sendingBack, setSendingBack] = useState<Extract<Answer, { action: 'send-back' }> | null>(null);
  const [note, setNote] = useState('');
  const [instruct, setInstruct] = useState(false);
  const [closing, setClosing] = useState<Extract<Answer, { action: 'close' }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const question = change.waitingOn?.some(item => item.status === 'closed')
    ? { kind: 'dependency', heading: 'Dependency closed', detail: change.next ?? '', answers: [{ action: 'send-back', label: 'Request changes', suggestion: change.next }, { action: 'close', label: 'Close pull request', reason: 'abandoned' }] satisfies Answer[] }
    : questionFor(change, policy);
  if (!question) return null;

  const settle = (next: Change, title: string, description?: string) => {
    onUpdated(next);
    toasts.add({ title, description: description ?? `#${next.number} ${next.title}`, variant: 'success' });
    refreshLive('changes');
    refreshLive('queue');
  };

  const approve = async (answer: Answer) => {
    setBusy(answer.label);
    setError(null);
    try {
      const body = comment.trim() || undefined;
      settle(await changes.approve(change.id, change.revision, body, reviewAttempt.key(['approve', change.id, change.revision, body])), 'Queued to merge', `#${change.number} ${change.title}`);
      reviewAttempt.settle(); onCommentUsed?.();
    } catch (err) {
      reviewAttempt.settle(err);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendBack = async () => {
    const text = note.trim();
    if (!text) return;
    setBusy('send-back');
    setError(null);
    try {
      settle(await changes.sendBack(change.id, change.revision, text, reviewAttempt.key(['review', change.id, change.revision, text])), 'Changes requested', `#${change.number} goes back to ${authorLine(change.author)}.`);
      reviewAttempt.settle(); onCommentUsed?.();
      setSendingBack(null);
      setNote('');
    } catch (err) {
      reviewAttempt.settle(err);
      setError(errorMessage(err));
      setBusy(null);
      return;
    }
    // The review is done; the instruction is its own pull request and reports on its own.
    if (instruct && !instructBlocker) {
      const key = attempt.key(['instruction', change.id, change.revision, text]);
      try {
        const opened = await changes.addInstruction({ text }, key);
        attempt.settle();
        toasts.add({ title: 'Instruction opened as a pull request', description: `#${opened.number} ${opened.title}`, variant: 'success', actions: [{ children: 'View', size: 'sm', variant: 'secondary', onClick: () => navigate(paths.pull(opened.number)) }] });
      } catch (err) {
        attempt.settle(err);
        toasts.add({ title: 'Instruction not added', description: errorMessage(err), variant: 'error' });
      }
    }
    setBusy(null);
  };

  const rules = (change.policy?.rules ?? []).map((index) => policy?.rules[index]).filter((rule): rule is NonNullable<typeof rule> => !!rule);

  return (
    <div className="question" data-kind={question.kind}>
      <h2 className="mergebox__heading" id="question-title">
        {question.heading}
      </h2>
      {question.detail ? <p className="mergebox__detail">{question.detail}</p> : null}
      {sendingBack ? (
        <div className="question__note">
          <InputArea
            label="Comment"
            placeholder="What should change before this can merge?"
            value={note}
            onValueChange={setNote}
            autoResize
            minRows={2}
            maxRows={6}
            maxLength={instruct ? INSTRUCTION_LIMIT : 8000}
            description={instruct ? `${note.length} / ${INSTRUCTION_LIMIT}` : undefined}
            autoFocus
          />
          {instructBlocker ? (
            <Tooltip content={instructBlocker} render={<span className="question__option" tabIndex={0} />}>
              <Checkbox label="Add as an instruction for every agent" checked={false} disabled />
            </Tooltip>
          ) : (
            <Checkbox
              label="Add as an instruction for every agent"
              checked={instruct}
              onCheckedChange={(checked) => {
                setInstruct(checked);
                if (checked) setNote((current) => current.slice(0, INSTRUCTION_LIMIT));
              }}
            />
          )}
          <div className="question__answers">
            <Button variant="primary" loading={busy === 'send-back'} disabled={!note.trim()} onClick={() => void sendBack()}>
              {sendingBack.label}
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => setSendingBack(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="question__answers" title={blocker ?? undefined}>
          {question.answers.map((answer, index) => (
            <Button
              key={answer.label}
              variant={index === 0 ? 'primary' : 'secondary'}
              icon={answer.action === 'approve' ? GitMergeIcon : undefined}
              disabled={!!blocker || !!busy}
              loading={busy === answer.label}
              onClick={() => {
                if (answer.action === 'approve') void approve(answer);
                else if (answer.action === 'send-back') {
                  setNote(comment || answer.suggestion || '');
                  setSendingBack(answer);
                } else setClosing(answer);
              }}
            >
              {answer.label}
            </Button>
          ))}
        </div>
      )}
      {error && !blocker ? <Banner variant="error" size="sm" description={error} /> : null}
      {rules.length || change.policy ? (
        <Collapsible.Root className="question__why">
          <DisclosureTrigger>Which rule applies</DisclosureTrigger>
          <Collapsible.Panel className="disclosure__panel">
            <ul className="rule-refs">
              {rules.map((rule, index) => (
                <li key={index} className="rule-ref">
                  <span className="rule-ref__paths mono">{rule.paths.join(', ')}</span>
                  <span className="rule-ref__effect">{rule.protected ? 'may not change without a person' : DECIDES[rule.autonomy ?? policy?.autonomy ?? 'review']}</span>
                  {rule.note ? <span className="rule-ref__note">{rule.note}</span> : null}
                </li>
              ))}
              {!rules.length && policy ? (
                <li className="rule-ref">
                  <span className="rule-ref__paths mono">everything else</span>
                  <span className="rule-ref__effect">{DECIDES[policy.autonomy]}</span>
                </li>
              ) : null}
            </ul>
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : null}
      <ConfirmDialog
        open={!!closing}
        title={`Close #${change.number}?`}
        description={closing ? CLOSE_TEXT[closing.reason] : ''}
        confirmLabel={closing?.label ?? 'Close'}
        onClose={() => setClosing(null)}
        onConfirm={async () => {
          if (!closing) return;
          settle(await changes.close(change.id, closing.reason), 'Closed');
        }}
      />
    </div>
  );
}

/** GitHub's "Merged" box: when, as which commit, and Revert. */
function MergedBox({ change, branch }: { change: Change; branch: string }) {
  const snapshot = useSnapshot();
  const now = useNow();
  const revert = useRevert();
  const [confirming, setConfirming] = useState(false);
  const reason = revertBlocker(snapshot) ?? (change.landedParent ? null : 'This pull request merged before Braid recorded where, so it cannot be reverted here.');

  return (
    <section id="merge-status" tabIndex={-1} className="mergebox mergebox--merged" aria-label="Merged">
      <div className="mergebox__done">
        <GitMergeIcon size={18} weight="bold" className="mergebox__done-icon" aria-hidden="true" />
        <div className="mergebox__done-text">
          <p className="mergebox__heading">
            Merged into {branch}
            {change.landedCommit ? (
              <>
                {' '}
                as{' '}
                <InlineCopyText value={change.landedCommit} labels={{ copyAction: `Copy commit hash ${shortHash(change.landedCommit)}`, copied: `Copied commit hash ${shortHash(change.landedCommit)}` }}>
                  <span className="mono">{shortHash(change.landedCommit)}</span>
                </InlineCopyText>
              </>
            ) : null}
            {change.landedAt ? (
              <>
                {' '}
                <RelativeTime at={change.landedAt} now={now} />
              </>
            ) : null}
          </p>
          {change.revertedBy ? (
            <p className="mergebox__detail">
              Reverted by{' '}
              <RouterLink href={paths.pull(change.revertedBy.number)} className="text-link">
                #{change.revertedBy.number}
              </RouterLink>
            </p>
          ) : null}
          {change.revertOf ? (
            <p className="mergebox__detail">
              Reverts{' '}
              <RouterLink href={paths.pull(change.revertOf.number)} className="text-link">
                #{change.revertOf.number}
              </RouterLink>
            </p>
          ) : null}
        </div>
        {!change.revertedBy && !change.revertOf ? (
          reason ? (
            <Tooltip content={reason} render={<span className="mergebox__disabled" tabIndex={0} />}>
              <Button variant="secondary" icon={ArrowUUpLeftIcon} disabled aria-describedby={undefined}>
                Revert
              </Button>
            </Tooltip>
          ) : (
            <Button variant="secondary" icon={ArrowUUpLeftIcon} onClick={() => setConfirming(true)}>
              Revert
            </Button>
          )
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Revert #${change.number}?`}
        description="A new pull request restores its files to the version before it merged."
        confirmLabel="Revert"
        variant="primary"
        onClose={() => setConfirming(false)}
        onConfirm={() => revert(change)}
      />
    </section>
  );
}

function ClosedBox({ change }: { change: Change }) {
  const now = useNow();
  return (
    <section id="merge-status" tabIndex={-1} className="mergebox mergebox--closed" aria-label="Closed">
      <div className="mergebox__done">
        <GitPullRequestIcon size={18} weight="bold" className="mergebox__done-icon" aria-hidden="true" />
        <div className="mergebox__done-text">
          <p className="mergebox__heading">
            Closed{' '}
            <RelativeTime at={change.updatedAt} now={now} />
          </p>
        </div>
      </div>
    </section>
  );
}
