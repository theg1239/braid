import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { CliError, fail, type BraidContext } from './context';
import type { Credentials } from './config';
import { access, claims, errorBody } from './schemas';
import { redact } from './secrets';
import { plain } from './terminal';

/** Braid answered, but not with success. `status` lets a command treat, say, a 404 as "not available here". */
export class ApiError extends CliError {
  constructor(message: string, readonly status: number) { super(message); }
}

/** `json` is sent exactly as given, as a retry must be, and `body` as JSON. */
interface Call { method?: 'GET' | 'POST'; body?: unknown; json?: string; headers?: Record<string, string>; timeout?: number }

/** Sends one request and returns the response, whatever its status; a network failure is reported, never thrown raw. */
export async function send(context: BraidContext, url: string, { method = 'GET', body, json = body === undefined ? undefined : JSON.stringify(body), headers = {}, timeout = 30_000 }: Call = {}): Promise<Response> {
  try {
    return await context.fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(json === undefined ? {} : { body: json }),
    });
  } catch {
    return fail(`Braid could not be reached at ${new URL(url).origin}. Check the connection and retry.`);
  }
}

/** A successful answer parsed with `schema`; anything else becomes an ApiError carrying Braid's own explanation. */
export async function answer<const S extends v.GenericSchema>(response: Response, schema: S, { path, secrets = [] }: { path: string; secrets?: readonly string[] }): Promise<v.InferOutput<S>> {
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const reason = v.safeParse(errorBody, data);
    throw new ApiError(reason.success ? redact(plain(reason.output.error), secrets).slice(0, 2000) : `Braid answered HTTP ${response.status}.`, response.status);
  }
  const parsed = v.safeParse(schema, data);
  if (!parsed.success) fail(`Braid answered ${path} in a form this version of braid does not understand${parsed.issues[0].path ? ` (${parsed.issues[0].path.map(item => String(item.key)).join('.')})` : ''}. Update braid and retry.`);
  return parsed.output;
}

export function retryAfter(value: string | null, now: number) {
  const wait = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value ?? '') - now;
  return Number.isFinite(wait) ? Math.max(0, wait) : 0;
}

/**
 * A signed-in repository. Requests carry a five-minute access token minted from the saved connection, renewed after
 * four minutes so long waits never present an expired one; the connection itself only ever goes to
 * /api/agent/session.
 */
export class Braid {
  #access: { token: string; minted: number; agent: { id: string; name: string }; expiresAt: string } | undefined;
  constructor(readonly context: BraidContext, readonly credentials: Credentials) {}
  get origin() { return this.credentials.origin; }
  /** Values that must never be printed or submitted. */
  get secrets() { return [this.credentials.accessToken, ...(this.#access ? [this.#access.token] : [])]; }

  async session() {
    if (this.#access && this.context.now() - this.#access.minted < 4 * 60_000) return this.#access;
    const response = await send(this.context, `${this.origin}/api/agent/session`, { method: 'POST', body: {}, headers: this.#headers(this.credentials.accessToken) });
    if (response.status === 401) throw new ApiError(`Your Braid approval for ${this.origin} expired or was revoked. Run braid login again.`, 401);
    const granted = await answer(response, access, { path: '/api/agent/session', secrets: this.secrets });
    if (granted.workspaceId !== this.credentials.workspaceId) fail('Braid issued access for a different repository. Run braid login again.');
    this.#access = { token: granted.accessToken, minted: this.context.now(), agent: granted.agent, expiresAt: granted.expiresAt };
    return this.#access;
  }

  /** The person who approved this connection, read from the access token Braid signed for it. */
  async owner() {
    const { token } = await this.session();
    const payload = token.slice('braid_at_'.length).split('.')[0];
    const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), claims), Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.success ? parsed.output.user : undefined;
  }

  async get<const S extends v.GenericSchema>(path: string, schema: S): Promise<v.InferOutput<S>> {
    const { token } = await this.session();
    return answer(await send(this.context, `${this.origin}${path}`, { headers: this.#headers(token) }), schema, { path, secrets: this.secrets });
  }

  /** A write. `key` makes it safe to retry: Braid applies a key once and answers repeats with the first result. */
  async post<const S extends v.GenericSchema>(path: string, body: unknown, schema: S, { key = randomUUID(), timeout = 120_000 }: { key?: string; timeout?: number } = {}): Promise<v.InferOutput<S>> {
    const { token } = await this.session();
    return answer(await send(this.context, `${this.origin}${path}`, { method: 'POST', body, timeout, headers: { ...this.#headers(token), 'idempotency-key': key } }), schema, { path, secrets: this.secrets });
  }

  #headers(token: string) {
    return { authorization: `Bearer ${token}`, 'x-braid-workspace': this.credentials.workspaceId };
  }
}
