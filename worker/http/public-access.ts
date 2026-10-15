import { isIP } from 'node:net';
import { directoryOf, type BraidEnv } from '../env';
import { digest } from './auth';
import { readCache } from './read-cache';

/** The address Cloudflare reports for the connecting client, or `local` in development. */
export const clientAddress = (request: Request) => request.headers.get('cf-connecting-ip') || 'local';
/** A network's budget key: its anonymous network, hashed so no address is kept. */
export const networkKey = (address: string) => digest(anonymousNetwork(address));

/** IPv6 privacy addresses in one /64 share a budget; IPv4 keeps its full address. */
export function anonymousNetwork(address: string): string {
  if (isIP(address) !== 6) return address;
  address = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) => ((Number(a) << 8) | Number(b)).toString(16) + ':' + ((Number(c) << 8) | Number(d)).toString(16));
  const [left, right] = address.split('::');
  const before = left ? left.split(':') : [], after = right ? right.split(':') : [];
  const parts = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  const words = parts.map(part => Number.parseInt(part, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return `${parts.slice(0, 4).map(part => Number.parseInt(part, 16).toString(16)).join(':')}::/64`;
}

type PublicRead = Awaited<ReturnType<import('../accounts/directory').Directory['publicRead']>>;
type Published = Extract<PublicRead, { ok: true }>['data'];
export const PUBLIC_READ_TTL = 5000;
const reads = new WeakMap<BraidEnv, Map<string, { expires: number; result: Promise<PublicRead> }>>();
/**
 * A public answer is a lease: the Directory gave it at a moment, and it may be trusted for five seconds from then. The
 * data center keeps each lease so its isolates share one Directory lookup instead of each paying for their own; the
 * lease's end travels with it, so a repository turning private is seen everywhere within those five seconds.
 */
const leaseKey = (workspaceId: string) => new Request(`https://public.braid.invalid/${encodeURIComponent(workspaceId)}`);
async function lookup(env: BraidEnv, workspaceId: string): Promise<{ result: PublicRead; expires: number }> {
  const leases = await readCache('public-read');
  const shared = await leases.match(leaseKey(workspaceId));
  if (shared) {
    const lease = await shared.json() as { data: Published; expires: number };
    if (lease.expires > Date.now()) return { result: { ok: true, data: lease.data }, expires: lease.expires };
  }
  const result = await directoryOf(env).publicRead(workspaceId);
  const expires = Date.now() + PUBLIC_READ_TTL;
  if (result.ok) await leases.put(leaseKey(workspaceId), Response.json({ data: result.data, expires }, { headers: { 'cache-control': `public, max-age=${PUBLIC_READ_TTL / 1000}` } }));
  return { result, expires };
}
/** Positive and negative lookups are kept in the isolate until their lease ends; privacy changes take effect within five seconds. */
export function publicRead(env: BraidEnv, workspaceId: string): Promise<PublicRead> {
  let cache = reads.get(env);
  if (!cache) { cache = new Map(); reads.set(env, cache); }
  const current = cache.get(workspaceId);
  if (current && current.expires > Date.now()) return current.result;
  if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + PUBLIC_READ_TTL, result: lookup(env, workspaceId).then(found => { entry.expires = found.expires; return found.result; }) };
  cache.set(workspaceId, entry);
  void entry.result.catch(() => { if (cache!.get(workspaceId) === entry) cache!.delete(workspaceId); });
  return entry.result;
}

/** A forced private flip precedes imports; every positive lookup lease issued before it must expire first. */
export async function waitForPublicReads(until: number): Promise<void> {
  const delay = until - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}
