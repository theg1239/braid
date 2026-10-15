import type { CommitPage, RepositoryCommit } from '../../../shared/history';
import { modelName, toolBase, toolName } from '../../../shared/models';
import { useMirror } from '../../account/mirrors';
import { api } from '../../lib/api';
import { reader } from '../../lib/reads';
import { useRead } from '../../lib/resources';
import { useSnapshot } from '../../store/workspace';

const MIRROR_HISTORY_LIMIT = 100;

// A completed import may have more ancestry at the same tip than the shallow preview.
export const mirrorHistory = reader(
  (head: string, importing: boolean, cursor: string | null = null) => JSON.stringify([head, importing, cursor]),
  (head: string, _importing: boolean, cursor: string | null = null) => api.commits(head, '', cursor, MIRROR_HISTORY_LIMIT),
);

export function useMirrorHistory() {
  const snapshot = useSnapshot();
  const mirror = useMirror();
  const head = snapshot.project.head;
  const importing = !!snapshot.importing || !!mirror?.importing;
  const history = useRead(mirrorHistory, head ? [head, importing, null] : null);
  return { ...history, head, importing };
}

export interface HistoryContributor {
  key: string;
  name: string;
  tool?: string;
  kind: RepositoryCommit['author']['kind'];
  commits: number;
  latest?: RepositoryCommit;
}

/** Only the API's attributed kind counts as an agent; messages and names are never evidence here. */
export function aggregateHistory(commits: RepositoryCommit[], limit = MIRROR_HISTORY_LIMIT) {
  const items = [...new Map(commits.map(commit => [commit.hash, commit])).values()].slice(0, limit);
  const agents = new Map<string, HistoryContributor>();
  const people: HistoryContributor = { key: 'people', kind: 'human', name: 'People', commits: 0 };
  for (const commit of items) {
    const { author } = commit;
    if (author.kind === 'human' || author.kind === 'github') {
      people.commits++;
      people.latest ??= commit;
      continue;
    }
    const name = author.kind === 'simulated' ? 'Simulated' : author.model ? modelName(author.model) : author.name;
    const tool = author.tool ? toolName(author.tool) : undefined;
    const key = JSON.stringify([author.kind, author.model ?? author.name, author.tool ? toolBase(author.tool) : '']);
    const row = agents.get(key) ?? { key, name, tool, kind: author.kind, commits: 0, latest: commit };
    row.commits++;
    agents.set(key, row);
  }
  const rows = [...agents.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  return { total: items.length, agentCommits: rows.filter(row => row.kind === 'agent').reduce((sum, row) => sum + row.commits, 0), agents: rows, people };
}

/** Short histories are complete only after import finishes and the server reports no further page. */
export function completeHistory(page: CommitPage | undefined, importing: boolean, limit = MIRROR_HISTORY_LIMIT): boolean {
  return !!page && (page.items.length >= limit || !importing && page.nextCursor === null);
}
