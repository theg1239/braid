import { Badge } from '@cloudflare/kumo';
import type { Agent, Mission } from '../../../shared/types';
import { phaseLabel, type BadgeTone } from '../../lib/derive';

/** Kumo's badge variant for each tone the app uses. */
export const BADGE: Record<BadgeTone, 'secondary' | 'info' | 'warning' | 'success' | 'error' | 'purple'> = {
  neutral: 'secondary',
  info: 'info',
  warning: 'warning',
  success: 'success',
  error: 'error',
  purple: 'purple',
};

/** The task's one-word state, in the vocabulary the task page uses. */
export function PhaseBadge({ mission, head }: { mission: Mission; head: string | undefined }) {
  const { label, tone } = phaseLabel(mission, head);
  return (
    <Badge variant={BADGE[tone]} className="phase-badge">
      {label}
    </Badge>
  );
}

/** Quiet text for an agent's current state. */
export function AgentStatusBadge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span className="agent-status" data-tone={tone}>
      {label}
    </span>
  );
}

/** An agent by its model, with its lane's focus when asked. */
export function AgentName({ agent, role = false }: { agent: Pick<Agent, 'name' | 'role'>; role?: boolean }) {
  return (
    <span className="agent-name">
      <span className="agent-name__text">{agent.name}</span>
      {role ? <span className="agent-name__role">{agent.role}</span> : null}
    </span>
  );
}

export function Stats({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={['stats', className].filter(Boolean).join(' ')}>
      <span className="stats__add">
        +{additions}
        <span className="sr-only"> added</span>
      </span>
      <span className="stats__del">
        −{deletions}
        <span className="sr-only"> removed</span>
      </span>
    </span>
  );
}
