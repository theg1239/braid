import { useState, type ReactNode } from 'react';
import { Banner, Button, Collapsible, DropdownMenu } from '@cloudflare/kumo';
import { ArrowSquareOutIcon, ArrowUUpLeftIcon, DotsThreeIcon, GitBranchIcon, GithubLogoIcon, PauseIcon } from '@phosphor-icons/react';
import type { BatchCi, BatchSummary, TrunkStatus } from '../../shared/types';
import { changes, type PolicyFile } from '../lib/api';
import { listInterval, queueInterval } from '../lib/lists';
import { QUEUE_LIST_KEY, queueList } from '../lib/needs';
import { batchSentence, retried } from '../lib/changes';
import { shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { paths } from '../lib/router';
import { liveBlocker, useSnapshot } from '../store/workspace';
import { PullRow } from '../components/pulls/PullRow';
import { revertBlocker, useRevert } from '../components/pulls/revert';
import { QueueControl } from '../components/queue/QueueControl';
import { QueueStacks } from '../components/queue/Stacks';
import { Simulation } from '../components/queue/Simulation';
import { NoRepositoryPanel } from '../components/repo/RepositorySetup';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { RouterLink } from '../components/ui/Link';
import { LoadingShell } from '../components/ui/LoadingShell';
import { LoadingRegion, SkeletonLine } from '../components/ui/Skeleton';
import { ErrorPanel, ErrorNotice } from '../components/ui/States';
import { RelativeTime } from '../components/ui/Time';
import { DisclosureTrigger } from '../components/ui/Disclosure';
import '../styles/pages.css';

/** GitHub's merge queue page: the group merging now as named steps, what is queued, and the history with Revert. */
export function QueueScreen() {
  const snapshot = useSnapshot();
  const now = useNow();
  const [stackPages, setStackPages] = useState<number[]>([0]);
  const stackCursor = stackPages.at(-1)!;
  const queue = useLive(snapshot.project.id ? stackCursor ? `queue:stacks:${stackCursor}` : 'queue' : null, () => changes.queue(stackCursor), queueInterval);
  const moving = useLive(snapshot.project.id ? QUEUE_LIST_KEY : null, queueList, listInterval);
  const policy = useLive(snapshot.project.id ? 'policy' : null, changes.policy, 60_000);
  const branch = snapshot.project.branch || 'main';
  const blocker = liveBlocker(snapshot);

  useDocumentTitle(`Merge queue · ${snapshot.project.name || 'Braid'}`);

  if (!snapshot.project.id) {
    return (
      <div className="page">
        <NoRepositoryPanel />
      </div>
    );
  }
  const data = queue.data;
  if (!data && queue.error) {
    return (
      <div className="page page--readable">
        <header className="page-head"><h1 className="page-title">Merge queue</h1></header>
        <ErrorPanel title="Couldn’t load the merge queue" message={queue.error} onRetry={() => void queue.refresh()} retrying={queue.refreshing} />
      </div>
    );
  }
  if (!data) return <LoadingShell label="Loading merge queue" />;
  const items = moving.data?.items ?? [];
  const merging = items.filter((change) => change.status === 'landing');
  const queued = items.filter((change) => change.status === 'queued');
  const state = !data.enabled ? 'off' : data.paused ? 'paused' : 'on';
  // Every merge group in flight, front first; each was composed on the one ahead of it.
  const groups = data.verifying?.length ? data.verifying : data.landing ? [data.landing] : [];

  return (
    <div className="page page--readable">
      <header className="page-head">
        <div>
          <h1 className="page-title">Merge queue</h1>
          <p className="page-subline">
            <span className="branch">
              <GitBranchIcon size={15} aria-hidden="true" />
              {branch}
            </span>
            <span className="mono">{shortHash(data.head)}</span>
            <span className="queue-state" data-state={state}>
              {state === 'on' ? 'On' : state === 'paused' ? 'Paused' : 'Off'}
            </span>
          </p>
        </div>
        <QueueControl enabled={data.enabled} />
      </header>

      {queue.error ? (
        <div className="notice">
          <ErrorNotice message={queue.error} onRetry={() => void queue.refresh()} retrying={queue.refreshing} />
        </div>
      ) : null}
      {data.paused ? <Banner variant="alert" size="sm" icon={<PauseIcon weight="fill" />} description={data.paused} /> : null}

      <section className="section" aria-labelledby="now-title">
        <h2 className="section__title" id="now-title" aria-live="polite" aria-atomic="true">
          Merging now
          {merging.length ? <span className="tab-count">{merging.length}</span> : null}
        </h2>
        {groups.length ? (
          <div className="list">
            <ul className="list__rows">
              {merging.map((change) => (
                <PullRow key={change.id} change={change} now={now} />
              ))}
            </ul>
            {groups.map((batch) => (
              <MergeGroup key={batch.id} batch={batch} policy={policy.data} now={now} />
            ))}
          </div>
        ) : (
          <p className="quiet">Nothing is merging.</p>
        )}
      </section>

      <section className="section" aria-labelledby="queued-title">
        <h2 className="section__title" id="queued-title">
          Queued
          {queued.length ? <span className="tab-count">{queued.length}</span> : null}
        </h2>
        {moving.error ? <ErrorNotice message={moving.error} onRetry={() => void moving.refresh()} retrying={moving.refreshing} /> : null}
        {queued.length ? (
          <div className="list">
            <ul className="list__rows">
              {queued.map((change) => (
                <PullRow key={change.id} change={change} now={now} />
              ))}
            </ul>
          </div>
        ) : (
          <>{moving.loading ? <LoadingRegion label="Loading queue" className="loading-queue-line"><SkeletonLine width={150} /></LoadingRegion> : !moving.error ? <p className="quiet">Nothing is queued.</p> : null}</>
        )}
      </section>

      <QueueStacks stacks={data.stacks ?? []} onPrevious={stackPages.length > 1 ? () => setStackPages(pages => pages.slice(0, -1)) : undefined}
        onNext={data.nextStackCursor != null ? () => setStackPages(pages => [...pages, data.nextStackCursor!]) : undefined} />

      <section className="section" aria-labelledby="history-title">
        <h2 className="section__title" id="history-title">
          History
        </h2>
        <History queue={data} now={now} />
      </section>

      {!blocker ? <Simulation /> : null}
    </div>
  );
}

/* ---------- The group in flight, as steps ---------- */

type StepState = 'done' | 'running' | 'waiting';
const STEP_WORD: Record<StepState, string> = { done: 'Done', running: 'Running', waiting: 'Waiting' };

/** How far a merge group has come through its three steps. */
function stepsOf(status: BatchSummary['status']): [combine: StepState, checks: StepState, merge: StepState] {
  if (status === 'composing') return ['running', 'waiting', 'waiting'];
  if (status === 'verifying') return ['done', 'running', 'waiting'];
  if (status === 'pushing') return ['done', 'done', 'running'];
  return ['done', 'done', 'done'];
}

function Step({ label, state, children }: { label: string; state: StepState; children?: ReactNode }) {
  return (
    <li className="step" data-state={state}>
      <div className="step__row">
        <span className="step__name">{label}</span>
        <span className="step__state">{STEP_WORD[state]}</span>
      </div>
      {children}
    </li>
  );
}

const PR_STATE: Record<string, string> = { success: 'passed', failure: 'failed', error: 'failed', pending: 'waiting', merged: 'merged' };
/** A commit status from the repository's CI, in the words the rows above use; a required one not reported yet is waiting. */
const CI_STATE: Record<BatchCi['statuses'][string]['state'], string> = { success: 'passed', failure: 'failed', error: 'failed', pending: 'running' };

/**
 * One merge group as its steps, as a deployment shows them: combine with main, the checks it
 * waits for (the repository's commands, the statuses its CI must report, its GitHub pull request), then merge.
 */
function MergeGroup({ batch, policy, now }: { batch: NonNullable<TrunkStatus['landing']>; policy: PolicyFile | null; now: number }) {
  const [combine, checks, merge] = stepsOf(batch.status);
  const pr = batch.pullRequest;
  const ci = batch.ci;
  const commands = policy ? [...(policy.policy.install ? [policy.policy.install] : []), ...policy.policy.checks] : [];
  const contexts = ci ? [...ci.required, ...Object.keys(ci.statuses).filter((context) => !ci.required.includes(context))] : [];
  const command = batch.status === 'pushing' ? 'passed' : batch.status === 'verifying' ? 'running' : 'waiting';
  return (
    <div className="merging" data-status={batch.status}>
      <ol className="steps" aria-label="Steps">
        <Step label="Combine with main" state={combine} />
        <Step label="Checks" state={checks}>
          <ul className="waits" aria-label="Checks">
            {commands.map((item) => (
              <li key={item} className="wait" data-state={command}>
                <span className="mono wait__label">{item}</span>
                <span className="wait__state">{command}</span>
              </li>
            ))}
            {contexts.map((context) => {
              const status = ci?.statuses[context];
              const reported = status ? CI_STATE[status.state] : 'waiting';
              const detail = status?.description ?? (status?.url ? 'Details' : null);
              return (
                <li key={context} className="wait" data-state={reported}>
                  <span className="mono wait__label">{context}</span>
                  <span className="wait__state">{reported}</span>
                  {detail ? (
                    <span className="wait__detail">
                      {status?.url ? (
                        <a href={status.url} target="_blank" rel="noreferrer" className="text-link">
                          {detail}
                        </a>
                      ) : (
                        detail
                      )}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {pr ? (
              <li className="wait" data-state={PR_STATE[pr.state] ?? 'waiting'}>
                <span className="wait__label">
                  <GithubLogoIcon size={14} aria-hidden="true" />
                  <a href={pr.url} target="_blank" rel="noreferrer" className="text-link">
                    GitHub #{pr.number}
                  </a>
                  <ArrowSquareOutIcon size={12} aria-hidden="true" />
                </span>
                <span className="wait__state">{PR_STATE[pr.state] ?? pr.state}</span>
                <span className="wait__detail">{pr.reason}</span>
              </li>
            ) : null}
            {!commands.length && !contexts.length && !pr ? <li className="quiet">No checks are set up.</li> : null}
          </ul>
        </Step>
        <Step label="Merge" state={merge} />
      </ol>
      <p className="merging__line">
        Started{' '}
        <RelativeTime at={batch.startedAt} now={now} />
      </p>
    </div>
  );
}

/* ---------- History ---------- */

type Landed = BatchSummary['landed'][number];

/** Merges and removals, newest first, each with Revert in its row menu. The server's own note sits behind each. */
function History({ queue, now }: { queue: TrunkStatus; now: number }) {
  const snapshot = useSnapshot();
  const revert = useRevert();
  const [target, setTarget] = useState<Landed | null>(null);
  const reason = revertBlocker(snapshot);
  const finished = queue.recent.filter((batch) => batch.id !== queue.landing?.id && (batch.status === 'landed' || batch.status === 'failed'));
  if (!finished.length) return <p className="quiet">Nothing has merged yet.</p>;

  return (
    <>
      <ol className="history">
        {finished.map((batch) => (
          <HistoryItem key={batch.id} batch={batch} now={now} reason={reason} onRevert={setTarget} />
        ))}
      </ol>
      <ConfirmDialog
        open={!!target}
        title={`Revert #${target?.number}?`}
        description="A new pull request restores its files to the version before it merged."
        confirmLabel="Revert"
        variant="primary"
        onClose={() => setTarget(null)}
        onConfirm={async () => { if (target) await revert({ id: target.changeId, number: target.number }); }}
      />
    </>
  );
}

function HistoryItem({ batch, now, reason, onRevert }: { batch: BatchSummary; now: number; reason: string | null; onRevert: (item: Landed) => void }) {
  const when = batch.finishedAt ?? batch.startedAt;
  return (
    <li className="history__item" data-status={batch.status}>
      <div className="history__body">
        <p className="history__line">
          <span className="history__what">{batchSentence(batch)}</span>
          {batch.status === 'landed' && batch.head ? <span className="mono history__hash">{shortHash(batch.head)}</span> : null}
          <RelativeTime at={when} now={now} className="history__time" />
        </p>
        {batch.landed.length ? (
          <p className="history__numbers">
            {batch.landed.slice(0, 12).map((item) => (
              <RouterLink key={item.changeId} href={paths.pull(item.number)} className="history__num mono">
                #{item.number}
              </RouterLink>
            ))}
            {batch.landed.length > 12 ? <span className="quiet">+{batch.landed.length - 12} more</span> : null}
          </p>
        ) : null}
        {batch.status === 'failed' && !batch.ejected.length && retried(batch).length ? (
          <p className="history__numbers">
            {retried(batch).map((number) => (
              <RouterLink key={number} href={paths.pull(number)} className="history__num mono">
                #{number}
              </RouterLink>
            ))}
          </p>
        ) : null}
        {batch.ejected.map((item) => (
          <p key={item.changeId} className="history__reason">
            <RouterLink href={paths.pull(item.number)} className="history__num mono">
              #{item.number}
            </RouterLink>
            <span>{item.reason}</span>
          </p>
        ))}
        {batch.note ? (
          <Collapsible.Root>
            <DisclosureTrigger small>Details</DisclosureTrigger>
            <Collapsible.Panel className="disclosure__panel">
              <p className="history__note">{batch.note}</p>
            </Collapsible.Panel>
          </Collapsible.Root>
        ) : null}
      </div>
      {batch.landed.length ? (
        <DropdownMenu>
          <DropdownMenu.Trigger>
            <Button size="sm" variant="ghost" shape="square" icon={DotsThreeIcon} aria-label={`Options for ${batchSentence(batch).toLowerCase()}`} className="history__menu" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {batch.landed.map((item) => (
              <DropdownMenu.Item key={item.changeId} icon={ArrowUUpLeftIcon} disabled={!!reason} title={reason ?? undefined} onClick={() => onRevert(item)}>
                Revert #{item.number}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
