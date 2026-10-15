import { redactEmails } from '../../shared/privacy';
import type { AgentCheck, ChangeAuthor, ContextItem, IntegrationFile, IntegrationPreview, Mission } from '../../shared/types';
import { digest } from '../http/auth';
import { mergeBlocker } from './domain';
import { includedAgents, changeIdentity } from '../../shared/tasks';
import { plural } from '../../shared/labels';

const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const code = (value: string) => `\`${value.replaceAll('`', '\\`')}\``;
/** A version in the handoff: its agent, and its commit when it has one. */
const version = (v: IntegrationFile['versions'][number]) => `${v.agentName}${v.commit ? ` (${code(v.commit)})` : ''}`;

/** Attribute identical proposals to a chosen agent who proposed them, otherwise to the first proposer. */
export function integrationAuthors(mission: Mission, authors: Record<string, ChangeAuthor>): Record<string, ChangeAuthor> {
  const agents = includedAgents(mission);
  const chosen = mission.collisions.flatMap(collision => collision.resolution ? [collision.resolution.agentId] : []);
  return Object.fromEntries([...new Set(agents.flatMap(agent => agent.changes.map(file => file.path)))].flatMap(path => {
    const proposers = agents.filter(agent => agent.changes.some(file => file.path === path));
    const resolution = mission.collisions.find(collision => collision.path === path)?.resolution;
    const selected = resolution ? proposers.find(agent => agent.id === resolution.agentId)
      : proposers.find(agent => chosen.includes(agent.id)) ?? proposers[0];
    return selected ? [[path, authors[selected.id]]] : [];
  }));
}

/**
 * Derive the exact file composition. No model inference and no execution of repository code. `queue` means the
 * result lands through the repository's landing queue, which composes it with whatever reached main since the agents
 * started, so a moved main is expected rather than a blocker.
 */
