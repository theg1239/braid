import { DurableObject } from 'cloudflare:workers';
import { directoryOf, type BraidEnv } from '../env';
import type { AccountIdentity } from '../../shared/account';
import type { AgentScope } from '../../shared/types';
import { exchangeGitHubToken, openGitHub, sealGitHub, type GitHubCredentials } from '../github/client';
import { digest } from '../http/auth';
import { MCP_ACCESS_LIFETIME, verifyAccess, verifyMcpAccess } from '../http/agent-token';
import { HttpError, logFailure, refused, type Refusal } from '../errors';
import type { GitHubIdentity } from '../repositories/provenance';
import { ProviderFailure, ProviderStore, type HostedProvider, type ProviderOutcome } from '../agents/providers';
import { checkProviderKey } from '../agents/provider-client';
import { PROVIDERS, type ProviderConnection, type ProviderId } from '../../shared/providers';
import { now } from '../workspace/domain';
interface StoredPasskey { id: string; userId: string; publicKey: string; counter: number; transports: string[]; createdAt: string }
/** `client` names the OAuth client a grant was authorized for; such a grant has no connection token, only refresh tokens. */
export interface AgentGrant { id: string; user: AccountIdentity; workspaceId: string; scope: AgentScope; label: string; expires: number; client?: string }
/** A client that registered itself (RFC 7591). A confidential one keeps only the digest of its secret. */
export interface OAuthClient { id: string; name: string; redirectUris: string[]; authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'; grantTypes: string[]; secretDigest?: string; createdAt: number }
/** What a person approved, bound to the client, its redirect, its PKCE challenge and the MCP resource. */
export interface OAuthCode { clientId: string; redirectUri: string; challenge: string; resource: string; scope: 'read' | 'work'; user: AccountIdentity; workspaceId: string; label: string; refresh: boolean }
/** An OAuth grant lasts this long after it was approved or last refreshed. */
export const OAUTH_GRANT_MS = 30 * 86_400_000;
const OAUTH_CODE_MS = 5 * 60_000;
/** A registered client is kept a day until it is first used, then for 90 days after each use. */
const OAUTH_CLIENT_UNUSED_MS = 86_400_000, OAUTH_CLIENT_MS = 90 * 86_400_000;
/** At most this many unused refresh tokens per grant; older ones retire. */
const OAUTH_OPEN_REFRESHES = 4;
interface GitHubImportGrant { user: AccountIdentity; workspaceId: string; repositoryId: number; fullName: string; token: string; expires: number; mirror?: boolean }

const refreshable = (credentials: GitHubCredentials): credentials is GitHubCredentials & { refreshToken: string } =>
  !!credentials.refreshToken && (credentials.refreshExpiresAt ?? 0) > Date.now();

/** Durable revocation and shared request budgets for public team accounts. */
export class Security extends DurableObject<BraidEnv> {
  private githubRefreshes = new Map<string, Promise<string>>();
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS budgets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS identities (digest TEXT PRIMARY KEY, value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth (digest TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL)');
    // Empty means no verified email. The old UNIQUE constraint admitted only one such identity.
    if (ctx.storage.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'profiles'").one().sql.includes('email TEXT NOT NULL UNIQUE')) ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec('CREATE TABLE profiles_next (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL)');
      ctx.storage.sql.exec('INSERT INTO profiles_next SELECT id, email, name FROM profiles');
      ctx.storage.sql.exec('DROP TABLE profiles');
      ctx.storage.sql.exec('ALTER TABLE profiles_next RENAME TO profiles');
      ctx.storage.sql.exec("CREATE UNIQUE INDEX profiles_verified_email ON profiles(email) WHERE email <> ''");
    });
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS external_accounts (external_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS devices (digest TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL, polled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, grant_value TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_grants (digest TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS compromised_grants (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS security_audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS github_connections (user_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS github_imports (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL)');
    // The GitHub account each person signed in or connected with, which names them in commits by its no-reply address.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS github_identities (user_id TEXT PRIMARY KEY, github_id INTEGER NOT NULL, login TEXT NOT NULL, source TEXT NOT NULL)');
    // OAuth for MCP clients: registered clients, single-use codes, and refresh tokens by state ('current', 'previous', 'retired').
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_codes (digest TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL, grant_id TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_refresh (digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS oauth_refresh_grant ON oauth_refresh(grant_id)');
  }
  /**
   * Records a person's GitHub account, read together from one GitHub answer. Signing in with GitHub names the
   * account; connecting GitHub for repositories only fills it in when the person has none yet.
   */
  recordGitHubIdentity(userId: string, github: GitHubIdentity, source: 'sign-in' | 'connection') {
    this.ctx.storage.sql.exec(source === 'sign-in'
      ? 'INSERT INTO github_identities (user_id, github_id, login, source) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login, source = excluded.source'
      : 'INSERT INTO github_identities (user_id, github_id, login, source) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING', userId, github.id, github.login, source);
  }
  githubIdentity(userId: string): GitHubIdentity | null {
    const row = this.ctx.storage.sql.exec<{ github_id: number; login: string }>('SELECT github_id, login FROM github_identities WHERE user_id = ?', userId).toArray()[0];
    return row ? { id: row.github_id, login: row.login } : null;
  }
  async connectGitHub(userId: string, credentials: GitHubCredentials) {
    const value = await sealGitHub(this.env, `user:${userId}`, credentials);
    this.ctx.storage.sql.exec('INSERT INTO github_connections (user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value', userId, value);
  }
  private async githubCredentials(userId: string): Promise<{ value: string; credentials: GitHubCredentials } | null> {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM github_connections WHERE user_id = ?', userId).toArray()[0];
    return row ? { value: row.value, credentials: await openGitHub<GitHubCredentials>(this.env, `user:${userId}`, row.value) } : null;
  }
  async githubConnection(userId: string): Promise<{ login: string } | null> {
    // A connection sealed under an earlier session secret cannot be opened, which reads as none until the person reconnects.
    const stored = await this.githubCredentials(userId).catch((error: unknown) => { if (error instanceof HttpError) return null; throw error; });
    if (!stored || (stored.credentials.expiresAt <= Date.now() && !refreshable(stored.credentials))) return null;
    return { login: stored.credentials.login };
  }
  disconnectGitHub(userId: string) {
    this.ctx.storage.sql.exec('DELETE FROM github_connections WHERE user_id = ?', userId);
    this.ctx.storage.sql.exec('DELETE FROM github_imports WHERE user_id = ?', userId);
    this.ctx.storage.sql.exec("DELETE FROM github_identities WHERE user_id = ? AND source = 'connection'", userId);
  }
  async githubAccessToken(userId: string): Promise<{ ok: true; token: string } | Refusal> {
    const run = this.githubRefreshes.get(userId) ?? this.refreshGitHub(userId);
    this.githubRefreshes.set(userId, run);
    try { return { ok: true, token: await run }; }
    catch (error) { return refused(error, 502, 'The GitHub connection could not be refreshed.'); }
    finally { if (this.githubRefreshes.get(userId) === run) this.githubRefreshes.delete(userId); }
  }
  private async refreshGitHub(userId: string): Promise<string> {
    const stored = await this.githubCredentials(userId);
    if (!stored) throw new HttpError(409, 'Connect GitHub to choose a repository.');
    const previous = stored.credentials;
    if (previous.expiresAt > Date.now() + 60_000) return previous.accessToken;
    if (!refreshable(previous)) throw new HttpError(409, 'Reconnect GitHub to continue.');
    const updated = await exchangeGitHubToken(this.env, { grant_type: 'refresh_token', refresh_token: previous.refreshToken }, previous.login);
    const sealed = await sealGitHub(this.env, `user:${userId}`, updated);
    // A sign-out of this connection or a newer authorization wins over an in-flight refresh.
    const current = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM github_connections WHERE user_id = ?', userId).toArray()[0];
    if (current?.value !== stored.value) throw new HttpError(409, 'The GitHub connection changed. Try again.');
    this.ctx.storage.sql.exec('UPDATE github_connections SET value = ? WHERE user_id = ?', sealed, userId);
    return updated.accessToken;
  }
  async issueGitHubImport(hash: string, grant: GitHubImportGrant) {
    const sealed = await sealGitHub(this.env, `import:${hash}`, grant);
    this.ctx.storage.sql.exec('INSERT INTO github_imports (digest, user_id, workspace_id, value, expires) VALUES (?, ?, ?, ?, ?)', hash, grant.user.id, grant.workspaceId, sealed, grant.expires);
    await this.scheduleCleanup();
  }
  async githubImport(hash: string): Promise<GitHubImportGrant | null> {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM github_imports WHERE digest = ? AND expires > ?', hash, Date.now()).toArray()[0];
    return row ? openGitHub<GitHubImportGrant>(this.env, `import:${hash}`, row.value) : null;
  }
  finishGitHubImports(workspaceId: string) { this.ctx.storage.sql.exec('DELETE FROM github_imports WHERE workspace_id = ?', workspaceId); }
  async issue(digest: string, expires: number, identity?: AccountIdentity) {
    if (identity && this.env.DIRECTORY) await directoryOf(this.env).recordPerson(identity.id);
    this.ctx.storage.sql.exec('INSERT INTO sessions (digest, expires) VALUES (?, ?)', digest, expires);
    if (identity) this.ctx.storage.sql.exec('INSERT INTO identities (digest, value) VALUES (?, ?)', digest, JSON.stringify(identity));
    await this.scheduleCleanup();
  }
  valid(digest: string) {
    return this.ctx.storage.sql.exec('SELECT digest FROM sessions WHERE digest = ? AND expires > ?', digest, Date.now()).toArray().length === 1;
  }
  identity(digest: string): AccountIdentity | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT i.value FROM identities i JOIN sessions s ON s.digest = i.digest WHERE s.digest = ? AND s.expires > ?', digest, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  revoke(digest: string) {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE digest = ?', digest);
    this.ctx.storage.sql.exec('DELETE FROM identities WHERE digest = ?', digest);
  }
  async beginOAuth(digest: string, verifier: string) {
    this.ctx.storage.sql.exec('INSERT INTO oauth (digest, verifier, expires) VALUES (?, ?, ?)', digest, verifier, Date.now() + 600_000);
    await this.scheduleCleanup();
  }
  takeOAuth(digest: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ verifier: string; expires: number }>('SELECT verifier, expires FROM oauth WHERE digest = ?', digest).toArray()[0];
      this.ctx.storage.sql.exec('DELETE FROM oauth WHERE digest = ?', digest);
      return row && row.expires > Date.now() ? row.verifier : null;
    });
  }
  profile(external: AccountIdentity): AccountIdentity {
    return this.ctx.storage.transactionSync(() => {
      const linked = this.ctx.storage.sql.exec<{ id: string; email: string; name: string }>('SELECT p.id, p.email, p.name FROM profiles p JOIN external_accounts e ON e.user_id = p.id WHERE e.external_id = ?', external.id).toArray()[0];
      if (linked) return linked;
      // Both callers have just verified ownership of this email through GitHub or a one-time code.
      let user = external.email ? this.ctx.storage.sql.exec<{ id: string; email: string; name: string }>('SELECT id, email, name FROM profiles WHERE email = ?', external.email).toArray()[0] : undefined;
      if (!user) {
        user = { id: crypto.randomUUID(), email: external.email, name: external.name };
        this.ctx.storage.sql.exec('INSERT INTO profiles (id, email, name) VALUES (?, ?, ?)', user.id, user.email, user.name);
      }
      this.ctx.storage.sql.exec('INSERT INTO external_accounts (external_id, user_id) VALUES (?, ?)', external.id, user.id);
      return user;
    });
  }
  profileById(id: string): AccountIdentity | null {
    return this.ctx.storage.sql.exec<{ id: string; email: string; name: string }>('SELECT id, email, name FROM profiles WHERE id = ?', id).toArray()[0] ?? null;
  }
  async challenge(id: string, value: string, expires: number) {
    this.ctx.storage.sql.exec('INSERT INTO challenges (id, value, expires) VALUES (?, ?, ?)', id, value, expires);
    await this.scheduleCleanup();
  }
  takeChallenge(id: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>('SELECT value, expires FROM challenges WHERE id = ?', id).toArray()[0];
      this.ctx.storage.sql.exec('DELETE FROM challenges WHERE id = ?', id);
      return row && row.expires > Date.now() ? row.value : null;
    });
  }
  verifyEmail(id: string, codeDigest: string): string | null {
    return this.takeEmailCode(id, codeDigest, 'email')?.email ?? null;
  }
  /**
   * A code an agent was given for a person's email, taken on a match within five attempts. The caller puts it back
   * with `challenge` when no connection could follow, so the person need not read a new code.
   */
  takeAgentEmail(id: string, codeDigest: string): { email: string; scope: Exclude<AgentScope, 'fleet'>; value: string; expires: number } | null {
    const taken = this.takeEmailCode(id, codeDigest, 'agent');
    return taken && { email: taken.email, scope: taken.scope!, value: taken.value, expires: taken.expires };
  }
  private takeEmailCode(id: string, codeDigest: string, kind: 'email' | 'agent') {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ value: string; expires: number; attempts: number }>('SELECT value, expires, attempts FROM challenges WHERE id = ?', id).toArray()[0];
      if (!row || row.expires <= Date.now() || row.attempts >= 5) return null;
      this.ctx.storage.sql.exec('UPDATE challenges SET attempts = attempts + 1 WHERE id = ?', id);
      const value = JSON.parse(row.value) as { kind: string; email: string; digest: string; scope?: Exclude<AgentScope, 'fleet'> };
      if (value.kind !== kind || value.digest !== codeDigest) return null;
      this.ctx.storage.sql.exec('DELETE FROM challenges WHERE id = ?', id);
      return { email: value.email, scope: value.scope, value: row.value, expires: row.expires };
    });
  }
  passkeys(userId: string): StoredPasskey[] {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM passkeys WHERE user_id = ?', userId).toArray().map(row => JSON.parse(row.value));
  }
  passkey(id: string): StoredPasskey | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM passkeys WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  addPasskey(key: StoredPasskey): boolean {
    if (this.passkeys(key.userId).length >= 10 || this.passkey(key.id)) return false;
    this.ctx.storage.sql.exec('INSERT INTO passkeys (id, user_id, value) VALUES (?, ?, ?)', key.id, key.userId, JSON.stringify(key));
    return true;
  }
  advancePasskey(id: string, prior: number, counter: number): boolean {
    const key = this.passkey(id);
    if (!key || key.counter !== prior || counter < prior) return false;
    key.counter = counter;
    this.ctx.storage.sql.exec('UPDATE passkeys SET value = ? WHERE id = ?', JSON.stringify(key), id);
    return true;
  }
  removePasskey(userId: string, id: string) { this.ctx.storage.sql.exec('DELETE FROM passkeys WHERE id = ? AND user_id = ?', id, userId); }
  async startDevice(hash: string, code: string, label: string, scope: AgentScope) {
    this.ctx.storage.sql.exec("INSERT INTO devices (digest, code, label, scope, expires, status) VALUES (?, ?, ?, ?, ?, 'pending')", hash, code, label, scope, Date.now() + 600_000);
    await this.scheduleCleanup();
  }
  device(code: string): { label: string; scope: AgentScope; expires: number } | null {
    return this.ctx.storage.sql.exec<{ label: string; scope: AgentScope; expires: number }>("SELECT label, scope, expires FROM devices WHERE code = ? AND status = 'pending' AND expires > ?", code, Date.now()).toArray()[0] ?? null;
  }
  approveDevice(code: string, grant: AgentGrant): boolean {
    const request = this.device(code);
    if (!request || (grant.scope !== 'read' && grant.scope !== request.scope)) return false;
    this.ctx.storage.sql.exec("UPDATE devices SET status = 'approved', grant_value = ? WHERE code = ?", JSON.stringify({ ...grant, label: request.label }), code);
    return true;
  }
  denyDevice(code: string) { this.ctx.storage.sql.exec("UPDATE devices SET status = 'denied' WHERE code = ? AND status = 'pending'", code); }
  takeDevice(hash: string): { status: string; grant: string | null } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ expires: number; polled: number; status: string; grant_value: string | null }>('SELECT expires, polled, status, grant_value FROM devices WHERE digest = ?', hash).toArray()[0];
      if (!row || row.expires <= Date.now() || row.status === 'consumed') return { status: 'expired', grant: null };
      if (row.polled > Date.now() - 5000) return { status: 'slow_down', grant: null };
      this.ctx.storage.sql.exec('UPDATE devices SET polled = ? WHERE digest = ?', Date.now(), hash);
      if (row.status !== 'approved') return { status: row.status, grant: null };
      this.ctx.storage.sql.exec("UPDATE devices SET status = 'consumed', grant_value = NULL WHERE digest = ?", hash);
      return { status: 'approved', grant: row.grant_value };
    });
  }
  async issueAgent(hash: string, grant: AgentGrant) {
    this.ctx.storage.sql.exec('INSERT INTO agent_grants (digest, id, user_id, value, expires) VALUES (?, ?, ?, ?, ?)', hash, grant.id, grant.user.id, JSON.stringify(grant), grant.expires);
    await this.scheduleCleanup();
  }
  agent(hash: string): AgentGrant | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM agent_grants WHERE digest = ? AND expires > ?', hash, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  agents(userId: string): Omit<AgentGrant, 'user'>[] {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM agent_grants WHERE user_id = ? AND expires > ?', userId, Date.now()).toArray().map(row => {
      const { user: _user, ...grant } = JSON.parse(row.value) as AgentGrant; return grant;
    });
  }
  revokeAgent(userId: string, id: string) {
    this.ctx.storage.transactionSync(() => {
      const grant = this.ctx.storage.sql.exec<{ expires: number }>('SELECT expires FROM agent_grants WHERE user_id = ? AND id = ?', userId, id).toArray()[0];
      if (grant) this.retireGrant(id, grant.expires);
    });
  }
  private grantById(id: string): AgentGrant | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM agent_grants WHERE id = ? AND expires > ?', id, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  /** Ends a grant with its connection or refresh tokens. The access tokens it issued stay refused while any could be valid. */
  private retireGrant(id: string, expires: number) {
    this.ctx.storage.sql.exec('DELETE FROM agent_grants WHERE id = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM oauth_refresh WHERE grant_id = ?', id);
    // Cover issued tokens and any exchange already in flight, whose expiry is bounded by this grant or by an OAuth token's hour.
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO compromised_grants (id, expires) VALUES (?, ?)', id, Math.max(expires, Date.now() + MCP_ACCESS_LIFETIME));
  }
  /** A matched live token revokes its entire connection, including already minted access tokens, across workspaces. */
  async revokeLeakedToken(token: string): Promise<{ id: string; workspaceId: string } | null> {
    // An access token names its grant; a refresh token is found by its digest, and any other secret is a connection's.
    const claims = await verifyAccess(this.env, token) ?? await verifyMcpAccess(this.env, token);
    const hash = await digest(token);
    const refreshed = claims ? undefined : this.ctx.storage.sql.exec<{ grantId: string }>('SELECT grant_id AS grantId FROM oauth_refresh WHERE digest = ?', hash).toArray()[0];
    const grant = claims ? { id: claims.grant, workspaceId: claims.workspace, expires: claims.exp } : refreshed ? this.grantById(refreshed.grantId) : this.agent(hash);
    if (!grant || this.accessRevoked(grant.id)) return null;
    this.ctx.storage.transactionSync(() => {
      this.retireGrant(grant.id, grant.expires);
      this.ctx.storage.sql.exec("INSERT INTO security_audit (action, target, workspace_id, created_at) VALUES ('agent.secret-revoked', ?, ?, ?)", grant.id, grant.workspaceId, now());
    });
    if (this.env.DIRECTORY) await directoryOf(this.env).repositorySecurityEvent(grant.workspaceId, 'agent.secret-revoked', grant.id);
    return { id: grant.id, workspaceId: grant.workspaceId };
  }
  /*
   * OAuth for MCP clients (worker/http/oauth.ts). An approval becomes an agent grant like a device approval's, with
   * refresh tokens in place of a connection token. Codes and tokens are kept only as SHA-256 digests.
   */
  async registerOAuthClient(client: OAuthClient) {
    this.ctx.storage.sql.exec('INSERT INTO oauth_clients (id, value, expires) VALUES (?, ?, ?)', client.id, JSON.stringify(client), Date.now() + OAUTH_CLIENT_UNUSED_MS);
    await this.scheduleCleanup();
  }
  oauthClient(id: string): OAuthClient | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM oauth_clients WHERE id = ? AND expires > ?', id, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  private useClient(id: string) {
    this.ctx.storage.sql.exec('UPDATE oauth_clients SET expires = MAX(expires, ?) WHERE id = ?', Date.now() + OAUTH_CLIENT_MS, id);
  }
  async issueOAuthCode(hash: string, code: OAuthCode) {
    this.ctx.storage.sql.exec('INSERT INTO oauth_codes (digest, value, expires) VALUES (?, ?, ?)', hash, JSON.stringify(code), Date.now() + OAUTH_CODE_MS);
    await this.scheduleCleanup();
  }
  /**
   * Exchanges a code once. Any presentation spends it, and a second one revokes the grant the first made (OAuth 2.1
   * section 4.1.3). A token request without a resource means the code's own. `refresh` is the first refresh token's digest.
   */
  redeemOAuthCode(hash: string, presented: { clientId: string; redirectUri: string; challenge: string; resource?: string }, issued: { id: string; refresh: string }): { ok: true; grant: AgentGrant; refresh: boolean } | { ok: false } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ value: string; expires: number; grantId: string | null }>('SELECT value, expires, grant_id AS grantId FROM oauth_codes WHERE digest = ?', hash).toArray()[0];
      if (!row || row.expires <= Date.now()) return { ok: false };
      if (row.grantId !== null) {
        if (row.grantId) this.retireGrant(row.grantId, this.grantById(row.grantId)?.expires ?? 0);
        return { ok: false };
      }
      const code = JSON.parse(row.value) as OAuthCode;
      const matches = code.clientId === presented.clientId && code.redirectUri === presented.redirectUri && code.challenge === presented.challenge
        && (presented.resource === undefined || presented.resource === code.resource);
      this.ctx.storage.sql.exec('UPDATE oauth_codes SET grant_id = ? WHERE digest = ?', matches ? issued.id : '', hash);
      if (!matches) return { ok: false };
      const grant: AgentGrant = { id: issued.id, user: code.user, workspaceId: code.workspaceId, scope: code.scope, label: code.label, expires: Date.now() + OAUTH_GRANT_MS, client: code.clientId };
      this.ctx.storage.sql.exec('INSERT INTO agent_grants (digest, id, user_id, value, expires) VALUES (?, ?, ?, ?, ?)', `oauth:${grant.id}`, grant.id, grant.user.id, JSON.stringify(grant), grant.expires);
      if (code.refresh) this.ctx.storage.sql.exec("INSERT INTO oauth_refresh (digest, grant_id, state, expires) VALUES (?, ?, 'current', ?)", issued.refresh, grant.id, grant.expires);
      this.useClient(code.clientId);
      return { ok: true, grant, refresh: code.refresh };
    });
  }
  /**
   * Rotates a refresh token. The token before the newest stays usable until the newest is used, so a client whose
   * answer was lost can retry. A retired token, or one another client presents, has been copied and ends the grant.
   * Each refresh moves the grant's expiry forward.
   */
  refreshOAuth(hash: string, clientId: string, issued: string): { ok: true; grant: AgentGrant } | { ok: false } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ grantId: string; state: 'current' | 'previous' | 'retired'; expires: number }>('SELECT grant_id AS grantId, state, expires FROM oauth_refresh WHERE digest = ?', hash).toArray()[0];
      if (!row || row.expires <= Date.now()) return { ok: false };
      const grant = this.grantById(row.grantId);
      if (!grant || this.accessRevoked(grant.id)) return { ok: false };
      if (row.state === 'retired' || grant.client !== clientId) { this.retireGrant(grant.id, grant.expires); return { ok: false }; }
      if (row.state === 'current') {
        this.ctx.storage.sql.exec("UPDATE oauth_refresh SET state = 'retired' WHERE grant_id = ? AND digest != ?", grant.id, hash);
        this.ctx.storage.sql.exec("UPDATE oauth_refresh SET state = 'previous' WHERE digest = ?", hash);
      }
      const expires = Date.now() + OAUTH_GRANT_MS;
      this.ctx.storage.sql.exec("INSERT INTO oauth_refresh (digest, grant_id, state, expires) VALUES (?, ?, 'current', ?)", issued, grant.id, expires);
      // Each retry of the previous token opens another; only the newest few stay usable.
      this.ctx.storage.sql.exec("UPDATE oauth_refresh SET state = 'retired' WHERE grant_id = ? AND state = 'current' AND digest NOT IN (SELECT digest FROM oauth_refresh WHERE grant_id = ? AND state = 'current' ORDER BY rowid DESC LIMIT ?)", grant.id, grant.id, OAUTH_OPEN_REFRESHES);
      this.ctx.storage.sql.exec("UPDATE oauth_refresh SET expires = ? WHERE grant_id = ? AND state != 'retired'", expires, grant.id);
      const renewed = { ...grant, expires };
      this.ctx.storage.sql.exec('UPDATE agent_grants SET value = ?, expires = ? WHERE id = ?', JSON.stringify(renewed), expires, grant.id);
      this.useClient(clientId);
      return { ok: true, grant: renewed };
    });
  }
  /** RFC 7009: a refresh token, or an access token's grant, ends the whole grant, only for the client it was issued to. */
  revokeOAuth(token: { refresh: string } | { grant: string }, clientId: string) {
    this.ctx.storage.transactionSync(() => {
      const id = 'grant' in token ? token.grant
        : this.ctx.storage.sql.exec<{ grantId: string }>('SELECT grant_id AS grantId FROM oauth_refresh WHERE digest = ?', token.refresh).toArray()[0]?.grantId;
      const grant = id ? this.grantById(id) : null;
      if (grant?.client === clientId) this.retireGrant(grant.id, grant.expires);
    });
  }
  accessRevoked(grant: string): boolean {
    return this.ctx.storage.sql.exec('SELECT id FROM compromised_grants WHERE id = ? AND expires > ?', grant, Date.now()).toArray().length > 0;
  }
  /*
   * Model provider keys, sealed per person and provider (worker/agents/providers.ts). Keys are checked with the provider
   * here and lent only to model calls of their owner's hosted runs; no method returns one to a caller outside Braid.
   */
  private providerKeys = new ProviderStore(this.ctx.storage.sql, this.env);
  providers(userId: string): ProviderConnection[] { return this.providerKeys.list(userId); }
  async connectProvider(userId: string, provider: ProviderId, key: string): Promise<{ ok: true; connection: ProviderConnection } | Refusal> {
    try {
      const { models, model, limits } = await checkProviderKey(provider, key);
      return { ok: true, connection: await this.providerKeys.save(userId, provider, key, models, model, limits) };
    } catch (error) {
      logFailure('provider_key_refused', error, { provider });
      return { ok: false, ...keyRefusal(provider, error) };
    }
  }
  /** Asks the provider about the saved key again, for its owner. */
  async checkProvider(userId: string, provider: ProviderId): Promise<ProviderConnection | null> {
    const key = await this.providerKeys.key(userId, provider);
    if (key === null) return null;
    try {
      const { models, limits } = await checkProviderKey(provider, key);
      return this.providerKeys.checked(userId, provider, { ok: true, limits }, models);
    } catch (error) {
      logFailure('provider_key_refused', error, { provider });
      return this.providerKeys.checked(userId, provider, { ok: false, code: error instanceof ProviderFailure ? error.code : 'unavailable' });
    }
  }
  chooseProviderModel(userId: string, provider: ProviderId, model: string): { ok: true; connection: ProviderConnection } | Refusal {
    try { return { ok: true, connection: this.providerKeys.chooseModel(userId, provider, model) }; }
    catch (error) { return refused(error, 500, 'The model could not be saved.'); }
  }
  disconnectProvider(userId: string, provider: ProviderId) { this.providerKeys.remove(userId, provider); }
  /** What a new task with this person's provider runs; an error says how to connect it. */
  providerChoice(userId: string, provider: ProviderId): { ok: true; model: string; version: string } | { ok: false; error: string } {
    try { return { ok: true, ...this.providerKeys.choice(userId, provider) }; }
    catch (error) { return { ok: false, error: refused(error).error }; }
  }
  leaseProvider(ref: HostedProvider) { return this.providerKeys.lease(ref); }
  recordProviderUse(ref: HostedProvider, outcome: ProviderOutcome) { this.providerKeys.record(ref, outcome); }
  async consume(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const result = this.ctx.storage.transactionSync(() => {
      const time = Date.now();
      const row = this.ctx.storage.sql.exec<{ used: number; expires: number }>('SELECT used, expires FROM budgets WHERE key = ?', key).toArray()[0];
      if (row && row.expires > time && row.used >= limit) return { allowed: false, retryAfter: Math.ceil((row.expires - time) / 1000) };
      const expires = row && row.expires > time ? row.expires : time + windowMs;
      const used = row && row.expires > time ? row.used + 1 : 1;
      this.ctx.storage.sql.exec('INSERT INTO budgets (key, used, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET used = excluded.used, expires = excluded.expires', key, used, expires);
      return { allowed: true, retryAfter: 0 };
    });
    await this.scheduleCleanup();
    return result;
  }
  /** An address shares a budget, never a session: separate browsers on one network must not share comments or decisions. */
  async exampleSession(address: string, token: string, limit: number, windowMs: number): Promise<{ token: string } | { retryAfter: number }> {
    const budget = await this.consume(`demo:${address}`, limit, windowMs);
    return budget.allowed ? { token } : { retryAfter: budget.retryAfter };
  }
  private async scheduleCleanup() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
  async alarm() {
    const time = Date.now();
    const tables = ['sessions', 'compromised_grants', 'budgets', 'oauth', 'challenges', 'devices', 'agent_grants', 'github_imports', 'oauth_clients', 'oauth_codes', 'oauth_refresh'];
    for (const table of tables) this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE expires <= ?`, time);
    this.ctx.storage.sql.exec('DELETE FROM identities WHERE digest NOT IN (SELECT digest FROM sessions)');
    const remaining = this.ctx.storage.sql.exec<{ count: number }>(`SELECT ${tables.filter(table => table !== 'compromised_grants').map(table => `(SELECT COUNT(*) FROM ${table})`).join(' + ')} AS count`).one().count;
    if (remaining) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}

/** Why a provider refused a key someone is connecting, in Braid's words. */
function keyRefusal(provider: ProviderId, error: unknown): { status: number; error: string } {
  const name = PROVIDERS[provider].name;
  if (error instanceof HttpError) return { status: error.status, error: error.message };
  const code = error instanceof ProviderFailure ? error.code : 'unavailable';
  if (code === 'auth') return { status: 400, error: `${name} rejected this key. Check that you pasted the whole key and that it is active.` };
  if (code === 'forbidden') return { status: 400, error: `${name} accepted the key but refused to list its models. Give the key permission to use models.` };
  if (code === 'quota') return { status: 400, error: `${name} reports no credit for this key. Add credit, then connect again.` };
  if (code === 'rate_limit') return { status: 429, error: `${name} is rate-limiting this key. Try again in a minute.` };
  // Anthropic answers 400 to a key that can act on several workspaces without naming one, and to a workspace at its spend limit.
  if (provider === 'anthropic' && code === 'invalid' && error instanceof ProviderFailure && error.status === 400)
    return { status: 400, error: 'Anthropic refused requests from this key. Use a key created inside a workspace, and check that workspace’s spend limit.' };
  if (code === 'invalid') return { status: 502, error: `${name} answered in a way Braid could not read. Try again shortly.` };
  return { status: 502, error: `${name} could not be reached. Try again shortly.` };
}
