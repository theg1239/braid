import type { Timings } from './timing';
import { matchesEtag, readCache } from './read-cache';
import { digest } from './auth';

/*
 * Repository reads of a public repository: a tree or file at a commit never changes, so each data center keeps it by
 * repository, commit and path for the rest of this deploy, and remembers for a few seconds which commit a branch is at,
 * so a push shows within seconds while the reads between pushes never reach the repository. The caller has checked that
 * the repository is public; a private repository's answers never enter this cache, whoever asks.
 */
const REPOSITORY_READS = new Set(['/api/repository/tree', '/api/repository/tree/commits', '/api/repository']);
const HEAD_FRESH_SECONDS = 10;
const COMMIT = /^[0-9a-f]{40}$/;
/** Marks an entry a public read was answered with, after its commit was found published. */
const PUBLISHED = 'x-braid-published';
export function repositoryRead(url: URL, method: string): boolean {
  return method === 'GET' && REPOSITORY_READS.has(url.pathname) && !url.searchParams.has('download');
}
/*
 * A public read names a branch, read strictly as `refs/heads/` or `refs/tags/`, or a commit its repository checks is
 * published. So which commit a name is at is kept apart for members, whose names Git resolves its own way, and an entry
 * a member's read left serves a public caller who named its commit only once a public read of it was allowed.
 */
export async function cachedRepositoryRead(request: Request, repository: string, build: string, timings: Timings, publicViewer: boolean, read: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url), ref = url.searchParams.get('ref') ?? '', named = !COMMIT.test(ref);
  const conditional = (answer: Response) => {
    const etag = answer.headers.get('etag');
    return etag && matchesEtag(request, etag) ? new Response(null, { status: 304, headers: { etag } }) : answer;
  };
  const kept = await readCache('repository');
  const base = `https://repository.braid.invalid/${build}/${encodeURIComponent(repository)}`;
  // The branch named, or the default branch when none is: which commit it was at a moment ago.
  const branch = new Request(`${base}/head?ref=${encodeURIComponent(ref)}`), member = new Request(`${base}/member-head?ref=${encodeURIComponent(ref)}`);
  let commit = named ? await (await timings.wait('head', kept.match(branch)))?.text() : ref;
  if (!commit && !publicViewer) commit = await (await kept.match(member))?.text();
  const at = (commit: string) => { const key = new URL(`${base}/at/${commit}${url.pathname}`); key.search = url.search; key.searchParams.set('ref', commit); return new Request(key); };
  if (commit) {
    const hit = await timings.wait('edge', kept.match(at(commit)));
    // What the browser may keep is the API's own concern, not the data center's.
    if (hit && (!publicViewer || named || hit.headers.has(PUBLISHED))) { const answer = new Response(hit.body, hit); answer.headers.delete('cache-control'); answer.headers.delete(PUBLISHED); return conditional(answer); }
    if (commit !== ref) {
      url.searchParams.set('ref', commit); request = new Request(url, request);
      // Read from a public branch a moment ago, so its repository need not check it again.
      if (publicViewer) request.headers.set('x-braid-authorized', commit);
    }
  }
  const result = await read(request), pinned = result.headers.get('x-braid-ref');
  if (result.status !== 200 || !pinned || result.headers.get('cache-control') === 'no-store') return result;
  const answer = new Response(result.body, result);
  answer.headers.set('etag', `"${await digest(at(pinned).url)}"`);
  const copy = new Response(answer.clone().body, answer);
  copy.headers.set('cache-control', 'public, max-age=31536000, immutable');
  copy.headers.delete('server-timing');
  if (publicViewer) copy.headers.set(PUBLISHED, '1');
  await kept.put(at(pinned), copy);
  if (named && !commit) await kept.put(publicViewer ? branch : member, new Response(pinned, { headers: { 'cache-control': `public, max-age=${HEAD_FRESH_SECONDS}` } }));
  return conditional(answer);
}