export async function integrationPreview(original: Mission, head: string, frozenContext: ContextItem[] | null, options: { queue?: boolean } = {}): Promise<IntegrationPreview> {
  // The digest yields control. Snapshot first so a concurrent decision cannot mix two revisions.
  const mission = structuredClone(original);
  const constraints = structuredClone(frozenContext ?? []);
  const agents = includedAgents(mission).sort((a, b) => ordered(a.id, b.id));
  const skipped = mission.agents.filter(a => a.status === 'skipped').sort((a, b) => ordered(a.id, b.id));
  const paths = [...new Set(agents.flatMap(a => a.changes.map(f => f.path)))].sort(ordered);
  const files: IntegrationFile[] = paths.map(path => {
    const versions = agents.flatMap(agent => {
      const file = agent.changes.find(f => f.path === path);
      return file ? [{ agent, file }] : [];
    });
    const disagreement = new Set(versions.map(v => changeIdentity(v.file))).size > 1;
    const resolution = mission.collisions.find(c => c.path === path)?.resolution;
    const selected = disagreement ? versions.find(v => v.agent.id === resolution?.agentId) : versions[0];
    return {
      path,
      disposition: disagreement ? (selected ? 'selected' : 'unresolved') : versions.length > 1 ? 'agreement' : 'independent',
      change: selected ? { ...selected.file } : null,
      versions: versions.map(({ agent, file }) => ({ agentId: agent.id, agentName: agent.name, commit: agent.commit,
        selected: !!selected && changeIdentity(file) === changeIdentity(selected.file), additions: file.additions, deletions: file.deletions })),
      ...(selected && disagreement && resolution?.reason ? { reason: resolution.reason } : {}),
    };
  });
  const totals = {
    files: files.length,
    independent: files.filter(f => f.disposition === 'independent').length,
    agreements: files.filter(f => f.disposition === 'agreement').length,
    selected: files.filter(f => f.disposition === 'selected').length,
    unresolved: files.filter(f => f.disposition === 'unresolved').length,
    additions: files.reduce((sum, f) => sum + (f.change?.additions ?? 0), 0),
    deletions: files.reduce((sum, f) => sum + (f.change?.deletions ?? 0), 0),
  };
  const finished = agents.filter(a => a.status === 'review' || a.status === 'merged').length;
  const failed = agents.flatMap(a => a.checks).filter(c => c.status === 'failed');
  const checks: AgentCheck[] = [
    { kind: 'proposals', label: 'Proposals complete', status: finished === agents.length && agents.length > 0 ? 'passed' : 'failed', detail: `${finished} of ${agents.length} agents have completed their proposals.` },
    { kind: 'decisions', label: 'File decisions', status: totals.unresolved ? 'failed' : 'passed', detail: totals.unresolved ? `${plural(totals.unresolved, 'overlapping file')} still need a version choice.` : 'Each changed file has one selected outcome. Identical proposals are included once.' },
    { kind: 'base', label: 'Base revision', status: mission.status === 'merged' || mission.baseCommit === head || options.queue ? 'passed' : 'failed', detail: mission.status === 'merged' ? `This composition was merged as ${mission.mergeCommit}.` : options.queue ? (mission.source === 'demo' ? 'The example merges this result onto main as it is now. No checks run.' : 'The landing queue combines this result with the current main and runs the repository\'s checks before it lands.') : mission.baseCommit === head ? 'The pinned base matches the last observed main revision. The Git push checks it again.' : mission.execution === 'local' && mission.agents.length === 1 ? 'Main has moved. Have the connected agent update this task, integrate current main and rerun checks.' : 'Main has moved since these agents started. Start again from the latest revision.' },
    { kind: 'patch', label: 'Patch validation', status: failed.length ? 'failed' : finished === agents.length ? (mission.source === 'demo' ? 'warning' : 'passed') : 'warning', detail: failed.length ? `${plural(failed.length, 'agent check')} failed. Review the lane evidence.` : mission.source === 'demo' ? 'Recorded sample proposals. No coding model or project checks ran in this demo.' : 'Proposal format, path safety and file bounds only. This does not verify program behavior.' },
    { kind: 'runtime', label: 'Runtime tests', status: 'warning', detail: 'Not executed. Review and test the combined result; individually valid patches can still be incompatible.' },
  ];
  if (skipped.length) checks.push({ label: 'Closed agents', status: 'warning', detail: `${skipped.map(a => a.name).join(', ')}: excluded by the owner when continuing with completed work.` });
  // Include all alternatives and evidence, not just selected code: a changed rationale invalidates review too.
  const manifest = {
    version: 1, mission: { id: mission.id, title: mission.title, intent: mission.intent, baseCommit: mission.baseCommit, source: mission.source },
    agents: agents.map(a => ({ id: a.id, model: a.model, repo: a.repo, commit: a.commit, summary: a.summary, rationale: a.rationale, checks: a.checks,
      changes: [...a.changes].sort((a, b) => ordered(a.path, b.path)).map(f => ({ path: f.path, before: f.beforeHash ?? f.before, after: f.afterHash ?? f.after, ...(f.deleted ? { deleted: true } : {}), ...(f.mode ? { mode: f.mode } : {}) })) })),
    decisions: [...mission.collisions].sort((a, b) => ordered(a.path, b.path)).map(c => ({ path: c.path, agentId: c.resolution?.agentId ?? null, reason: c.resolution?.reason ?? null })),
    context: frozenContext === null ? null : [...constraints].sort((a, b) => ordered(a.id, b.id)),
    ...(skipped.length ? { skippedAgents: skipped.map(a => ({ id: a.id, status: a.status, error: a.error })) } : {}),
    ...(mission.reviewSelection ? { reviewSelection: mission.reviewSelection } : {}),
  };
  const fingerprint = await digest(JSON.stringify(manifest));
  const blocker = mission.status === 'merged' ? 'This mission is already merged.' : mergeBlocker(mission, options.queue ? mission.baseCommit : head);
  const handoff = [
    `# Braid handoff: ${mission.title}`, '',
    `Source: ${mission.source === 'demo' ? 'recorded demo; Git revisions are sample values' : 'live agent run'}`,
    `Mission: ${code(mission.id)}`, `Base: ${code(mission.baseCommit)}`,
    ...(mission.mergeCommit ? [`Merged revision: ${code(mission.mergeCommit)}`] : []),
    `Composition fingerprint (SHA-256, not a Git commit): ${code(fingerprint)}`, '',
    '## Intent', '', mission.intent, '',
    '## Selected files', '',
    ...files.map(file => `- ${code(file.path)}: ${file.disposition === 'unresolved' ? 'UNRESOLVED — do not merge' : file.versions.filter(v => v.selected).map(version).join(' + ')}${file.disposition === 'agreement' ? ' (identical content, included once)' : ''}${file.reason ? `\n  Decision: ${file.reason}` : ''}`), '',
    '## Competing alternatives', '',
    ...files.filter(file => file.versions.some(v => !v.selected)).map(file => `- ${code(file.path)}: ${file.versions.filter(v => !v.selected).map(version).join(', ')} ${file.disposition === 'unresolved' ? 'await a decision' : 'were not selected for this file'}.`), '',
    '## Shared context at launch', '',
    ...(frozenContext === null ? ['The original context snapshot is unavailable for this older mission. Current notes have not been substituted.'] : constraints.length ? constraints.flatMap(c => [`### ${c.title}`, '', c.body, '']) : ['No shared notes were present at launch.']), '',
    '## Agent outcomes', '',
    ...agents.flatMap(a => [`### ${a.name} · ${a.role}`, '', a.summary || 'No completed summary.', '', a.rationale || 'No rationale recorded.', '', `Source commit: ${a.commit ? code(a.commit) : 'not available'}`, ...(a.model ? [`Model: ${code(a.model)}`] : []), '']),
    ...skipped.flatMap(a => [`### ${a.name}`, '', 'Closed by the owner; excluded from this result.', ...(a.error ? [a.error] : []), '']),
    ...(mission.reviewSelection ? [`The owner (${mission.reviewSelection.actor}) selected completed proposals on ${mission.reviewSelection.selectedAt}.`, ''] : []),
    '## Verification boundaries', '',
    ...checks.map(check => `- ${check.label} [${check.status}]: ${check.detail}`), '',
    '## Next agent', '',
    'Verify the current branch and code before reusing these decisions. Read the selected files, preserve the recorded constraints, and test the assembled result. This handoff contains summaries and decisions, not private reasoning traces.', '',
  ].join('\n');
  return { missionId: mission.id, title: mission.title, source: mission.source, status: mission.status, baseCommit: mission.baseCommit, headCommit: head,
    mergeCommit: mission.mergeCommit, fingerprint, ready: !blocker, blocker, files, totals, checks, constraints, contextAvailable: frozenContext !== null, handoff: redactEmails(handoff) };
}
