import type { Project } from '../../shared/types';
import { artifactsOf, directoryOf, securityOf, type BraidEnv } from '../env';
import { logFailure } from '../errors';
import { networkKey } from '../http/public-access';
import { SearchIndexStore } from './search-cache';
import { repositorySearchIndex, SEARCH_LIMITS } from './search';
import { repositoryParts } from '../changes/names';

/** Attempts, including failures, in any rolling hour. Public views cannot spend the four reserved event slots. */
export const SEARCH_WARM_LIMITS = { builds: 6, views: 2, window: 3_600_000 };

export class SearchWarmBudget {
  constructor(private storage: DurableObjectStorage) {}

  claim(head: string, view: boolean, now = Date.now()): boolean {
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS search_warm_v1 (head TEXT PRIMARY KEY, started INTEGER NOT NULL, public_view INTEGER NOT NULL)');
    return this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM search_warm_v1 WHERE started <= ?', now - SEARCH_WARM_LIMITS.window);
      const attempts = this.storage.sql.exec<{ head: string; public_view: number }>('SELECT head, public_view FROM search_warm_v1').toArray();
      if (attempts.some(row => row.head === head) || attempts.length >= SEARCH_WARM_LIMITS.builds
        || (view && attempts.filter(row => row.public_view === 1).length >= SEARCH_WARM_LIMITS.views)) return false;
      this.storage.sql.exec('INSERT INTO search_warm_v1 (head, started, public_view) VALUES (?, ?, ?)', head, now, Number(view));
      return true;
    });
  }
}

type PublicView = { repository: string; address: string };
type WarmRequest = { project: Pick<Project, 'id' | 'branch' | 'head'>; view?: PublicView };
type WarmRun = { next: WarmRequest | null; task: Promise<void> };
const running = new WeakMap<object, WarmRun>();

/**
 * Called under waitUntil after an authorized import/landing, or an authorized public root-tree read.
 * One run and one replaceable next head per repository; visitors never choose the revision to build.
 */
export function warmRepositorySearch(owner: object, storage: DurableObjectStorage, env: BraidEnv, project: WarmRequest['project'], view?: PublicView): Promise<void> {
  const request = { project: { ...project }, view };
  const active = running.get(owner);
  if (active) { active.next = request; return active.task; }
  const run: WarmRun = { next: request, task: Promise.resolve() };
  running.set(owner, run);
  run.task = Promise.resolve().then(async () => {
    try {
      while (run.next) {
        const next = run.next; run.next = null;
        // A search builds its own index when none was prebuilt, so a failed prebuild is only logged.
        try { await warm(owner, storage, env, next); }
        catch (error) { logFailure('search_prebuild_failed', error); }
      }
    } finally { running.delete(owner); }
  });
  return run.task;
}

async function warm(owner: object, storage: DurableObjectStorage, env: BraidEnv, { project, view }: WarmRequest) {
  const indexes = new SearchIndexStore(storage, SEARCH_LIMITS.cachedHeads);
  if (indexes.has(project.head) || !new SearchWarmBudget(storage).claim(project.head, !!view)) return;
  if (view) {
    // Only Directory-published repositories qualify, including when a member opened Code.
    const address = repositoryParts(view.repository);
    if (!address) return;
    const published = await directoryOf(env).publicRead(address.workspaceId);
    if (!published.ok || published.data.teamId !== address.teamId) return;
    const network = await networkKey(view.address);
    const allowed = env.PUBLIC_EXPENSIVE_LIMITER ? (await env.PUBLIC_EXPENSIVE_LIMITER.limit({ key: network })).success
      : (await securityOf(env).consume(`public-expensive:${network}`, 60, 60_000)).allowed;
    if (!allowed) return;
  }
  // Own the capability for the whole job: the Code request's handle may already be disposed.
  using repo = await artifactsOf(env).get(project.id);
  await repositorySearchIndex(owner, repo, project.branch, { storage });
}
