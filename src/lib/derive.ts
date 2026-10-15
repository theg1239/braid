import type { Activity, Agent, AgentStatus, ChangeStatus, Collision, FileChange, IntegrationFile, Mission, WorkspaceSnapshot } from '../../shared/types';
import { canUseCompletedWork, changeIdentity, includedAgents } from '../../shared/tasks';
import { statusLabel } from './changes';
import { basename } from './format';
import { isStopped } from './task-state';

/**
 * The change a task's result became when the repository lands through the queue. From then on
 * the change carries the task: it is what lands, what asks the person and what the lists show.
 */
export function taskChange(mission: Mission): NonNullable<Agent['change']> | undefined {
  return includedAgents(mission).find((agent) => agent.change)?.change;
}

/** In review, but main has moved since it started, so it can never merge. The example's task merges onto main as it is, as the example lands it. */
export function isStale(mission: Mission, head: string | undefined): boolean {
  return mission.status === 'review' && mission.source !== 'demo' && !!head && mission.baseCommit !== head;
}

export function isResolved(collision: Collision): boolean {
  return !!collision.resolution && collision.agentIds.includes(collision.resolution.agentId);
}

export function agentById(mission: Mission, id: string | undefined | null): Agent | undefined {
  if (!id) return undefined;
  return mission.agents.find((a) => a.id === id);
}

export function isAgentBusy(agent: Agent): boolean {
  return agent.status === 'queued' || agent.status === 'forking' || agent.status === 'working';
}

export function isLocalMission(mission: Pick<Mission, 'execution'>): boolean {
  return mission.execution === 'local';
}

/** A local agent has taken the task: it checked out, or it is already submitting. */
export function hasStarted(mission: Mission): boolean {
  return mission.agents.some((agent) => agent.status === 'forking' || agent.status === 'working');
}

/** The newest progress line any agent of this task sent, if one did. */
export function latestProgress(mission: Mission): { agent: Agent; message: string; updatedAt: string } | null {
  let latest: { agent: Agent; message: string; updatedAt: string } | null = null;
  for (const agent of mission.agents) {
    if (agent.progress && (!latest || Date.parse(agent.progress.updatedAt) > Date.parse(latest.updatedAt))) latest = { agent, ...agent.progress };
  }
  return latest;
}

/**
 * Main moved under a single-agent local task that is still open. The connected agent fetches
 * the new main into its own checkout and submits the same task again; the server never sees
 * the local files, so this is a handoff to the agent rather than an action here. Tasks with
 * several lanes, hosted tasks and tasks nobody has started keep starting over instead.
 */
export function needsBaseUpdate(mission: Mission, head: string | undefined): boolean {
  if (!head || mission.baseCommit === head || mission.source !== 'live' || !isLocalMission(mission) || mission.agents.length !== 1) return false;
  return mission.status === 'review' || (mission.status === 'running' && hasStarted(mission));
}

/* ---------- Files ---------- */

type Disposition = IntegrationFile['disposition'];

export interface MissionFile {
  path: string;
  /** One entry per agent that changed the path, in lane order. */
  versions: { agent: Agent; change: FileChange }[];
  disposition: Disposition;
  collision: Collision | null;
  /** The version that ships. Null while different versions are undecided. */
  shipping: { agent: Agent; change: FileChange } | null;
}

/**
 * Mirrors worker/workspace/integration.ts: different content needs a choice, identical
 * content from several agents ships once. Versions are compared by their recorded
 * identity, never by text, because proposal text is not in the snapshot.
 */
