import type { CSSProperties } from 'react';
import type { Agent, Mission } from '../../../shared/types';
import { agentStatus, isAgentBusy, isLocalMission, type MissionFile, type Phase } from '../../lib/derive';
import { basename, joinNames, possessive, shortHash } from '../../lib/format';
import { useElementWidth } from '../../lib/hooks';
import { agentByline, agentName } from './identity';
import { navigate, paths } from '../../lib/router';
import { Reserve } from './Reserve';

const R = 10;
const TRUNK_Y = 30;
const LANE_Y0 = 76;
const LANE_GAP = 44;
const EDGE = 14;

type LaneState = 'queued' | 'busy' | 'done' | 'failed' | 'merged';

function laneState(agent: Agent): LaneState {
  if (agent.status === 'failed') return 'failed';
  if (agent.status === 'merged') return 'merged';
  if (agent.status === 'queued') return 'queued';
  if (isAgentBusy(agent)) return 'busy';
  return 'done';
}

/**
 * The mission as a branch graph: every agent forks from the same commit of main,
 * files that several agents touched link their lanes, and the lanes rejoin main at
 * the merge. Lines are SVG; labels and controls are HTML so they stay readable and
 * focusable.
 */
export function Topology({
  mission,
  files,
  head,
  phase,
  selectedAgentId,
  onSelectAgent,
}: {
  mission: Mission;
  files: MissionFile[];
  head: string | undefined;
  phase: Phase;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const width = Math.max(measured, 300);
  const compact = width < 800;
  const agents = mission.agents;
  const laneY = (index: number) => LANE_Y0 + index * LANE_GAP;
  const lastY = laneY(Math.max(agents.length, 1) - 1);
  const height = lastY + 30;

  const baseX = EDGE;
  const mergeX = width - EDGE;
  const labelX = baseX + R + 10;
  const labelWidth = compact ? Math.max(120, width - 132) : 330;
  const headWidth = compact ? 78 : 150;
  const headRight = mergeX - R - 10;
  const regionStart = compact ? labelX + 22 : labelX + labelWidth + 18;
  const regionEnd = compact ? headRight - 16 : headRight - headWidth - 18;

  // Each file several agents changed, at its own x across the lanes that changed it. Versions come from the task's
  // own agents, one each, so a shared file always spans at least two lanes.
  const links = files
    .filter((file) => file.versions.length > 1)
    .map((file, index, shared) => ({
      file,
      x: regionStart + ((index + 1) * (regionEnd - regionStart)) / (shared.length + 1),
      lanes: file.versions.map((v) => agents.findIndex((a) => a.id === v.agent.id)).sort((a, b) => a - b),
    }));

  const merged = mission.status === 'merged';
  // The example's task merges onto main as it is, so main moving there is not a warning.
  const stale = !merged && mission.source !== 'demo' && !!head && head !== mission.baseCommit;
  const mergeTone = merged ? 'merged' : phase === 'ready' ? 'ready' : phase === 'merging' ? 'busy' : stale || phase === 'blocked' || phase === 'failed' ? 'blocked' : 'pending';
  const mergeLabel = merged ? `main ${shortHash(mission.mergeCommit)}` : stale ? 'main moved' : 'into main';

  return (
    <>
      <figure className="graph" ref={ref} style={{ height }} aria-label="How the agents' work comes together">
        {measured ? (
          <>
            <svg className="graph__lines" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
              <path className="graph__trunk" data-merged={merged || undefined} d={`M ${baseX} ${TRUNK_Y} H ${mergeX}`} />
              {agents.length ? <><path className="graph__spine" d={`M ${baseX} ${TRUNK_Y} V ${lastY - R}`} /><path className="graph__join" data-merged={merged || undefined} d={`M ${mergeX} ${lastY - R} V ${TRUNK_Y}`} /></> : null}
              {agents.map((agent, index) => {
                const y = laneY(index);
                return (
                  <g key={agent.id} className="graph__lane" data-state={laneState(agent)} data-selected={agent.id === selectedAgentId || undefined}>
                    <path className="graph__lane-line" d={`M ${baseX} ${y - R} Q ${baseX} ${y} ${baseX + R} ${y} H ${headRight}`} />
                    <path className="graph__lane-join" data-merged={merged || undefined} d={`M ${headRight} ${y} H ${mergeX - R} Q ${mergeX} ${y} ${mergeX} ${y - R}`} />
                  </g>
                );
              })}
              {links.map(({ file, x, lanes }) => {
                const crossings = agents.map((_, i) => i).filter((i) => i > lanes[0] && i < lanes[lanes.length - 1] && !lanes.includes(i));
                const stops = [laneY(lanes[0]), ...crossings.flatMap((i) => [laneY(i) - 5, laneY(i) + 5]), laneY(lanes[lanes.length - 1])];
                const segments: string[] = [];
                for (let s = 0; s < stops.length; s += 2) segments.push(`M ${x} ${stops[s]} V ${stops[s + 1]}`);
                return (
                  <g key={file.path} className="graph__link" data-disposition={file.disposition}>
                    <path d={segments.join(' ')} />
                    {lanes.map((i) => (
                      <circle key={i} cx={x} cy={laneY(i)} r={2.75} />
                    ))}
                  </g>
                );
              })}
            </svg>

            <div className="graph__labels">
              <span className="graph__ref graph__ref--base" style={{ left: baseX, top: TRUNK_Y }}>
                <span className="graph__node" aria-hidden="true" />
                <span className="graph__ref-text">
                  from main <span className="mono">{shortHash(mission.baseCommit)}</span>
                </span>
              </span>

              <MergeNode x={mergeX} tone={mergeTone} label={mergeLabel} missionId={mission.id} reachable={mission.status === 'review' || merged} />

              {agents.map((agent, index) => (
                <button
                  key={agent.id}
                  type="button"
                  className="graph__lane-label"
                  style={{ left: labelX, top: laneY(index), maxWidth: labelWidth }}
                  aria-pressed={agent.id === selectedAgentId}
                  aria-label={agentByline(agent)}
                  title={agentByline(agent)}
                  onClick={() => onSelectAgent(agent.id)}
                >
                  <span className="graph__lane-name">{compact ? agentName(agent) : agentByline(agent)}</span>
                  {!compact && !isLocalMission(mission) ? <span className="graph__lane-role">{agent.role}</span> : null}
                </button>
              ))}

              {agents.map((agent, index) => (
                <LaneHead key={agent.id} agent={agent} mission={mission} style={{ left: headRight, top: laneY(index), maxWidth: headWidth }} />
              ))}

              {links.map(({ file, x, lanes }) => (
                <SharedMarker key={file.path} file={file} missionId={mission.id} compact={compact} style={{ left: x, top: laneY(lanes[0]) + LANE_GAP / 2 }} />
              ))}
            </div>
          </>
        ) : null}
      </figure>
      {compact && links.length ? <ul className="graph-files" aria-label="Shared files">
        {links.map(({ file }) => <li key={file.path}><SharedMarker file={file} missionId={mission.id} compact={false} /></li>)}
      </ul> : null}
    </>
  );
}

function LaneHead({ agent, mission, style }: { agent: Agent; mission: Mission; style: CSSProperties }) {
  const state = laneState(agent);
  const status = agentStatus(mission, agent);
  const hash = agent.commit && state !== 'failed' ? shortHash(agent.commit) : null;
  return (
    <span className="graph__head" data-state={state} style={style}>
      {hash ? <span className="mono graph__head-hash">{hash}</span> : <span>{status.label}</span>}
      <span className="sr-only">{`${agent.name}: ${status.label}`}</span>
    </span>
  );
}

function SharedMarker({ file, missionId, compact, style }: { file: MissionFile; missionId: string; compact: boolean; style?: CSSProperties }) {
  const names = joinNames(file.versions.map((v) => v.agent.name));
  const winner = file.shipping?.agent.name ?? '';
  const note = file.disposition === 'unresolved' ? `${file.versions.length} versions` : file.disposition === 'selected' ? possessive(winner) : 'same';
  const description =
    file.disposition === 'unresolved'
      ? `Choose between the versions of ${file.path} written by ${names}.`
      : file.disposition === 'selected'
        ? `${file.path}: ${possessive(winner)} version chosen.`
        : `${file.path}: identical from ${names}, included once.`;
  const glyph = <span className="graph__marker-glyph" aria-hidden="true">{file.disposition === 'agreement' ? '=' : null}</span>;
  if (compact) return <span className="graph__marker" data-disposition={file.disposition} style={style} aria-hidden="true">{glyph}</span>;
  return (
    <button
      type="button"
      className="graph__marker"
      data-disposition={file.disposition}
      style={style}
      onClick={() => navigate(paths.review(missionId, { file: file.path }))}
      aria-label={description}
      title={description}
    >
      {glyph}
      <span className="graph__marker-text">
        <span className="mono">{basename(file.path)}</span>
        <Reserve className="graph__marker-note" states={file.versions.length > 1 && file.disposition !== 'agreement' ? file.versions.map(({ agent }) => possessive(agent.name)) : []}>
          {note}
        </Reserve>
      </span>
    </button>
  );
}

function MergeNode({ x, tone, label, missionId, reachable }: { x: number; tone: string; label: string; missionId: string; reachable: boolean }) {
  const content = (
    <>
      <span className="graph__ref-text">{label}</span>
      <span className="graph__node" aria-hidden="true" />
    </>
  );
  const style = { left: x, top: TRUNK_Y };
  if (!reachable) {
    return (
      <span className="graph__ref graph__ref--merge" data-tone={tone} style={style}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" className="graph__ref graph__ref--merge" data-tone={tone} style={style} onClick={() => navigate(paths.merge(missionId))} aria-label={`Merge: ${label}`}>
      {content}
    </button>
  );
}
