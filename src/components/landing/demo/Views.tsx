import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  EyeIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  QuestionIcon,
  QueueIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { EXAMPLE_ADDRESS, paths } from '../../../lib/router';
import type { DemoView } from './load';
import { FLEET, PULLS, QUEUE, RULES, TASK, type DemoPull } from './data';
import desktopShot from './status-desktop.png';
import phoneShot from './status-phone.png';

export { BLAME, COMMITS, FILES } from './data';

/*
 * The demo's views past Code, drawn from the recording as the app draws them: the pull requests with their proof,
 * checks, reviews and the question a person answers; the fleet and the sample task with its agent graph and the
 * choice between two versions; and the rules. Answers that would change the repository open the same pull request
 * in the tour, where they work.
 */

type Show = (view: DemoView) => void;

/** The tour's own page for a view, where its answers work. */
const tour = (path = '') => `${paths.repo(EXAMPLE_ADDRESS)}${path}`;
const SHOTS = { desktop: desktopShot, phone: phoneShot };

/** Who made it, as the app names an agent: the model, then whose agent it was. */
function By({ by, tool }: { by: DemoPull['by']; tool?: boolean }) {
  return (
    <span className="lp-by">
      <b>{by.model ?? by.owner}</b>
      {by.model ? <span> for {by.owner}</span> : null}
      {tool && by.tool ? <code>{by.tool}</code> : null}
    </span>
  );
}

function Diff({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="lp-diff">
      <span className="lp-diff__add">+{additions}</span> <span className="lp-diff__del">−{deletions}</span>
    </span>
  );
}

/** One state icon per row: merged, closed, sent back, or waiting for a person. */
function StateIcon({ pull }: { pull: DemoPull }) {
  if (pull.state === 'merged') return <GitMergeIcon size={16} weight="bold" className="lp-tone-merged" aria-label="Merged" />;
  if (pull.state === 'closed') return <GitPullRequestIcon size={16} weight="bold" className="lp-tone-muted" aria-label="Closed" />;
  if (pull.status === 'attention') return <EyeIcon size={16} weight="bold" className="lp-tone-warn" aria-label="Needs your review" />;
  return <XCircleIcon size={16} weight="bold" className="lp-tone-fail" aria-label="Changes requested" />;
}

const tone = (pull: DemoPull) => (pull.status === 'attention' ? 'warn' : 'fail');

/* ---------- Pull requests ---------- */

export function PullsView({ pull, checks, queue, show }: { pull?: number; checks?: boolean; queue?: boolean; show: Show }) {
  if (queue) return <Queue show={show} />;
  return pull ? <Pull pull={PULLS.find((each) => each.number === pull)!} checks={checks} show={show} /> : <PullList show={show} />;
}

/**
 * The merge queue as its page draws it: one merge group combined with main, checked and merged, which plays each
 * step in turn as the view opens, then every group before it. The group is #23's, recorded; it plays, it does not run.
 */