export function missionFiles(mission: Mission): MissionFile[] {
  const map = new Map<string, { agent: Agent; change: FileChange }[]>();
  for (const agent of includedAgents(mission)) {
    for (const change of agent.changes) {
      const list = map.get(change.path) ?? [];
      list.push({ agent, change });
      map.set(change.path, list);
    }
  }
  const files = [...map.entries()].map(([path, versions]): MissionFile => {
    const collision = mission.collisions.find((c) => c.path === path) ?? null;
    const differs = new Set(versions.map((v) => changeIdentity(v.change))).size > 1;
    if (!differs) {
      return { path, versions, collision, disposition: versions.length > 1 ? 'agreement' : 'independent', shipping: versions[0] };
    }
    const winner = collision && isResolved(collision) ? versions.find((v) => v.agent.id === collision.resolution?.agentId) ?? null : null;
    return { path, versions, collision, disposition: winner ? 'selected' : 'unresolved', shipping: winner };
  });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const FILE_GROUPS: { disposition: Disposition; label: string }[] = [
  { disposition: 'unresolved', label: 'To choose' },
  { disposition: 'selected', label: 'Chosen' },
  { disposition: 'agreement', label: 'Identical' },
  { disposition: 'independent', label: 'One agent' },
];

/** Files in review order: what needs the person first, then the rest by path. */
export function groupFiles(files: MissionFile[]) {
  return FILE_GROUPS.map((group) => ({ ...group, files: files.filter((f) => f.disposition === group.disposition) })).filter((group) => group.files.length);
}

/** How one agent's version of a file fared. */
export type VersionOutcome = 'pending' | 'chosen' | 'not-chosen' | 'shared' | 'solo';

export function versionOutcome(file: MissionFile, agentId: string): VersionOutcome {
  if (file.disposition === 'independent') return 'solo';
  if (file.disposition === 'agreement') return 'shared';
  if (file.disposition === 'unresolved') return 'pending';
  const mine = file.versions.find((v) => v.agent.id === agentId);
  return mine && file.shipping && changeIdentity(mine.change) === changeIdentity(file.shipping.change) ? 'chosen' : 'not-chosen';
}

/** What a task changed so far: its distinct files, counting the version that ships or, while undecided, the first. */
export function taskStats(mission: Mission): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  const files = missionFiles(mission);
  for (const file of files) {
    const { change } = file.shipping ?? file.versions[0];
    additions += change.additions;
    deletions += change.deletions;
  }
  return { files: files.length, additions, deletions };
}

/* ---------- Status ---------- */

export type Phase = 'planning' | 'working' | 'decide' | 'blocked' | 'ready' | 'submitted' | 'merging' | 'merged' | 'failed';
export type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'error' | 'purple';

const PHASE: Record<Phase, { label: string; tone: BadgeTone }> = {
  planning: { label: 'Planning', tone: 'neutral' },
  working: { label: 'Working', tone: 'info' },
  decide: { label: 'Needs your choice', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'error' },
  ready: { label: 'Ready to merge', tone: 'success' },
  submitted: { label: 'Pull request open', tone: 'info' },
  merging: { label: 'Merging', tone: 'info' },
  merged: { label: 'Merged', tone: 'purple' },
  failed: { label: 'Failed', tone: 'error' },
};

const AGENT_STATUS: Record<AgentStatus, { label: string; tone: BadgeTone }> = {
  skipped: { label: 'Closed', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'neutral' },
  forking: { label: 'Forking', tone: 'info' },
  working: { label: 'Working', tone: 'info' },
  review: { label: 'Done', tone: 'success' },
  merged: { label: 'Merged', tone: 'purple' },
  failed: { label: 'Failed', tone: 'error' },
};

/**
 * The same states when the agent is someone's own, on their machine. A checkout proves a
 * connection, not activity, so nothing here says "working" before a result arrives.
 */
const LOCAL_AGENT_STATUS: Record<AgentStatus, { label: string; tone: BadgeTone }> = {
  skipped: { label: 'Closed', tone: 'neutral' },
  queued: { label: 'Waiting', tone: 'neutral' },
  forking: { label: 'Starting', tone: 'info' },
  working: { label: 'Started', tone: 'info' },
  review: { label: 'Submitted', tone: 'success' },
  merged: { label: 'Merged', tone: 'purple' },
  failed: { label: 'Failed', tone: 'error' },
};

