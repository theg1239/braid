import type { Agent, AgentCheck, Collision, FileChange, Mission } from '../../shared/types';
import { textDiffStats } from '../../shared/diff';
import { includedAgents, changeIdentity } from '../../shared/tasks';
import { fileEdit, type GitFileEdit } from '../../shared/changes';
import { HttpError } from '../errors';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(path) && !/[\uD800-\uDFFF]/u.test(path) && path.split('/').every(part => part && part !== '..' && part !== '.' && !['.git', '.braid'].includes(part.toLowerCase()))
    && !/(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?)(?:$|\/)/i.test(path);
}
export function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, ...textDiffStats(before, after) };
}
export function detectCollisions(agents: Agent[]): Collision[] {
  const paths = new Map<string, { agentId: string; after: string }[]>();
  for (const agent of agents.filter(a => a.status !== 'skipped')) for (const file of agent.changes) {
    const owners = paths.get(file.path) ?? [];
    owners.push({ agentId: agent.id, after: changeIdentity(file) }); paths.set(file.path, owners);
  }
  return [...paths].filter(([, owners]) => new Set(owners.map(o => o.after)).size > 1)
    .map(([path, owners]) => ({ id: `collision-${path}`, path, agentIds: owners.map(o => o.agentId) }));
}
export function mergeBlocker(mission: Mission, head: string): string | null {
  if (mission.status !== 'review') return 'All agents must finish before this task can merge.';
  if (mission.baseCommit !== head) return 'The main branch changed. Start a new task from the latest commit.';
  const agents = includedAgents(mission);
  if (!agents.length || agents.some(a => a.status !== 'review')) return 'Every included agent must have a completed proposal.';
  if (agents.some(a => a.checks.some(c => c.status === 'failed'))) return 'Resolve failed checks before merging.';
  if (mission.collisions.some(c => !c.resolution || !c.agentIds.includes(c.resolution.agentId)))
    return 'Choose a version for every overlapping file before merging.';
  return null;
}
export function composeChanges(mission: Mission): Record<string, GitFileEdit> {
  const output: Record<string, GitFileEdit> = Object.create(null);
  for (const agent of includedAgents(mission)) for (const file of agent.changes) {
    const collision = mission.collisions.find(c => c.path === file.path);
    if (collision && !collision.resolution) throw new HttpError(409, `Resolve ${file.path} before merging.`);
    if (!collision || collision.resolution?.agentId === agent.id) output[file.path] = fileEdit(file);
  }
  return output;
}
export function proposalChecks(proposal: { files: { path: string }[] }, scope: string[]): AgentCheck[] {
  const outside = proposal.files.filter(f => !scope.some(s => s === '*' || (s.endsWith('/') ? f.path.startsWith(s) : f.path === s)));
  return [
    { label: 'Patch structure', status: 'passed', detail: `${proposal.files.length} valid text files; no protected paths.` },
    { label: 'Declared scope', status: outside.length ? 'warning' : 'passed', detail: outside.length ? `Review additional files: ${outside.map(f => f.path).join(', ')}` : 'All changes stay within the declared scope.' },
  ];
}