function Queue({ show }: { show: Show }) {
  const { group } = QUEUE;
  const steps = [
    { name: 'Combine with main', detail: `${group.base} + ${group.pulls.length} pull requests` },
    { name: 'Checks', detail: `${group.checks.length} required` },
    { name: 'Merge', detail: `main ${group.base} → ${group.head}` },
  ];
  return (
    <div className="lp-queue">
      <button type="button" className="lp-back" onClick={() => show({ tab: 'pulls' })}>
        <ArrowLeftIcon size={14} aria-hidden="true" />
        Pull requests
      </button>
      <h2 className="lp-pr__title">Merge queue</h2>
      <p className="lp-pr__meta lp-muted">
        main <code>{QUEUE.head}</code> · {QUEUE.merged} merged in {QUEUE.groups} merge groups
      </p>
      <section className="lp-box lp-group" aria-label="Merge group">
        <p className="lp-box__head">
          <b>Merge group</b>
          <span className="lp-muted">compare-and-swap onto main</span>
        </p>
        <ul className="lp-rows">
          {group.pulls.map((pull) => (
            <li key={pull.number}>
              <button type="button" className="lp-row" onClick={() => show({ tab: 'pulls', pull: pull.number })}>
                <GitPullRequestIcon size={16} weight="bold" className="lp-tone-pass" aria-hidden="true" />
                <span className="lp-row__main">
                  <span className="lp-row__title">{pull.title}</span>
                  <span className="lp-row__meta">
                    #{pull.number} by <By by={pull.by} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <ol className="lp-steps">
          {steps.map((step, index) => (
            <li key={step.name} style={{ '--at': `${0.35 + index * 1.1}s` } as CSSProperties}>
              <span className="lp-steps__icon" aria-hidden="true">
                <CircleIcon size={16} className="lp-steps__wait" />
                <CheckCircleIcon size={16} weight="fill" className="lp-steps__done" />
              </span>
              <b>{step.name}</b>
              <span className="lp-muted">{step.detail}</span>
              {index === 1 ? (
                <span className="lp-steps__checks">
                  {group.checks.map((check, at) => (
                    <code key={check.label} style={{ '--at': `${1.45 + at * 0.16}s` } as CSSProperties}>
                      <CheckIcon size={11} weight="bold" aria-hidden="true" />
                      {check.label}
                    </code>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section className="lp-box" aria-label="Merged">
        <p className="lp-box__head">
          <b>History</b>
        </p>
        <ul className="lp-history">
          {QUEUE.history.map((entry, index) => (
            <li key={index} data-merged={entry.merged || undefined}>
              {entry.merged ? <GitMergeIcon size={14} weight="bold" className="lp-tone-merged" aria-label="Merged" /> : <XCircleIcon size={14} weight="bold" className="lp-tone-fail" aria-label="Sent back" />}
              <span className="lp-history__pulls">
                {entry.pulls.map((number) => `#${number}`).join(', ')}
                {entry.others ? <span className="lp-muted"> and {entry.others} more</span> : null}
                {entry.back.map((back) => (
                  <span key={back.number} className="lp-history__back">
                    {' '}
                    #{back.number} sent back: {back.reason}
                  </span>
                ))}
              </span>
              <code>{entry.merged ? `${entry.base} → ${entry.head}` : entry.base}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PullList({ show }: { show: Show }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const open = PULLS.filter((pull) => pull.state === 'open');
  const closed = PULLS.filter((pull) => pull.state !== 'open');
  return (
    <>
    <button type="button" className="lp-back" onClick={() => show({ tab: 'pulls', queue: true })}>
      <QueueIcon size={14} aria-hidden="true" />
      Merge queue · {QUEUE.merged} merged
    </button>
    <section className="lp-box">
      <div className="lp-box__head lp-states" role="group" aria-label="Pull requests by state">
        <button type="button" aria-pressed={state === 'open'} onClick={() => setState('open')}>
          <GitPullRequestIcon size={15} aria-hidden="true" />
          Open <span>{open.length}</span>
        </button>
        <button type="button" aria-pressed={state === 'closed'} onClick={() => setState('closed')}>
          <CheckIcon size={15} aria-hidden="true" />
          Closed <span>{closed.length}</span>
        </button>
      </div>
      <ul className="lp-rows">
        {(state === 'open' ? open : closed).map((pull) => (
          <li key={pull.number}>
            <button type="button" className="lp-row" onClick={() => show({ tab: 'pulls', pull: pull.number })}>
              <StateIcon pull={pull} />
              <span className="lp-row__main">
                <span className="lp-row__title">
                  {pull.title}
                  {pull.label ? (
                    <span className="lp-badge" data-tone={tone(pull)}>
                      {pull.label}
                    </span>
                  ) : null}
                </span>
                <span className="lp-row__meta">
                  #{pull.number} by <By by={pull.by} /> · {pull.progress}
                </span>
              </span>
              <Diff additions={pull.additions} deletions={pull.deletions} />
            </button>
          </li>
        ))}
      </ul>
    </section>
    </>
  );
}

const VERDICT: Record<string, string> = { approve: 'Approved', comment: 'Commented', revise: 'Changes requested', escalate: 'Asked for a person' };
const EVENT_ICON: Record<string, typeof GitCommitIcon> = {
  submitted: GitCommitIcon,
  queued: QueueIcon,
  landed: GitMergeIcon,
  overlap: CopyIcon,
  escalated: QuestionIcon,
  closed: XCircleIcon,
  revised: ArrowsClockwiseIcon,
  checks: XCircleIcon,
  conflict: WarningIcon,
  approved: CheckIcon,
};
const SOURCES = [
  { source: 'braid', name: 'Braid' },
  { source: 'github', name: 'GitHub' },
  { source: 'ci', name: 'CI' },
  { source: 'agent', name: 'Agent-reported' },
];

function Pull({ pull, checks, show }: { pull: DemoPull; checks?: boolean; show: Show }) {
  const [tab, setTab] = useState<'conversation' | 'checks'>(checks ? 'checks' : 'conversation');
  const id = (name: string) => `lp-pr-${pull.number}-${name}`;
  return (
    <article className="lp-pr" aria-labelledby={id('title')}>
      <button type="button" className="lp-back" onClick={() => show({ tab: 'pulls' })}>
        <ArrowLeftIcon size={14} aria-hidden="true" />
        Pull requests
      </button>
      <h2 id={id('title')} className="lp-pr__title">
        {pull.title} <span>#{pull.number}</span>
      </h2>
      <p className="lp-pr__meta">
        <span className="lp-state" data-state={pull.state}>
          {pull.state === 'merged' ? <GitMergeIcon size={13} weight="bold" aria-hidden="true" /> : pull.state === 'closed' ? <XCircleIcon size={13} weight="bold" aria-hidden="true" /> : <GitPullRequestIcon size={13} weight="bold" aria-hidden="true" />}
          {pull.state === 'merged' ? 'Merged' : pull.state === 'closed' ? 'Closed' : 'Open'}
        </span>
        <By by={pull.by} />
        <Diff additions={pull.additions} deletions={pull.deletions} />
      </p>
      <div className="lp-subtabs" role="tablist" aria-label={`Pull request #${pull.number}`}>
        {(['conversation', 'checks'] as const).map((each) => (
          <button
            key={each}
            id={id(each)}
            type="button"
            role="tab"
            aria-selected={tab === each}
            aria-controls={tab === each ? id(`${each}-panel`) : undefined}
            tabIndex={tab === each ? 0 : -1}
            onClick={() => setTab(each)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const next = each === 'conversation' ? 'checks' : 'conversation';
              setTab(next);
              (event.currentTarget.parentElement!.querySelector(`#${id(next)}`) as HTMLElement).focus();
            }}
          >
            {each === 'conversation' ? 'Conversation' : 'Checks'}
            {each === 'checks' ? <span className="lp-shot__count">{pull.checks.length}</span> : null}
          </button>
        ))}
      </div>
      <div id={id(`${tab}-panel`)} role="tabpanel" aria-labelledby={id(tab)} className="lp-pr__body">
        {tab === 'conversation' ? <Conversation pull={pull} /> : <Checks pull={pull} />}
      </div>
    </article>
  );
}

function Conversation({ pull }: { pull: DemoPull }) {
  return (
    <>
      <section className="lp-box">
        <p className="lp-box__head">
          <By by={pull.by} tool />
        </p>
        <p className="lp-box__body">{pull.summary}</p>
      </section>
      {pull.shots.length || pull.commands.length ? (
        <section className="lp-box" aria-label="Proof">
          <p className="lp-box__head">Proof</p>
          {pull.shots.length ? (
            <div className="lp-proofs">
              <p className="lp-proofs__page">
                <code>{pull.shots[0].page}</code>
                <span>{pull.shots[0].where}</span>
              </p>
              {pull.shots.map((shot) => (
                <figure key={shot.viewport} className="lp-proofs__shot" data-viewport={shot.viewport}>
                  <img src={SHOTS[shot.viewport]} width={shot.width} height={shot.height} alt={`${pull.shots[0].page} on a ${shot.viewport === 'phone' ? 'phone' : 'desktop'}, ${shot.width} by ${shot.height}`} loading="lazy" decoding="async" />
                  <figcaption>
                    {shot.viewport === 'phone' ? 'Phone' : 'Desktop'} · {shot.width}×{shot.height}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          <ul className="lp-commands">
            {pull.commands.map((command, index) => (
              <li key={index}>
                {command.ok ? <CheckCircleIcon size={15} weight={command.where === 'Braid' ? 'fill' : 'regular'} className="lp-tone-pass" aria-label="Passed" /> : <XCircleIcon size={15} weight="fill" className="lp-tone-fail" aria-label="Failed" />}
                <code>{command.command}</code>
                <span className="lp-commands__time">{command.seconds}s</span>
                <span className="lp-commands__where">{command.where}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ol className="lp-timeline">
        {pull.events.filter((event) => !(pull.question && event.type === 'escalated')).map((event, index) => {
          const Icon = EVENT_ICON[event.type] ?? GitCommitIcon;
          return (
            <li key={index} data-type={event.type}>
              <Icon size={13} weight="bold" aria-hidden="true" />
              <span>{event.message}</span>
            </li>
          );
        })}
      </ol>
      {pull.reviews.map((review, index) => (
        <section key={index} className="lp-box" aria-label={`Review by ${review.reviewer}`}>
          <p className="lp-box__head">
            <b>{review.reviewer}</b>
            {review.app ? <span className="lp-tag">GitHub app</span> : null}
            <span className="lp-verdict" data-verdict={review.verdict}>
              {VERDICT[review.verdict] ?? review.verdict}
            </span>
            {review.risk ? <span className="lp-muted">{review.risk} risk</span> : null}
          </p>
          <p className="lp-box__body">{review.summary}</p>
        </section>
      ))}
      <MergeBox pull={pull} said={pull.reviews.some((review) => review.summary === pull.question?.detail)} />
    </>
  );
}

/** The end of the conversation: where it merged, why it closed, or the one question it puts to a person. */
function MergeBox({ pull, said }: { pull: DemoPull; said: boolean }) {
  if (pull.state === 'merged')
    return (
      <p className="lp-merge" data-state="merged">
        <GitMergeIcon size={16} weight="bold" aria-hidden="true" />
        Merged into main as <code>{pull.merged}</code>
      </p>
    );
  if (pull.state === 'closed')
    return (
      <p className="lp-merge" data-state="closed">
        <XCircleIcon size={16} weight="bold" aria-hidden="true" />
        Closed
      </p>
    );
  const question = pull.question;
  return (
    <section className="lp-merge" data-state={pull.status} aria-label={question ? question.label : pull.progress}>
      <p className="lp-merge__head">
        {question ? <QuestionIcon size={16} weight="bold" aria-hidden="true" /> : <XCircleIcon size={16} weight="bold" aria-hidden="true" />}
        <b>{question ? question.heading : pull.progress}</b>
        {!question && pull.label ? (
          <span className="lp-badge" data-tone="fail">
            {pull.label}
          </span>
        ) : null}
      </p>
      {question ? (
        <>
          {said ? null : <p className="lp-merge__detail">{question.detail}</p>}
          <p className="lp-merge__answers">
            {question.answers.map((answer, index) => (
              <a key={answer} className="lp-button" data-primary={index === 0 || undefined} href={tour(`/pull/${pull.number}`)}>
                {answer}
              </a>
            ))}
          </p>
        </>
      ) : null}
    </section>
  );
}

function Checks({ pull }: { pull: DemoPull }) {
  if (!pull.checks.length) return <p className="lp-empty">No checks ran on this version.</p>;
  return (
    <section className="lp-box">
      {SOURCES.filter(({ source }) => pull.checks.some((check) => check.source === source)).map(({ source, name }) => (
        <div key={source} className="lp-checks">
          <p className="lp-checks__group">{name}</p>
          <ul>
            {pull.checks
              .filter((check) => check.source === source)
              .map((check, index) => (
                <li key={index}>
                  {check.status === 'passed' ? <CheckCircleIcon size={15} weight="fill" className="lp-tone-pass" aria-hidden="true" /> : <XCircleIcon size={15} weight="fill" className="lp-tone-fail" aria-hidden="true" />}
                  <code>{check.label}</code>
                  <span className="lp-checks__detail">{check.detail}</span>
                  <span className="lp-checks__state" data-status={check.status}>
                    {check.status === 'passed' ? 'Passed' : 'Failed'}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* ---------- Agents ---------- */

export function AgentsView({ task, show }: { task?: boolean; show: Show }) {
  return task ? <Task show={show} /> : <Fleet show={show} />;
}

const MODELS = TASK.agents.map((agent) => agent.model).join(', ');
const TASK_FILES = new Set(TASK.agents.flatMap((agent) => agent.files.map((file) => file.path))).size;

function Fleet({ show }: { show: Show }) {
  const most = Math.max(...FLEET.map((agent) => agent.alive));
  return (
    <>
      <section className="lp-box">
        <p className="lp-box__head">
          <b>Tasks</b> <span className="lp-muted">1</span>
        </p>
        <button type="button" className="lp-row" onClick={() => show({ tab: 'agents', task: true })}>
          <QuestionIcon size={16} weight="fill" className="lp-tone-warn" aria-hidden="true" />
          <span className="lp-row__main">
            <span className="lp-row__title">
              {TASK.title}
              <span className="lp-badge" data-tone="warn">
                Needs your choice
              </span>
            </span>
            <span className="lp-row__meta">
              {MODELS} · {TASK_FILES} files
            </span>
          </span>
        </button>
      </section>
      <section className="lp-box">
        <p className="lp-box__head">
          <b>Fleet</b> <span className="lp-muted">{FLEET.length}</span>
        </p>
        <table className="lp-fleet">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Merged</th>
              <th scope="col" data-wide="">
                Sent back
              </th>
              <th scope="col" data-wide="">
                Open
              </th>
              <th scope="col" data-wide="">
                Lines added
              </th>
              <th scope="col">Lines on main</th>
            </tr>
          </thead>
          <tbody>
            {FLEET.map((agent) => (
              <tr key={`${agent.model}${agent.owner}`}>
                <th scope="row">
                  <span className="lp-by">
                    <b>{agent.model}</b>
                    <span> for {agent.owner}</span>
                    <code>{agent.tool}</code>
                  </span>
                </th>
                <td>{agent.merged}</td>
                <td data-wide="">{agent.sentBack}</td>
                <td data-wide="">{agent.open}</td>
                <td data-wide="">{agent.added}</td>
                <td>
                  <span className="lp-fleet__alive">
                    {agent.alive}
                    <span className="lp-fleet__bar" aria-hidden="true">
                      <span style={{ width: `${(agent.alive / most) * 100}%` }} />
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

const [FIRST, SECOND] = TASK.agents.filter((agent) => agent.version);
const SHARED = TASK.agents[0].files.find((file) => file.path !== TASK.conflict && TASK.agents[1].files.some((other) => other.path === file.path))!.path;
const base = (path: string) => path.split('/').at(-1)!;
type Lane = (typeof TASK.agents)[number];

/** The task's agent graph, as the task page draws it: three lanes from one commit, where two wrote the same file. */
function Graph({ chosen }: { chosen?: Lane }) {
  return (
    <figure className="lp-graph" aria-label={`${TASK.agents.length} agents started from main at ${TASK.base}. ${base(SHARED)} is the same in two lanes; ${base(TASK.conflict)} has two versions${chosen ? `, and ${chosen.model}'s is chosen` : ''}.`}>
      <p className="lp-graph__ends" aria-hidden="true">
        <span>from main {TASK.base}</span>
        <span>into main</span>
      </p>
      <div className="lp-graph__lanes" aria-hidden="true">
        {TASK.agents.map((agent) => (
          <p key={agent.id} className="lp-graph__lane" data-chosen={chosen?.id === agent.id || undefined} data-dropped={(chosen && agent.version && chosen.id !== agent.id) || undefined}>
            <span className="lp-graph__who">
              <b>
                {agent.model} for {agent.owner}
              </b>{' '}
              {agent.role}
            </span>
            <span className="lp-graph__line" />
            <code>{agent.commit}</code>
          </p>
        ))}
        <span className="lp-graph__mark" data-kind="same">
          <i>=</i> {base(SHARED)} same
        </span>
        <span className="lp-graph__mark" data-kind={chosen ? 'chosen' : 'versions'}>
          <i>◆</i> {base(TASK.conflict)} {chosen ? chosen.model : '2 versions'}
        </span>
      </div>
    </figure>
  );
}

function Task({ show }: { show: Show }) {
  const [chosen, choose] = useState<Lane>();
  const [compare, setCompare] = useState(false);
  return (
    <article className="lp-task" aria-labelledby="lp-task-title">
      <h2 id="lp-task-title" className="lp-task__title">
        <button type="button" className="lp-back" onClick={() => show({ tab: 'agents' })}>
          Agents
        </button>{' '}
        <span aria-hidden="true">/</span> {TASK.title}
      </h2>
      <p className="lp-pr__meta">
        <span className="lp-badge" data-tone={chosen ? 'pass' : 'warn'}>
          {chosen ? 'Version chosen' : 'Needs your choice'}
        </span>
        <span className="lp-muted">
          {TASK.agents.length} agents · {TASK_FILES} files
        </span>
      </p>
      <p className="lp-task__intent">{TASK.intent}</p>
      <Graph chosen={chosen} />
      <section className="lp-box lp-choose" aria-labelledby="lp-choose">
        <p className="lp-box__head">
          <b id="lp-choose">Choose a version</b>
          <code>{TASK.conflict}</code>
        </p>
        <div className="lp-choose__cards">
          {[FIRST, SECOND].map((agent) => (
            <div key={agent.id} className="lp-version" data-chosen={chosen?.id === agent.id || undefined}>
              <p className="lp-version__who">
                <b>
                  {agent.model} for {agent.owner}
                </b>
                <Diff additions={agent.files.find((file) => file.path === TASK.conflict)!.additions} deletions={0} />
              </p>
              <p className="lp-version__summary">{agent.summary}</p>
              <button type="button" className="lp-button" aria-pressed={chosen?.id === agent.id} onClick={() => choose(chosen?.id === agent.id ? undefined : agent)}>
                {chosen?.id === agent.id ? (
                  <>
                    <CheckIcon size={13} weight="bold" aria-hidden="true" /> Chosen
                  </>
                ) : (
                  'Use this version'
                )}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="lp-link" aria-expanded={compare} onClick={() => setCompare(!compare)}>
          Compare versions
        </button>
        {compare ? (
          <div className="lp-compare">
            {[FIRST, SECOND].map((agent) => (
              <figure key={agent.id}>
                <figcaption>{agent.model}</figcaption>
                <pre tabIndex={0} aria-label={`${agent.model}'s ${TASK.conflict}`}>
                  {agent.version!.join('\n')}
                </pre>
              </figure>
            ))}
          </div>
        ) : null}
      </section>
    </article>
  );
}

/* ---------- Settings ---------- */

const DECIDES: Record<string, string> = { auto: 'Merge automatically', review: 'Require review', human: 'Require a person' };

function Row({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <li className="lp-setting">
      <span>{label}</span>
      {children ? <span className="lp-setting__value">{children}</span> : null}
    </li>
  );
}

export function SettingsView() {
  const rows = [...RULES.areas.map((area) => ({ paths: area.paths, decides: area.decides, reviewers: area.reviewers, note: 'note' in area ? area.note : undefined })), { paths: null, decides: RULES.fallback.decides, reviewers: RULES.fallback.reviewers, note: undefined }];
  return (
    <div className="lp-rules">
      <h2 className="lp-rules__title">
        Rules <code>.braid/policy.json</code>
      </h2>
      <section className="lp-box">
        <p className="lp-box__head">
          <b>Rulesets</b>
        </p>
        <table className="lp-rulesets">
          <thead>
            <tr>
              <th scope="col">Files</th>
              <th scope="col">Merge</th>
              <th scope="col">Reviews</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{row.paths ? row.paths.map((path) => <code key={path}>{path}</code>) : 'Everything else'}</td>
                <td>
                  <span data-decides={row.decides}>{DECIDES[row.decides]}</span>
                  {row.note ? <span className="lp-rulesets__note">{row.note}</span> : null}
                </td>
                <td>{row.reviewers || null}</td>
              </tr>
            ))}
            <tr>
              <td>
                {RULES.protected.map((path) => (
                  <code key={path}>{path}</code>
                ))}
                <span className="lp-muted">+{RULES.more} more</span>
              </td>
              <td>
                <span data-decides="human">{DECIDES.human}</span>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </section>
      <section className="lp-box">
        <p className="lp-box__head">
          <b>Required checks</b>
        </p>
        <ul className="lp-settings">
          {RULES.checks.install ? (
            <Row label="Install">
              <code>{RULES.checks.install}</code>
            </Row>
          ) : null}
          <Row label="Commands">
            {RULES.checks.commands.map((command) => (
              <code key={command}>{command}</code>
            ))}
          </Row>
          {RULES.github ? <Row label="GitHub checks">{RULES.github}</Row> : null}
          <Row label="Timeout">{RULES.checks.minutes} minutes</Row>
        </ul>
      </section>
      <section className="lp-box">
        <p className="lp-box__head">
          <b>Safeguards</b>
        </p>
        <ul className="lp-settings">
          {RULES.safeguards.map((sentence) => (
            <Row key={sentence} label={sentence} />
          ))}
        </ul>
      </section>
    </div>
  );
}
