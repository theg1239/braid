import type { HostedFailure, ProvenanceOwner } from './types';

/** Observations, not inferred steps. Hosted failures may attach redacted diagnostic evidence. */
interface AgentActivityFailure {
  code: string;
  summary: string;
  retryable: boolean;
  /** At most the last 40 redacted lines. Local activity never accepts output. */
  lines: string[];
  evidence?: HostedFailure['evidence'];
  action?: HostedFailure['action'];
}
export interface AgentActivityEvent {
  id: string;
  sequence: number;
  at: string;
  source: 'process' | 'claude-hook' | 'codex-notify' | 'git' | 'hosted';
  kind: 'started' | 'working' | 'editing' | 'command' | 'waiting' | 'finished' | 'failed' | 'commit';
  /** Trusted hosted progress; local ingestion never accepts arbitrary prose. */
  message?: string;
  path?: string;
  command?: string;
  exitCode?: number;
  /** Tool completion without a reported numeric exit code must stay explicit. */
  completed?: boolean;
  commit?: string;
  failure?: AgentActivityFailure;
}
export type LocalActivityEvent = Omit<AgentActivityEvent, 'source' | 'failure' | 'message'> & { source: Exclude<AgentActivityEvent['source'], 'hosted'> };
export interface LocalActivityBatch {
  session: string;
  model?: string;
  tool?: string;
  changeId?: string;
  events: LocalActivityEvent[];
  /** A process heartbeat, not an invented activity event. */
  active?: boolean;
}
export interface LocalActivityRun {
  id: string;
  session: string;
  agent: { name: string; model?: string; tool?: string; owner: ProvenanceOwner };
  changeId?: string;
  changeNumber?: number;
  startedAt: string;
  lastSeenAt: string;
  events: LocalActivityEvent[];
}
export interface LocalActivityPage { items: LocalActivityRun[] }

export function activityText(event: AgentActivityEvent): string {
  if (event.source === 'hosted' && event.message) return event.message;
  switch (event.kind) {
    case 'started': return 'started';
    case 'working': return 'working';
    case 'editing': return event.path ? `editing ${event.path}` : 'editing';
    case 'command': return `${event.exitCode === undefined && !event.completed ? 'running' : 'ran'} ${event.command ?? 'a command'}${event.exitCode === undefined ? event.completed ? ', exit status not reported' : '' : event.exitCode === 0 ? ', passed' : `, failed (exit ${event.exitCode})`}`;
    case 'waiting': return 'waiting for you';
    case 'finished': return 'finished';
    case 'failed': return event.failure?.summary ?? `${event.command ? `ran ${event.command}, ` : ''}failed${event.exitCode === undefined ? '' : ` (exit ${event.exitCode})`}`;
    case 'commit': return `committed ${event.commit?.slice(0, 7) ?? ''}`.trim();
  }
}

/** A late async hook cannot reopen a process that has exited. */
export function currentActivity(run: LocalActivityRun): LocalActivityEvent | undefined {
  return run.events.findLast(event => event.source === 'process' && ['finished', 'failed'].includes(event.kind)) ?? run.events.at(-1);
}
export const activityRunning = (run: LocalActivityRun) => !run.events.some(event => event.source === 'process' && ['finished', 'failed'].includes(event.kind));
