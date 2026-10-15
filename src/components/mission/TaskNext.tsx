import { useState } from 'react';
import { Button, LinkButton, useKumoToastManager } from '@cloudflare/kumo';
import { GitMergeIcon } from '@phosphor-icons/react';
import type { Mission } from '../../../shared/types';
import { canUseCompletedWork, includedAgents } from '../../../shared/tasks';
import { ApiError, api, errorMessage } from '../../lib/api';
import { isLocalMission, isStale, latestProgress, mergeBlocker, missionPhase, needsBaseUpdate, type MissionFile } from '../../lib/derive';
import { joinNames, plural, possessive, relativeTime, shortHash } from '../../lib/format';
import { useIdempotencyKey, useNow } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { useIntegrationPreview, useTaskChange, type TaskChange } from '../../lib/resources';
import { paths } from '../../lib/router';
import { canWrite, readOnlyReason, useSnapshot, useWorkspace } from '../../store/workspace';
import { PullStateIcon, StatusBadge } from '../pulls/Bits';
import { RouterLink } from '../ui/Link';
import { Stats } from '../ui/Status';
import { CopyUpdateInstructionsButton, TaskHandoff } from './LocalAgentSetup';
import { StartAgain, UseCompletedWork, type MissionDraft } from './NextStep';
import { FileChoice } from './FileChoice';
import { expectOutcome, useOutcomeFocus } from './outcome';
import { RelativeTime } from '../ui/Time';
import { Reserve } from './Reserve';
import { hostedRecovery } from './hostedFailure';

/**
 * Only what the task needs next: progress while agents work, one choice per file the agents
 * disagree about, Merge into main when the result is ready, then the pull request it opened.
 */
export function TaskNext({ mission, files, head, onRestart }: { mission: Mission; files: MissionFile[]; head: string; onRestart: (draft: MissionDraft) => void }) {
  const snapshot = useSnapshot();
  const writable = canWrite(snapshot);
  const branch = snapshot.project.branch || 'main';
  const phase = missionPhase(mission, head);
  const submitted = useTaskChange(mission);
  // After a choice or a merge, what the task shows next takes the focus the button had.
  const line = useOutcomeFocus<HTMLParagraphElement>('merge');
  const blocked = useOutcomeFocus<HTMLElement>('choice');

  if (mission.status === 'running' || mission.status === 'draft') return isLocalMission(mission) && mission.agents.length === 1 ? <TaskHandoff mission={mission} /> : <Working mission={mission} />;
  if (mission.status === 'merging' && !submitted) return <p ref={line} tabIndex={-1} className="task-next__line">Merging into {branch}.</p>;
  if (mission.status === 'failed') {
    const reasons = mission.agents.flatMap(agent => agent.environment?.failure ? [hostedRecovery(agent.environment.failure)] : []);
    const setup = reasons.includes('edit_setup'), provider = reasons.includes('providers');
    return (
      <div className="task-next__actions">
        {canUseCompletedWork(mission) && writable ? <UseCompletedWork mission={mission} /> : null}
        {writable ? provider ? <LinkButton href={`${paths.settings('agents')}#providers`} variant={canUseCompletedWork(mission) ? 'secondary' : 'primary'}>Manage providers</LinkButton> : setup ? <LinkButton href={paths.settings('rules')} variant={canUseCompletedWork(mission) ? 'secondary' : 'primary'}>Edit setup commands</LinkButton> : <StartAgain mission={mission} onRestart={onRestart} variant={canUseCompletedWork(mission) ? 'secondary' : 'primary'} /> : null}
      </div>
    );
  }
  // The task opened a pull request: from here on, the pull request carries it.
  if (mission.status === 'merged' || submitted) return <TaskPull mission={mission} change={submitted} branch={branch} />;
  const open = files.filter((file) => file.disposition === 'unresolved');
  if (open.length) {
    return (
      <div className="task-next">
        {open.map((file) => (
          <FileChoice key={file.path} mission={mission} file={file} writable={writable} />
        ))}
      </div>
    );
  }
  if (phase === 'blocked') {
    return (
      <section ref={blocked} tabIndex={-1} className="question question--task">
        <h2 className="question__heading">{isStale(mission, head) ? 'Main moved after this task started' : 'This task cannot merge yet'}</h2>
        <p className="question__detail">{needsBaseUpdate(mission, head) ? 'Your agent needs to update its checkout and submit this task again.' : mergeBlocker(mission, head)}</p>
        {writable ? (
          <div className="question__answers">
            {needsBaseUpdate(mission, head) ? <CopyUpdateInstructionsButton mission={mission} /> : <StartAgain mission={mission} onRestart={onRestart} variant="primary" />}
          </div>
        ) : null}
      </section>
    );
  }
  return <ReadyToMerge mission={mission} files={files} head={head} branch={branch} writable={writable} />;
}

