import type { Agent, Mission } from '../../../shared/types';

/** A finished run shorter than this was replayed from a recording, not timed. */
const TIMED = 1000;

/** Execution time, excluding the wait for review and merge. Missing timestamps stay unknown. */
export function agentDuration(agent: Agent, now: number): number | null {
  if (!agent.startedAt) return null;
  const end = agent.completedAt ? Date.parse(agent.completedAt) : ['forking', 'working'].includes(agent.status) ? now : null;
  if (end === null) return null;
  const duration = Math.max(0, end - Date.parse(agent.startedAt));
  return agent.completedAt && duration < TIMED ? null : duration;
}

/** Parallel agents overlap in wall time; their individual durations must not be added. */
export function taskDuration(mission: Mission, now: number): number | null {
  const started = mission.agents.flatMap(agent => agent.startedAt ? [Date.parse(agent.startedAt)] : []);
  if (!started.length) return null;
  const finished = mission.agents.flatMap(agent => agent.completedAt ? [Date.parse(agent.completedAt)] : []);
  const end = mission.status === 'running' ? now : finished.length ? Math.max(...finished) : null;
  if (end === null) return null;
  const duration = Math.max(0, end - Math.min(...started));
  return mission.status !== 'running' && duration < TIMED ? null : duration;
}

/** Elapsed time to the second, as a run or an import shows it: "2m 10s", "1d 1h". A clock ahead of the server reads as 0s. */
export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
