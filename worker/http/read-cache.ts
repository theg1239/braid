import { logFailure } from '../errors';

interface ReadAnswer { body: ArrayBuffer | null; status: number; statusText: string; headers: [string, string][] }
const pending = new Map<string, Promise<ReadAnswer>>();
const responseOf = ({ body, ...init }: ReadAnswer) => new Response(body, init);
const UNTIL = 'x-braid-cache-until';

export const matchesEtag = (request: Request, etag: string | null) => !!etag && !!request.headers.get('if-none-match')?.split(',')
  .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);

export async function readCache(name: string) {
  let cache: Cache | undefined;
  try { cache = await caches.open(name); }
  catch (error) { logFailure('read_cache_open_failed', error, { cache: name }); }
  return {
    async match(key: Request) {
      try { return await cache?.match(key); }
      catch (error) { logFailure('read_cache_lookup_failed', error, { cache: name }); return undefined; }
    },
    async put(key: Request, response: Response) {
      try { await cache?.put(key, response); }
      catch (error) { logFailure('read_cache_write_failed', error, { cache: name }); }
    },
  };
}

export async function cachedPublicRead(key: Request, seconds: number, read: () => Promise<Response>): Promise<Response> {
  const cache = await readCache('public-responses'), hit = await cache.match(key);
  if (hit && Number(hit.headers.get(UNTIL)) > Date.now()) {
    const answer = new Response(hit.body, hit);
    answer.headers.delete(UNTIL); answer.headers.delete('cache-control');
    return answer;
  }
  const current = pending.get(key.url);
  if (current) return responseOf(await current);
  const until = Date.now() + seconds * 1000;
  const work = (async () => {
    const answer = await read();
    // A stream belongs to its request in Workers. Only buffered data may be shared with another request's waiter.
    const data: ReadAnswer = { body: answer.body ? await answer.arrayBuffer() : null,
      status: answer.status, statusText: answer.statusText, headers: [...answer.headers] };
    if (answer.status === 200 && !answer.headers.has('set-cookie') && until > Date.now()) {
      const copy = responseOf(data);
      copy.headers.set('cache-control', `public, max-age=${Math.ceil((until - Date.now()) / 1000)}`);
      copy.headers.set(UNTIL, String(until)); copy.headers.delete('server-timing');
      await cache.put(key, copy);
    }
    return data;
  })();
  if (pending.size < 500) pending.set(key.url, work);
  try { return responseOf(await work); }
  finally { if (pending.get(key.url) === work) pending.delete(key.url); }
}