function Working({ mission }: { mission: Mission }) {
  const now = useNow();
  const done = mission.agents.filter((agent) => agent.status === 'review').length;
  const waiting = isLocalMission(mission) && mission.agents.every(agent => agent.status === 'queued');
  const progress = latestProgress(mission);
  return (
    <div className="task-next">
      <p className="task-next__line">
        {waiting ? 'Waiting for the assigned agents. Copy their commands below.' : done ? `${done} of ${mission.agents.length} agents finished` : mission.agents.length ? `${plural(mission.agents.length, 'agent')} working` : 'Starting agents'}
        {progress ? (
          <span className="task-next__progress">
            {' '}
            {progress.agent.name}: {progress.message} <span className="quiet">{relativeTime(progress.updatedAt, now)}</span>
          </span>
        ) : null}
      </p>
    </div>
  );
}

/** What will merge, and the one button that merges it. */
function ReadyToMerge({ mission, files, head, branch, writable }: { mission: Mission; files: MissionFile[]; head: string; branch: string; writable: boolean }) {
  const snapshot = useSnapshot();
  // TaskScreen warms this read for a task in review, the only state that shows it.
  const { preview, error, reload } = useIntegrationPreview(mission, head);
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const section = useOutcomeFocus<HTMLElement>('choice');
  const agents = includedAgents(mission);
  const shipping = files.filter((file): file is MissionFile & { shipping: NonNullable<MissionFile['shipping']> } => !!file.shipping);
  const local = isLocalMission(mission);
  const checks = agents.flatMap((agent) => agent.checks);
  const reports = checks.filter((check) => check.kind === 'report');
  const failed = checks.filter((check) => check.status === 'failed');
  const evidence = failed.length
    ? `${plural(failed.length, 'check')} failed.`
    : mission.source === 'demo'
      ? 'No checks ran in this recorded run.'
      : local
        ? reports.length
          ? 'Test results are agent-reported.'
          : 'No test results were submitted.'
        : 'Checks run in the merge queue.';
  const blocker = preview && !preview.ready ? preview.blocker : null;

  const merge = async () => {
    if (!preview) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.mergeMission(mission.id, preview.fingerprint, attempt.key([mission.id, preview.fingerprint]));
      attempt.settle();
      expectOutcome('merge');
      toasts.add({ title: result.change ? `Opened pull request #${result.change.number}` : `Merging into ${branch}`, description: mission.title });
      refreshLive('changes');
      refreshLive('queue');
      void refresh();
    } catch (err) {
      attempt.settle(err);
      if (err instanceof ApiError && err.status === 409) {
        setFailure('The result changed since you looked. It has been reloaded; check it and merge again.');
        void reload();
      } else setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={section} tabIndex={-1} className="land" aria-labelledby="land-title">
      <div className="land__row">
        <div className="land__text">
          <h2 className="land__title" id="land-title">
            Ready to merge
          </h2>
          <p className="land__line">
            {plural(shipping.length, 'file')} from {joinNames(agents.map((agent) => agent.name))}. {evidence}
          </p>
          {blocker ? <p className="land__blocker">{blocker}</p> : null}
          {failure && writable ? <p className="land__blocker" role="alert">{failure}</p> : null}
          {error && !preview ? <p className="land__blocker" role="alert">{error} <Button size="sm" variant="ghost" onClick={() => void reload()}>Try again</Button></p> : null}
        </div>
        <span title={writable ? undefined : readOnlyReason(snapshot, 'merge this task')}>
          <Button variant="primary" icon={GitMergeIcon} data-task-write disabled={busy || !writable || !preview || !preview.ready} onClick={() => void merge()}>
            Merge into {branch}
          </Button>
        </span>
      </div>
      <ul className="land__files" aria-label="Files">
        {shipping.map((file) => (
          <li key={file.path} className="land__file">
            <RouterLink href={paths.review(mission.id, { file: file.path })} className="land__path mono" data-deleted={file.shipping.change.deleted || undefined}>
              {file.path}
            </RouterLink>
            {file.disposition === 'selected' ? <span className="land__chosen">{possessive(file.shipping.agent.name)} version</span> : null}
            <Stats additions={file.shipping.change.additions} deletions={file.shipping.change.deletions} />
          </li>
        ))}
      </ul>
      <p className="land__links">
        <RouterLink href={paths.review(mission.id)} className="text-link">
          Compare code
        </RouterLink>
        <RouterLink href={paths.merge(mission.id)} className="text-link">
          Combined result
        </RouterLink>
      </p>
    </section>
  );
}

