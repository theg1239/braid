import * as v from 'valibot';
import type { BraidEnv } from '../env';
import { HttpError } from '../errors';
import { seal, unseal } from '../http/auth';
import { PROVIDER_IDS, PROVIDERS, type ProviderConnection, type ProviderId, type ProviderLimit } from '../../shared/providers';
import { now } from '../workspace/domain';

/*
 * Model provider keys people connect for their own hosted runs. Each key is sealed with AES-GCM under a key of its
 * own, bound to the person and the provider, and opened only to call that provider for that person's run. Nothing
 * here returns a key to a browser, a snapshot, Git or a log line.
 */

/** Which person's key a hosted run uses. It carries no secret: the sandbox asks Security for the key on every model turn. */
export interface HostedProvider { id: ProviderId; owner: string; version: string }
/** What a run is lent for one model call. */
export interface ProviderLease { key: string; model: string; version: string }
/** How a call went, for the owner's settings. Failure codes are the ones `ProviderFailure` carries. */
export type ProviderOutcome = { ok: true; limits?: ProviderLimit[] } | { ok: false; code: ProviderFailureCode; limits?: ProviderLimit[] };
export type ProviderFailureCode = 'revoked' | 'auth' | 'forbidden' | 'model' | 'rate_limit' | 'quota' | 'context' | 'invalid' | 'unavailable' | 'timeout';

const name = (provider: ProviderId) => PROVIDERS[provider].name;
const failureText: Record<ProviderFailureCode, (provider: string) => string> = {
  revoked: p => `The ${p} connection was removed. No proposal was published. Connect ${p} in Settings → Providers, then start again.`,
  auth: p => `${p} rejected the saved key. No proposal was published. Reconnect ${p} in Settings → Providers, then start again.`,
  forbidden: p => `${p} refused this key for the chosen model. No proposal was published. Check the key’s permissions or choose another model in Settings → Providers.`,
  model: p => `${p} does not offer the chosen model to this key. No proposal was published. Choose another model in Settings → Providers.`,
  rate_limit: p => `${p} rate-limited this key. No proposal was published. Start again once the limit resets.`,
  quota: p => `${p} reports no remaining credit or quota for this key. No proposal was published. Add credit with ${p}, then start again.`,
  context: p => `The task exceeded the ${p} model’s input limit. No proposal was published. Start again with a smaller task.`,
  invalid: p => `${p} returned an answer Braid could not use. No proposal was published. Start again, or choose another model in Settings → Providers.`,
  unavailable: p => `${p} could not be reached. No proposal was published. Start again shortly.`,
  timeout: p => `${p} did not answer in time. No proposal was published. Start again shortly.`,
};
/** What the owner's settings say about the last failure. */
const settingsText: Record<ProviderFailureCode, string> = {
  revoked: 'Not connected', auth: 'Key rejected', forbidden: 'Model refused for this key', model: 'Model unavailable to this key',
  rate_limit: 'Rate limited', quota: 'No credit left', context: 'Task too large for the model', invalid: 'Unusable answer', unavailable: 'Unreachable', timeout: 'Timed out',
};

/** A provider call that failed, with the provider's HTTP status and Braid's code for it. The message is fixed text, safe to show. */
export class ProviderFailure extends Error {
  constructor(public provider: ProviderId, public code: ProviderFailureCode, public status?: number, public retryAfter?: number) { super(failureText[code](name(provider))); this.name = 'ProviderFailure'; }
  /** A later attempt can succeed without the person changing anything. */
  get retryable() { return this.code === 'rate_limit' || this.code === 'unavailable' || this.code === 'timeout'; }
}

/* ---------- sealing ---------- */

/** A key is sealed for its owner and provider, under the same deployment secret as GitHub's credentials but its own purpose. */
const context = (userId: string, provider: ProviderId) => `braid-provider:${userId}:${provider}`;
export async function sealProviderKey(env: Pick<BraidEnv, 'SESSION_SECRET'>, userId: string, provider: ProviderId, key: string): Promise<string> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'Provider credential storage is not configured.');
  return seal(env.SESSION_SECRET, 'braid-providers-v1', context(userId, provider), key);
}
export const openProviderKey = (env: Pick<BraidEnv, 'SESSION_SECRET'>, userId: string, provider: ProviderId, sealed: string) =>
  unseal(env.SESSION_SECRET, 'braid-providers-v1', context(userId, provider), sealed);

