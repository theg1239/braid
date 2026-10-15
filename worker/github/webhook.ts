import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import type { BraidEnv } from '../env';
import { trunkOf } from '../changes/names';
import { logFailure } from '../errors';

export interface GitHubEvent { name: string; action?: string; ref?: string; sha?: string; number?: number }
export const githubRepoOf = (env: Pick<BraidEnv, 'GITHUB_REPOS'>, repositoryId: number) => env.GITHUB_REPOS.getByName(`github-repo:${repositoryId}`);

/**
 * One object per GitHub repository: which Braid repositories link to it, and
 * which deliveries were already handled. Webhooks only wake the landing queue;
 * it then reads GitHub's current state itself rather than trusting a payload.
 */
export class GitHubRepo extends DurableObject<BraidEnv> {
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS links (repository TEXT PRIMARY KEY)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  }
  link(repository: string) { this.ctx.storage.sql.exec('INSERT OR IGNORE INTO links (repository) VALUES (?)', repository); }
  unlink(repository: string) { this.ctx.storage.sql.exec('DELETE FROM links WHERE repository = ?', repository); }
  async deliver(delivery: string, event: GitHubEvent): Promise<{ duplicate: boolean; repositories: number }> {
    if (this.ctx.storage.sql.exec('INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?)', delivery, Date.now()).rowsWritten === 0) return { duplicate: true, repositories: 0 };
    if (Math.random() < 0.02) this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE at < ?', Date.now() - 3 * 86_400_000);
    const repositories = this.ctx.storage.sql.exec<{ repository: string }>('SELECT repository FROM links').toArray().map(row => row.repository);
    // One linked repository's failure must not stop the others; the delivery is already recorded, so it is logged.
    await Promise.all(repositories.map(repository => trunkOf(this.env, repository).githubEvent(repository, event)
      .catch(error => logFailure('github_event_failed', error, { repository, delivery, githubEvent: event.name }))));
    return { duplicate: false, repositories: repositories.length };
  }
}

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const pulls = v.optional(v.array(v.object({ number: v.number() })), []);
/**
 * The parts of a GitHub event Braid reads, and nothing else. They only say
 * which repository and commit to look at; the queue reads the rest from GitHub.
 */
const payload = v.pipe(v.string(), v.parseJson(), v.object({
  action: v.optional(v.string()), ref: v.optional(v.string()), after: v.optional(v.string()), sha: v.optional(v.string()),
  repository: v.optional(v.object({ id })),
  repositories_removed: v.optional(v.array(v.object({ id })), []), repositories: v.optional(v.array(v.object({ id })), []),
  pull_request: v.optional(v.object({ number: v.number(), head: v.object({ sha: v.string() }) })),
  check_suite: v.optional(v.object({ head_sha: v.string(), pull_requests: pulls })),
  check_run: v.optional(v.object({ head_sha: v.string(), pull_requests: pulls })),
}));

/** GitHub signs every webhook delivery with HMAC-SHA256 over the raw body. */
async function verifyWebhook(secret: string, body: ArrayBuffer, signature: string | null): Promise<boolean> {
  if (!secret || !signature?.startsWith('sha256=') || signature.length !== 71) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const byte = parseInt(signature.slice(7 + i * 2, 9 + i * 2), 16);
    if (Number.isNaN(byte)) return false;
    bytes[i] = byte;
  }
  return crypto.subtle.verify('HMAC', key, bytes, body);
}

/** Verifies GitHub's signature over the raw body, then fans the event out to linked repositories. */
export async function githubWebhook(request: Request, env: BraidEnv): Promise<Response> {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return Response.json({ error: 'GitHub webhooks are not configured.' }, { status: 503 });
  const length = Number(request.headers.get('content-length'));
  if (length > 26 * 1024 * 1024) return Response.json({ error: 'Payload too large.' }, { status: 413 });
  const body = await request.arrayBuffer();
  if (!await verifyWebhook(env.GITHUB_APP_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256'))) return Response.json({ error: 'Invalid signature.' }, { status: 401 });
  const name = request.headers.get('x-github-event') ?? '', delivery = request.headers.get('x-github-delivery') ?? crypto.randomUUID();
  if (name === 'ping') return Response.json({ ok: true });
  const parsed = v.safeParse(payload, new TextDecoder().decode(body));
  if (!parsed.success) return Response.json({ error: 'Unexpected payload.' }, { status: 400 });
  const { action, ref, repository, check_suite: suite, check_run: run, pull_request: pull, ...rest } = parsed.output;
  const removed = name === 'installation_repositories' && action === 'removed' ? rest.repositories_removed
    : name === 'installation' && (action === 'deleted' || action === 'suspend') ? rest.repositories : [];
  // Each repository's delivery is idempotent by its id, so an organisation's uninstall reaches them all at once.
  await Promise.all(removed.map(({ id: removedId }) => githubRepoOf(env, removedId).deliver(`${delivery}:${removedId}`, { name: 'installation_removed' })));
  if (!repository) return Response.json({ accepted: true }, { status: 202 });
  const sha = suite?.head_sha ?? run?.head_sha ?? pull?.head.sha ?? rest.sha ?? rest.after;
  const number = pull?.number ?? suite?.pull_requests[0]?.number ?? run?.pull_requests[0]?.number;
  const event: GitHubEvent = { name, ...(action ? { action } : {}), ...(ref ? { ref } : {}), ...(sha ? { sha } : {}), ...(number ? { number } : {}) };
  const result = await githubRepoOf(env, repository.id).deliver(delivery, event);
  return Response.json({ accepted: true, ...result }, { status: 202 });
}