/** The pull request a task became, as one row: its state icon, title and number, where it stands, and the branch it merges into. */
function PullLine({ change, branch, title }: { change: TaskChange; branch: string; title: string }) {
  const link = useOutcomeFocus<HTMLAnchorElement>('merge');
  return (
    <RouterLink ref={link} href={paths.pull(change.number)} className="task-pull" aria-label={`Pull request #${change.number}`}>
      <PullStateIcon status={change.status} />
      <span className="task-pull__title">
        {change.title ?? title} <span className="task-pull__num">#{change.number}</span>
      </span>
      <Reserve states={[<StatusBadge change={{ ...change, status: 'queued' }} />]}>
        <StatusBadge change={change} />
      </Reserve>
      <span className="task-pull__into">
        → <span className="mono">{branch}</span>
      </span>
    </RouterLink>
  );
}

/** The pull request the task opened and, once it lands, the line that says so. The row keeps its element across that change, so focus on it stays. */
function TaskPull({ mission, change, branch }: { mission: Mission; change: TaskChange | null; branch: string }) {
  const now = useNow();
  const line = useOutcomeFocus<HTMLParagraphElement>('merge');
  const merged = mission.status === 'merged';
  return (
    <div className="task-next">
      <p key="line" ref={merged ? line : undefined} tabIndex={merged ? -1 : undefined} aria-hidden={merged ? undefined : true} className="task-next__line" style={merged ? undefined : { visibility: 'hidden' }}>
        <span>
          Merged into {branch}
          {mission.mergeCommit || !merged ? (
            <>
              {' '}
              as <span className="mono">{mission.mergeCommit ? shortHash(mission.mergeCommit) : '0000000'}</span>
            </>
          ) : null}
          {change ? null : (
            <>
              .{' '}
              <RouterLink href={paths.merge(mission.id)} className="text-link">
                Combined result
              </RouterLink>
            </>
          )}
          {mission.mergedAt || !merged ? (
            <>
              {' '}
              {mission.mergedAt ? <RelativeTime at={mission.mergedAt} now={now} className="task-next__time" /> : <span className="task-next__time">just now</span>}
            </>
          ) : null}
        </span>
      </p>
      {change ? <PullLine key="pull" change={change} branch={branch} title={mission.title} /> : null}
    </div>
  );
}