/* ---------- requests ---------- */

export const providerId = v.picklist(PROVIDER_IDS, 'Choose OpenAI, Anthropic or OpenRouter.');
/** A pasted key: printable, without spaces, starting the way the provider's keys do. */
export function providerKey(provider: ProviderId) {
  return v.object({
    key: v.pipe(v.string('Paste the API key.'), v.trim(), v.minLength(20, 'Paste the whole API key.'), v.maxLength(400, 'That is longer than an API key.'),
      v.regex(/^[\x21-\x7e]+$/, 'Paste the API key without spaces.'),
      // `claude setup-token` makes `sk-ant-oat…` tokens. They belong to a Claude plan, which only Claude Code may use.
      v.check(key => !(provider === 'anthropic' && key.startsWith('sk-ant-oat')), 'That is a Claude plan token. Hosted agents need an API key; use your plan with a local agent.'),
      v.check(key => key.startsWith(PROVIDERS[provider].prefix), `${name(provider)} API keys start with ${PROVIDERS[provider].prefix}`)),
  }, 'Paste the API key.');
}
export const providerModel = v.object({ model: v.pipe(v.string('Choose a model.'), v.minLength(1, 'Choose a model.'), v.maxLength(200, 'Choose a model.')) }, 'Choose a model.');

/* ---------- storage ---------- */

interface Meta {
  version: string; model: string; models: string[]; connectedAt: string; lastUsedAt?: string;
  status: ProviderConnection['status']; failure?: ProviderFailureCode; limits?: ProviderLimit[]; checkedAt?: string;
}
const metaOf = (value: string) => JSON.parse(value) as Meta;
const RECORD_INTERVAL = 30_000;

