import { useEffect, useRef, useState } from 'react';
import { InlineCopyText } from '@cloudflare/kumo';
import { CaretRightIcon } from '@phosphor-icons/react';
import type { Agent, AgentCheck, Mission } from '../../../shared/types';
import { agentStatus, isAgentBusy, isLocalMission, versionOutcome, type MissionFile, type VersionOutcome } from '../../lib/derive';
import { basename, dirname, possessive, shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { agentByline, agentName } from './identity';
import { agentDuration, durationLabel } from './timing';
import { paths } from '../../lib/router';
import { canWrite, useSnapshot } from '../../store/workspace';
import { RouterLink } from '../ui/Link';
import { AgentStatusBadge, Stats } from '../ui/Status';
import { AgentError, CopyStartCommandButton } from './LocalAgentSetup';
import { Reserve } from './Reserve';

const OUTCOME: Record<VersionOutcome, string> = {
  pending: 'Choose between this version and another agent’s proposal.',
  chosen: 'This version was chosen.',
  'not-chosen': 'Another agent’s version was chosen.',
  shared: 'Identical proposals from multiple agents are included once.',
  solo: 'Only this agent changed the file.',
};

/** One row per agent: who, what it focused on, what it changed, its commit, and its state. A row opens on what it wrote and reported. */
export function AgentCards({ mission, files, selectedId }: { mission: Mission; files: MissionFile[]; selectedId: string | null }) {
  const now = useNow();
  const writable = canWrite(useSnapshot());
  if (!mission.agents.length) return <p className="quiet">{mission.status === 'failed' ? 'No agents started.' : 'Starting agents'}</p>;
  return (
    <ul className="agent-rows" aria-label="Agents">
      {mission.agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} mission={mission} files={files} selected={agent.id === selectedId} now={now} writable={writable} />
      ))}
    </ul>
  );
}

function AgentRow({ agent, mission, files, selected, now, writable }: { agent: Agent; mission: Mission; files: MissionFile[]; selected: boolean; now: number; writable: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const duration = agentDuration(agent, now);
  const [open, setOpen] = useState(selected);
  const local = isLocalMission(mission);
  const busy = isAgentBusy(agent);
  const hasProposal = agent.status === 'review' || agent.status === 'merged';
  // The files this agent changed, each with its version.
  const mine = files.flatMap((file) => {
    const version = file.versions.find((v) => v.agent.id === agent.id);
    return version ? [{ file, change: version.change }] : [];
  });
  const additions = agent.changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = agent.changes.reduce((sum, change) => sum + change.deletions, 0);
  const status = agentStatus(mission, agent);

  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  return (
    <li ref={ref} className="agent-row" data-selected={selected || undefined} data-status={agent.status} data-open={open || undefined}>
      <div className="agent-row__line">
        <button type="button" className="agent-row__toggle" aria-expanded={open} aria-controls={`agent-${agent.id}`} onClick={() => setOpen((value) => !value)}>
          <CaretRightIcon size={12} weight="bold" className="agent-row__caret" aria-hidden="true" />
          <span className="agent-row__name">{agentByline(agent)}</span>
          {agent.connection || !local ? <span className="agent-row__role">{agent.connection?.label ?? agent.role}</span> : null}
        </button>
        {agent.changes.length ? <Stats additions={additions} deletions={deletions} className="agent-row__stats" /> : null}
        {agent.commit ? (
          <InlineCopyText value={agent.commit} labels={{ copyAction: `Copy commit hash ${shortHash(agent.commit)}`, copied: `Copied commit hash ${shortHash(agent.commit)}` }}>
            <span className="mono agent-row__hash">{shortHash(agent.commit)}</span>
          </InlineCopyText>
        ) : local && busy && writable ? (
          <CopyStartCommandButton mission={mission} agent={agent} />
        ) : null}
        {duration !== null ? <span className="agent-row__duration" title="Agent run time">{durationLabel(duration)}</span> : null}
        <Reserve className="agent-row__status" states={[<AgentStatusBadge label="Merged" tone="purple" />]}>
          <AgentStatusBadge {...status} />
        </Reserve>
      </div>
      {open ? (
        <div className="agent-row__body" id={`agent-${agent.id}`}>
          {agent.error && agent.status !== 'skipped' ? <AgentError agent={agent} /> : null}
          {hasProposal && agent.summary ? <p className="agent-row__summary">{agent.summary}</p> : null}
          {mine.length ? (
            <ul className="agent-row__files" aria-label={`${possessive(agent.name)} files`}>
              {mine.map(({ file, change }) => {
                const outcome = versionOutcome(file, agent.id);
                return (
                  <li key={file.path}>
                    <RouterLink href={paths.review(mission.id, { file: file.path })} className="agent-file" data-outcome={outcome} title={OUTCOME[outcome]}>
                      <span className="agent-file__path">
                        <span className="agent-file__dir">{dirname(file.path)}</span>
                        {basename(file.path)}
                      </span>
                      <Stats additions={change.additions} deletions={change.deletions} className="agent-file__stats" />
                      <span className="sr-only">{OUTCOME[outcome]}</span>
                    </RouterLink>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <dl className="agent-row__detail">
            {agent.connection ? <><dt>Connection</dt><dd>{agent.connection.label}</dd></> : null}
            {agent.change ? <><dt>Pull request</dt><dd><RouterLink href={paths.pull(agent.change.number)} className="text-link">#{agent.change.number}</RouterLink></dd></> : null}
            <dt>Brief</dt>
            <dd>{agent.task}</dd>
            {agent.rationale ? <><dt>Reasoning</dt><dd>{agent.rationale}</dd></> : null}
            {agent.checks.length ? <><dt>Checks</dt><dd><CheckList checks={agent.checks} mission={mission} /></dd></> : null}
            {agent.scope.length ? <><dt>Paths</dt><dd className="mono">{agent.scope.join('  ')}</dd></> : null}
            {agent.remote ? <><dt>Remote</dt><dd><InlineCopyText truncate labels={{ copyAction: 'Copy remote URL', copied: 'Copied' }}>{agent.remote}</InlineCopyText></dd></> : null}
            {agent.repo ? <><dt>Fork</dt><dd className="mono">{agentName(agent)}</dd></> : null}
            {agent.model ? <><dt>{local ? 'Reported model' : 'Model'}</dt><dd className="mono">{agent.model}</dd></> : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Only a check Braid ran itself renders as a green pass. Recorded demo checks executed
 * nothing, and a local agent's test reports arrive as warnings because the agent, not
 * Braid, ran them. A reported failure still blocks the merge.
 */
export function CheckList({ checks, mission }: { checks: AgentCheck[]; mission: Pick<Mission, 'source' | 'execution'> }) {
  const demo = mission.source === 'demo', local = isLocalMission(mission);
  return (
    <ul className="check-list">
      {checks.map((check) => {
        const notRun = check.kind === 'runtime';
        const reported = local && check.status === 'warning';
        const state = check.status === 'failed' ? 'fail' : check.status === 'warning' || demo ? 'note' : 'pass';
        const value = check.status === 'failed' ? 'Failed' : notRun ? 'Not run' : reported ? 'Agent-reported' : check.status === 'warning' ? 'Review' : demo ? 'Sample' : 'Passed';
        const title = reported ? `${check.detail} Reported by the local agent; Braid did not run it.`.trim() : check.detail;
        return (
          <li key={check.label} className="check-row" data-state={state} title={title}>
            <span className="check-row__label">{check.label}</span>
            <span className="check-row__value">{value}</span>
          </li>
        );
      })}
    </ul>
  );
}
