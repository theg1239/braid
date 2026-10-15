import type { RepositoryTree } from '../../../shared/repository';
import type { ChangeSummary, WorkspaceSnapshot } from '../../../shared/types';
import { basename } from '../../lib/format';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|swift)$/i;
const TEST = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|_)|[._](?:test|spec)\.|(?:Test|Spec)\.[^.]+$/i;
const stem = (path: string) => basename(path).replace(/\.[^.]+$/, '').replace(/^(?:test|spec)_|[._](?:test|spec)$|(?:Test|Spec)$/g, '').toLowerCase();

/** Suggestions use only this snapshot and already-read pages at its head; incomplete trees never mean an empty repo. */
export function taskSuggestions(snapshot: WorkspaceSnapshot, directories: Iterable<RepositoryTree> = [], latest?: ChangeSummary): string[] {
  const { project, capabilities, missions } = snapshot;
  // Replay has its own fixed brief. Never advertise arbitrary work in the recording.
  if (capabilities.mode === 'demo' || !project.id) return [];
  const paths = new Set(Object.keys(snapshot.files));
  let empty = false;
  for (const tree of directories) {
    if (tree.ref !== project.head) continue;
    if (!tree.path && !tree.entries.length && !tree.nextCursor) empty = true;
    for (const entry of tree.entries) if (entry.kind === 'file') paths.add(entry.path);
  }
  const known = [...paths].sort();
  if (empty && !known.length) return [`Add a README for ${project.name}`, `Add an AGENTS.md for ${project.name}`];
  const tests = new Set(known.filter(path => TEST.test(path)).map(stem));
  const source = known.find(path => SOURCE.test(path) && !TEST.test(path) && !tests.has(stem(path)) && !/(?:^|\/)(?:[.]|node_modules\/|vendor\/|dist\/)|[.]config[.]|[.]d[.]ts$/.test(path));
  const readme = known.find(path => /^readme(?:\.(?:md|markdown|txt))?$/i.test(path));
  const merged = latest?.status === 'landed' && latest.landedCommit === project.head ? latest : undefined;
  const task = missions.find(mission => mission.source === 'live' && mission.status === 'merged' && mission.mergeCommit === project.head);
  const recent = merged?.title || task?.title;
  return [
    ...(merged?.checkState === 'failed' ? [`Fix the failing check on ${project.branch}`] : []),
    source ? `Add tests for ${source}` : `Add tests for ${project.name}`,
    readme && recent ? `Update ${readme} for “${recent}”` : readme && source ? `Document ${source} in ${readme}` : `Document how to run ${project.name}`,
  ];
}