/** The `provider_credentials` table inside the Security object; one key per person and provider. */
export class ProviderStore {
  constructor(private sql: SqlStorage, private env: Pick<BraidEnv, 'SESSION_SECRET'>) {
    sql.exec('CREATE TABLE IF NOT EXISTS provider_credentials (user_id TEXT NOT NULL, provider TEXT NOT NULL, secret TEXT NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (user_id, provider))');
  }
  private row(userId: string, provider: ProviderId) {
    return this.sql.exec<{ secret: string; meta: string }>('SELECT secret, meta FROM provider_credentials WHERE user_id = ? AND provider = ?', userId, provider).toArray()[0];
  }
  private write(userId: string, provider: ProviderId, meta: Meta) {
    this.sql.exec('UPDATE provider_credentials SET meta = ? WHERE user_id = ? AND provider = ?', JSON.stringify(meta), userId, provider);
  }
  list(userId: string): ProviderConnection[] {
    return this.sql.exec<{ provider: ProviderId; meta: string }>('SELECT provider, meta FROM provider_credentials WHERE user_id = ? ORDER BY provider', userId).toArray()
      .map(row => connection(row.provider, metaOf(row.meta)));
  }
  async save(userId: string, provider: ProviderId, key: string, models: string[], model: string, limits?: ProviderLimit[]): Promise<ProviderConnection> {
    const at = now();
    const meta: Meta = { version: crypto.randomUUID(), model, models, connectedAt: at, checkedAt: at, status: limited(limits) ? 'limited' : 'ready', ...(limits?.length ? { limits } : {}) };
    this.sql.exec('INSERT INTO provider_credentials (user_id, provider, secret, meta) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET secret = excluded.secret, meta = excluded.meta',
      userId, provider, await sealProviderKey(this.env, userId, provider, key), JSON.stringify(meta));
    return connection(provider, meta);
  }
  remove(userId: string, provider: ProviderId) {
    this.sql.exec('DELETE FROM provider_credentials WHERE user_id = ? AND provider = ?', userId, provider);
  }
  chooseModel(userId: string, provider: ProviderId, model: string): ProviderConnection {
    const row = this.row(userId, provider);
    if (!row) throw new HttpError(404, `Connect ${name(provider)} first.`);
    const meta = metaOf(row.meta);
    if (!meta.models.includes(model)) throw new HttpError(400, `${name(provider)} does not offer that model to this key.`);
    meta.model = model;
    this.write(userId, provider, meta);
    return connection(provider, meta);
  }
  /** What a new task with this provider runs: the person's chosen model and the version of the key it was chosen with. */
  choice(userId: string, provider: ProviderId): { model: string; version: string } {
    const row = this.row(userId, provider);
    if (!row) throw new HttpError(409, `Connect ${name(provider)} in Settings → Providers first.`);
    const meta = metaOf(row.meta);
    if (meta.status === 'rejected') throw new HttpError(409, `${name(provider)} rejected the saved key. Reconnect it in Settings → Providers.`);
    return { model: meta.model, version: meta.version };
  }
  /** The stored key, for its owner's check in Settings. */
  async key(userId: string, provider: ProviderId): Promise<string | null> {
    const row = this.row(userId, provider);
    return row ? openProviderKey(this.env, userId, provider, row.secret) : null;
  }
  /**
   * Lends a person's key to one model call of their own hosted run. The run names the owner and the key version it
   * started with, so a key removed, replaced or rejected since then is never used, and nobody else's key ever is.
   */
  async lease(ref: HostedProvider): Promise<ProviderLease | null> {
    const row = this.row(ref.owner, ref.id);
    if (!row) return null;
    const meta = metaOf(row.meta);
    if (meta.version !== ref.version || meta.status === 'rejected') return null;
    const key = await openProviderKey(this.env, ref.owner, ref.id, row.secret);
    return key ? { key, model: meta.model, version: meta.version } : null;
  }
  /** Records how a call with a key went. A replaced key keeps its own record; writes are spaced while nothing changes. */
  record(ref: HostedProvider, outcome: ProviderOutcome) {
    const row = this.row(ref.owner, ref.id);
    if (!row) return;
    const meta = metaOf(row.meta);
    if (meta.version !== ref.version) return;
    const next = afterOutcome(meta, outcome);
    if (outcome.ok && next.status === meta.status && !meta.failure && meta.lastUsedAt && Date.now() - Date.parse(meta.lastUsedAt) < RECORD_INTERVAL) return;
    this.write(ref.owner, ref.id, { ...next, lastUsedAt: now() });
  }
  /** Records the owner's check of a key in Settings: the provider's current answer about it. */
  checked(userId: string, provider: ProviderId, outcome: ProviderOutcome, models?: string[]): ProviderConnection | null {
    const row = this.row(userId, provider);
    if (!row) return null;
    const meta = metaOf(row.meta);
    const next: Meta = { ...afterOutcome(meta, outcome), checkedAt: now() };
    if (models?.length) { next.models = models; if (!models.includes(next.model)) next.model = models[0]; }
    this.write(userId, provider, next);
    return connection(provider, next);
  }
}
const limited = (limits?: ProviderLimit[]) => !!limits?.some(limit => limit.kind === 'credit' && limit.remaining <= 0);
function afterOutcome({ failure: _failure, ...meta }: Meta, outcome: ProviderOutcome): Meta {
  const status = !outcome.ok && outcome.code === 'auth' ? 'rejected' : (!outcome.ok && (outcome.code === 'quota' || outcome.code === 'rate_limit')) || limited(outcome.limits) ? 'limited' : 'ready';
  return { ...meta, status, ...(outcome.limits?.length ? { limits: outcome.limits } : {}), ...(outcome.ok ? {} : { failure: outcome.code }) };
}
function connection(provider: ProviderId, meta: Meta): ProviderConnection {
  return {
    provider, model: meta.model, models: meta.models, connectedAt: meta.connectedAt, status: meta.status,
    ...(meta.lastUsedAt ? { lastUsedAt: meta.lastUsedAt } : {}), ...(meta.failure ? { error: settingsText[meta.failure] } : {}),
    ...(meta.limits?.length ? { limits: meta.limits } : {}), ...(meta.checkedAt ? { checkedAt: meta.checkedAt } : {}),
  };
}
