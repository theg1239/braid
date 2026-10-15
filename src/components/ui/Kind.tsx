import { LightbulbIcon, ScalesIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import type { ContextItem } from '../../../shared/types';

export const KIND_LABEL: Record<ContextItem['kind'], string> = {
  constraint: 'Constraint',
  decision: 'Decision',
  learning: 'Learning',
};

/** Constraints are rules, learnings are findings, decisions are your recorded choices. */
export function KindIcon({ kind, size = 15 }: { kind: ContextItem['kind']; size?: number }) {
  const Icon = kind === 'constraint' ? ShieldCheckIcon : kind === 'decision' ? ScalesIcon : LightbulbIcon;
  return <Icon size={size} className="kind-icon" data-kind={kind} aria-hidden="true" />;
}