export function agentStatus(mission: Pick<Mission, 'execution'>, agent: Pick<Agent, 'status'>): { label: string; tone: BadgeTone } {
  return (isLocalMission(mission) ? LOCAL_AGENT_STATUS : AGENT_STATUS)[agent.status];
}

/**
 * What a task's badge says. The phase decides the tone; local tasks that are waiting for or
 * started by a connected agent, stale tasks and stopped tasks get the plainer word. A task
 * whose result is a change says where that change is, in the change's own words.
 */
export function phaseLabel(mission: Mission, head: string | undefined, changeStatus: ChangeStatus | undefined = taskChange(mission)?.status): { label: string; tone: BadgeTone } {
  const phase = missionPhase(mission, head);
  if (phase === 'submitted') return statusLabel({ status: changeStatus ?? 'queued' });
  if (phase === 'working' && isLocalMission(mission)) return hasStarted(mission) || mission.agents.some((a) => a.status === 'review') ? { label: 'Started', tone: 'info' } : { label: 'Waiting', tone: 'neutral' };
  if (phase === 'blocked' && isStale(mission, head)) return { label: 'Needs update', tone: 'warning' };
  if (phase === 'failed' && isStopped(mission)) return { label: 'Stopped', tone: 'neutral' };
  return PHASE[phase];
}

export function missionPhase(mission: Mission, head: string | undefined): Phase {
  switch (mission.status) {
    case 'draft':
      return 'planning';
    case 'running':
      return mission.agents.length ? 'working' : 'planning';
    case 'merging':
      return 'merging';
    case 'merged':
      return 'merged';
    case 'failed':
      return 'failed';
    case 'review':
      // Once the result is a change, the change decides; the task no longer asks the person.
      if (taskChange(mission)) return 'submitted';
      if (mission.collisions.some((c) => !isResolved(c))) return 'decide';
      return mergeBlocker(mission, head) ? 'blocked' : 'ready';
  }
}

/**
 * Mirrors the server's merge rules so the UI can say what is in the way.
 * The server stays the authority.
 */
export function mergeBlocker(mission: Mission, head: string | undefined): string | null {
  if (mission.status === 'merged') return 'Already merged.';
  if (mission.status === 'merging') return 'Merging now.';
  if (mission.status === 'failed') return 'This task failed.';
  if (mission.status !== 'review') return 'Agents are still working.';
  const submitted = taskChange(mission);
  if (submitted) return `Pull request #${submitted.number} carries this task.`;
  if (isStale(mission, head)) return 'Main moved after this task started.';
  const agents = includedAgents(mission);
  if (!agents.length || agents.some((a) => a.status !== 'review')) return 'Every included agent needs a finished proposal.';
  if (agents.some((a) => a.checks.some((c) => c.status === 'failed'))) return 'An agent check failed.';
  const open = mission.collisions.filter((c) => !isResolved(c));
  if (open.length === 1) return `Choose a version of ${basename(open[0].path)} first.`;
  if (open.length > 1) return `Choose versions for ${open.length} files first.`;
  return null;
}

export type GateState = 'pass' | 'fail' | 'todo' | 'note' | 'wait';

/** Task phases where the next move is the person's. */
export function taskNeedsYou(mission: Mission, head: string): boolean {
  const phase = missionPhase(mission, head);
  return phase === 'decide' || phase === 'ready' || phase === 'blocked' || (phase === 'failed' && canUseCompletedWork(mission));
}

/* ---------- Collections ---------- */

export function missionActivity(snapshot: WorkspaceSnapshot, missionId: string): Activity[] {
  return snapshot.activity.filter((a) => a.missionId === missionId).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function mergedTime(mission: Mission): number {
  return Date.parse(mission.mergedAt ?? mission.createdAt);
}

/** Merged tasks, newest first. Each one is a commit Braid made on main. */
export function mergedMissions(missions: Mission[]): Mission[] {
  return missions.filter((m) => m.status === 'merged').sort((a, b) => mergedTime(b) - mergedTime(a));
}

export function sortByNewest<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
