import { useState } from 'react';
import { Button, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo';
import { ArrowSquareOutIcon, CopyIcon, DotsThreeIcon, StopCircleIcon } from '@phosphor-icons/react';
import type { Agent, AgentFailureStage, Mission } from '../../../shared/types';
import { localAgentGuide, startCommand, updateInstructions } from '../../lib/agent-commands';
import { api } from '../../lib/api';
import { hasStarted, latestProgress, needsBaseUpdate } from '../../lib/derive';
import { relativeTime } from '../../lib/format';
import { useCopy, useNow } from '../../lib/hooks';
import { canWrite, useSnapshot, useWorkspace } from '../../store/workspace';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CopyButton } from '../ui/CopyButton';

const FAILURE_STAGE: Record<AgentFailureStage, string> = {
  authorization: 'Failed while authorizing',
  fork: 'Failed while preparing its fork',
  generation: 'Failed while making changes',
  validation: 'Failed while validating its proposal',
  publish: 'Failed while publishing its proposal',
};

/** Why an agent failed, with the step it failed at when known. */
export function AgentError({ agent }: { agent: Agent }) {
  return (
    <p className="agent-row__error">
      {agent.failureStage ? <span className="agent-row__stage">{FAILURE_STAGE[agent.failureStage]}</span> : null}
      {agent.error}
    </p>
  );
}

/** Older tasks with several lanes need the lane in the link; a single-agent task does not. */
function commandFor(mission: Mission, agent: Agent): string {
  return startCommand(mission.id, mission.agents.length > 1 ? agent.id : undefined);
}

function guideFor(mission: Mission, agent: Agent | undefined): string {
  return localAgentGuide(mission.id, agent && mission.agents.length > 1 ? agent.id : undefined);
}

/** Copies the one command an agent runs to take this task. It links to the task and holds no credentials. */
export function CopyStartCommandButton({ mission, agent }: { mission: Mission; agent: Agent }) {
  return <CopyButton text={commandFor(mission, agent)} label="Copy command" size="sm" describe={`Copy the start command for ${agent.connection?.label ?? agent.name}`} />;
}

/**
 * Copies what a connected agent needs when main moved under its task: fetch the new main into
 * the checkout it already has, integrate it, rerun the checks and submit the same task again.
 * The browser never touches that checkout, so this is the whole control.
 */
export function CopyUpdateInstructionsButton({ mission }: { mission: Mission }) {
  return (
    <CopyButton
      text={updateInstructions(mission.id)}
      label="Copy update instructions"
      title="For your agent: fetch the new main into its existing checkout, integrate it, rerun the checks and submit this task again."
    />
  );
}

/** One sentence beside the work when main moved: the task stays, and the agent brings its checkout forward. */
function UpdateNote({ mission }: { mission: Mission }) {
  const snapshot = useSnapshot();
  if (!needsBaseUpdate(mission, snapshot.project.head)) return null;
  return (
    <p className="update-note">
      {mission.status === 'review'
        ? 'Main moved after this proposal, so the connected agent needs to update its checkout and submit this task again.'
        : 'Main moved after this task started, so the connected agent needs to update its checkout before it submits.'}
    </p>
  );
}

/**
 * A single-agent local task before its result arrives. Waiting shows the command that is the
 * whole setup; started shows the connection and whatever the agent chose to report. Nothing
 * here calls a checkout "working": only a submission is evidence of work.
 */
export function TaskHandoff({ mission }: { mission: Mission }) {
  const snapshot = useSnapshot();
  const now = useNow();
  const agent = mission.agents[0];
  const writable = canWrite(snapshot);
  const open = mission.status === 'running';
  // The task banner already carries a task-wide reason, such as the owner stopping it.
  const failed = !!agent.error && agent.error !== mission.error && agent.status !== 'skipped';
  const started = hasStarted(mission) && !failed;
  const progress = latestProgress(mission);
  const state = failed ? 'failed' : started ? 'started' : 'waiting';

  return (
    <section className="task-handoff" data-state={state} aria-label={started ? 'Connected agent' : 'Start this task'}>
      {failed ? <AgentError agent={agent} /> : null}

      {started ? (
        <>
          <p className="task-handoff__state">
            {agent.status === 'forking' ? 'Starting' : 'Connected'}
            {agent.startedAt ? <span className="task-handoff__time"> {relativeTime(agent.startedAt, now)}</span> : null}
          </p>
          {progress ? (
            <p className="task-handoff__progress">
              {progress.message}
              <span className="task-handoff__time"> · {relativeTime(progress.updatedAt, now)}</span>
            </p>
          ) : null}
          <UpdateNote mission={mission} />
        </>
      ) : null}

      {open && !started ? (
        writable ? (
          <>
            <pre className="task-handoff__code" tabIndex={0}>
              <code>{commandFor(mission, agent)}</code>
            </pre>
            <div className="task-handoff__actions">
              <CopyStartCommandButton mission={mission} agent={agent} />
              <a href={guideFor(mission, agent)} target="_blank" rel="noreferrer" className="text-link">
                Guide
              </a>
            </div>
          </>
        ) : (
          <p className="quiet">Waiting for the owner's agent.</p>
        )
      ) : null}
    </section>
  );
}

/** Secondary task actions stay available without a setup banner. */
export function LocalTaskActions({ mission }: { mission: Mission }) {
  const snapshot = useSnapshot();
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const [, copy] = useCopy();
  const [stopping, setStopping] = useState(false);
  const writable = canWrite(snapshot);
  const open = mission.status === 'running' || mission.status === 'draft';
  const lane = mission.agents.find((a) => a.status === 'queued') ?? mission.agents[0];

  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger>
          <Button size="sm" variant="ghost" shape="square" icon={DotsThreeIcon} aria-label="Task options" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          {writable && open && lane ? (
            <DropdownMenu.Item
              icon={CopyIcon}
              onClick={async () => {
                const command = commandFor(mission, lane);
                if (await copy(command, lane.id)) toasts.add({ title: 'Start command copied' });
              }}
            >
              Copy start command
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item icon={ArrowSquareOutIcon} onClick={() => window.open(guideFor(mission, lane), '_blank', 'noopener,noreferrer')}>
            Agent guide
          </DropdownMenu.Item>
          {writable && open ? (
            <DropdownMenu.Item icon={StopCircleIcon} onClick={() => setStopping(true)}>
              Stop task
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu>
      <ConfirmDialog
        open={stopping}
        title="Stop this task?"
        description="The connected agent will no longer be able to submit work to this task."
        confirmLabel="Stop task"
        onClose={() => setStopping(false)}
        onConfirm={async () => {
          await api.cancelMission(mission.id);
          toasts.add({ title: 'Task stopped', description: mission.title });
          await refresh();
        }}
      />
    </>
  );
}
