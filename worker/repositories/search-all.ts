import type { AccountIdentity, Organization, RepositoryAddress } from '../../shared/account';
import type { GlobalSearch, RepositorySearch, SearchRepository } from '../../shared/search';
import { parseSearch, qualifierValues } from '../../shared/search-query';
import { directoryOf, securityOf, type BraidEnv } from '../env';
import { HttpError, unwrap } from '../errors';
import { globalSearchQuery, parse } from '../schemas';
import { repositoryKey } from '../changes/names';

export const GLOBAL_SEARCH_LIMITS = { repositories: 20, concurrency: 4 };
const EXAMPLE: SearchRepository = { owner: 'example', name: 'relay', visibility: 'public', recorded: true };
const empty = (): GlobalSearch => ({ repositories: [], searched: [], unavailable: [], matchCount: 0, truncated: false });

async function parallel<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, GLOBAL_SEARCH_LIMITS.concurrency) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}

/** Directory authorization is fresh for every query. Only immutable code indexes live in the repository objects. */
export async function searchAllRoute(request: Request, env: BraidEnv, user: AccountIdentity | null, agentWorkspace: string | undefined, network: string, readExample: (q: string) => Promise<Response>): Promise<Response> {
  const { q } = parse(globalSearchQuery, Object.fromEntries(new URL(request.url).searchParams));
  const query = parseSearch(q), repos = qualifierValues(query, 'repo');
  const owners = [...new Set([...qualifierValues(query, 'org'), ...qualifierValues(query, 'user')])];
  const directory = directoryOf(env);
  const candidates: { owner: string; repo: string }[] = [];
  const canonicalOwners = new Set<string>();
  for (const page of await parallel(owners.filter(owner => owner !== 'example'), async owner => await directory.ownerRepositories(user?.id ?? null, owner))) {
    if (!page.ok) continue;
    canonicalOwners.add(page.data.owner.slug);
    if (!repos.length) candidates.push(...page.data.repositories.map(repo => ({ owner: page.data.owner.slug, repo: repo.slug })));
  }
  if (owners.includes('example')) canonicalOwners.add('example');
  if (repos.length) candidates.push(...repos.map(value => { const [owner, repo] = value.split('/'); return { owner, repo }; }));
  else if (!owners.length && user) {
    const [listed, personal] = await Promise.all([directory.dispatch(user, 'list', {}), directory.personalOwner(user.id)]);
    const organizations = JSON.parse(unwrap(listed)) as Organization[];
    for (const owner of [...(personal ? [personal] : []), ...organizations]) candidates.push(...owner.workspaces
      .filter(repo => !agentWorkspace || repo.id === agentWorkspace).map(repo => ({ owner: owner.slug, repo: repo.slug })));
  }
  if (!repos.length && owners.includes('example')) candidates.push({ owner: 'example', repo: 'relay' });

  const selected: (RepositoryAddress | 'example')[] = [], seen = new Set<string>();
  // Stop discovery after the first extra readable repository; inaccessible names never affect truncation.
  for (let at = 0; at < candidates.length && selected.length <= GLOBAL_SEARCH_LIMITS.repositories; at += GLOBAL_SEARCH_LIMITS.concurrency) {
    const resolved = await parallel(candidates.slice(at, at + GLOBAL_SEARCH_LIMITS.concurrency), async candidate => {
      if (candidate.owner === 'example' && candidate.repo === 'relay') return agentWorkspace ? null : 'example' as const;
      const found = await directory.resolveRepository(user?.id ?? null, candidate.owner, candidate.repo);
      return found.ok && !(found.data.mirror && found.data.visibility === 'private') && (!agentWorkspace || found.data.workspaceId === agentWorkspace) ? found.data : null;
    });
    for (const found of resolved) {
      if (!found || (owners.length && !canonicalOwners.has(found === 'example' ? 'example' : found.owner.slug))) continue;
      const key = found === 'example' ? 'example' : found.workspaceId;
      if (!seen.has(key)) { seen.add(key); selected.push(found); }
    }
  }
  const result = empty();
  result.truncated = selected.length > GLOBAL_SEARCH_LIMITS.repositories;
  const rows = await parallel(selected.slice(0, GLOBAL_SEARCH_LIMITS.repositories), async address => {
    let repository: SearchRepository, response: Response;
    if (address === 'example') {
      repository = EXAMPLE;
      response = await readExample(q);
    } else {
      // A list or address lookup is not a lasting grant. Recheck immediately before opening this object.
      const member = user ? await directory.access(user, address.workspaceId, false) : null;
      let teamId: string;
      if (member?.ok) teamId = member.data.teamId;
      else {
        const published = await directory.publicRead(address.workspaceId);
        if (!published.ok) return null;
        teamId = published.data.teamId;
        const allowed = env.PUBLIC_EXPENSIVE_LIMITER ? (await env.PUBLIC_EXPENSIVE_LIMITER.limit({ key: network })).success
          : (await securityOf(env).consume(`public-expensive:${network}`, 60, 60_000)).allowed;
        if (!allowed) throw new HttpError(429, 'Too many content requests. Retry shortly.', 60);
      }
      repository = { owner: address.owner.slug, name: address.repo.slug, visibility: member?.ok ? address.visibility : 'public' };
      const key = repositoryKey(teamId, address.workspaceId);
      const url = new URL('/api/search/repository', request.url); url.searchParams.set('q', q);
      // Only gateway-generated headers cross the internal route. Client-supplied roles are never forwarded.
      response = await env.WORKSPACES.get(env.WORKSPACES.idFromName(key)).fetch(new Request(url, { headers: {
        'x-braid-mode': 'live', 'x-braid-role': 'viewer', 'x-braid-repository': key,
        ...(!member?.ok ? { 'x-braid-public': 'true', 'x-braid-public-network': network } : {}),
      } }));
    }
    return { repository, data: response.ok ? await response.json() as RepositorySearch : null };
  });
  for (const row of rows) {
    if (!row) continue;
    if (!row.data) { result.unavailable.push(row.repository); result.truncated = true; continue; }
    result.searched.push(row.repository);
    result.matchCount += row.data.matchCount;
    result.truncated ||= row.data.truncated;
    if (row.data.files.length || row.data.results.length) result.repositories.push({ ...row.repository, ...row.data });
  }
  return Response.json(result);
}
