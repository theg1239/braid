import { DurableObject } from 'cloudflare:workers';
import type { AccountIdentity, RepositoryWorkspace, Organization, OrganizationInvite, OrganizationMember, OrganizationRole, OwnerKind, Visibility, RepositoryAddress, OrganizationTeam, TeamRole, TeamDetail, RepositoryPermission, RepositoryAccess, NotificationKind, NotificationPreferences } from '../../shared/account';
import type { OwnerRepositories } from '../../shared/owners';
import type { ProvenanceOwner } from '../../shared/types';
import { githubLogin } from '../../shared/people';
import type { RepositoryCursor, RepositoryPage, RepositorySearch } from '../../shared/repositories';
import { redactPublicText } from '../../shared/privacy';
import { RESERVED_OWNERS, SLUG, slugOf, usernameSuggestion } from '../../shared/routes';
import { securityOf, type BraidEnv } from '../env';
import { digest } from '../http/auth';
import { PUBLIC_READ_TTL, waitForPublicReads } from '../http/public-access';
import { HttpError, logFailure, refusal, refused, type Refusal, type Result } from '../errors';
import { encodeCursor } from '../schemas';
import { isAgent, personHandle, personName, type GitHubIdentity } from '../repositories/provenance';
import { NOTIFICATION_DELAY, NOTIFICATION_HOURLY_LIMIT, notificationText, sendPullRequestEmail, type NotificationItem, type PullRequestNotification } from './notify';
import { githubAccount, githubClaimProof, publicMirrorSource, privateMirrorRepository, mirrorSource, mirrorNamespaceProof, mirrorNotFound, mirrorFrozen, mirrorTooLarge, MIRROR_FROZEN_CODE, MIRROR_NOT_FOUND_CODE, MIRROR_DAILY_LIMIT, MIRROR_NETWORK_LIMIT, MIRROR_SYNC_MS, MIRROR_LARGE, MIRROR_TOTAL_BYTES, MIRROR_NAMESPACE_CHANGED, type MirrorRecord, type ClaimProof } from '../github/mirrors';
import { now } from '../workspace/domain';
import { addColumn } from '../sql';
import { repositoryKey } from '../changes/names';

const searchText = (text: string) => redactPublicText(text).toLowerCase();

/** Each account action and its input. Inputs are parsed where requests arrive, so this object trusts their shape. */
export interface DirectoryInput {
  list: Record<string, never>;
  username: { username: string };
  teams: { orgId: string };
  team: { orgId: string; teamId: string };
  createOrgTeam: { orgId: string; name: string; description?: string };
  updateOrgTeam: { orgId: string; teamId: string; name?: string; slug?: string; description?: string };
  deleteOrgTeam: { orgId: string; teamId: string };
  setTeamMember: { orgId: string; teamId: string; memberId: string; role: TeamRole };
  removeTeamMember: { orgId: string; teamId: string; memberId: string };
  setTeamRepository: { orgId: string; teamId: string; workspaceId: string; permission: RepositoryPermission };
  removeTeamRepository: { orgId: string; teamId: string; workspaceId: string };
  repositoryAccess: { orgId: string; workspaceId: string };
  createOrganization: { name: string };
  createTeam: { name: string; visibility?: Visibility };
  updateMember: { teamId: string; memberId: string; role: OrganizationRole };
  replaceInvite: { teamId: string; inviteId: string };
  updateTeam: { teamId: string; slug?: string; name?: string };
  createWorkspace: { teamId: string; name: string; visibility?: Visibility };
  updateWorkspace: { teamId: string; workspaceId: string; visibility?: Visibility; slug?: string; name?: string };
  authorize: { workspaceId: string; write: boolean };
  members: { teamId: string };
  invite: { teamId: string; email: string; role: OrganizationRole };
  accept: { token: string };
  revokeInvite: { teamId: string; inviteId: string };
  removeMember: { teamId: string; memberId: string };
  audit: { teamId: string; before: number };
}
type DirectoryRequest = { [A in keyof DirectoryInput]: { action: A } & DirectoryInput[A] }[keyof DirectoryInput];

type RepositoryGrant = { teamId: string; workspaceId: string; role: OrganizationRole; organizationRole: OrganizationRole; ownerSlug: string; repoSlug: string; readOnly?: boolean; privateMirror?: boolean };
type AddressOwner = { id: string; slug: string; kind: OwnerKind; userId: string | null; mirror: number; githubNamespace: string | null; githubKind: string | null; githubNamespaceId: number | null; githubLogin: string | null; githubId: number | null; pinned: number | null };
const repositoryNotFound = () => refusal(new HttpError(404, 'Repository not found.'));
/** A private repository is visible to its members, and a private mirror also to its GitHub readers, whose access `checkMirrorRead` proves. */
const hidden = (visibility: Visibility, member: boolean, mirror: MirrorRecord | null) => visibility === 'private' && !member && !mirror?.private;
const heldByOther = (holder: AddressOwner | undefined, proof: ClaimProof, userId: string | undefined) =>
  !!holder && (holder.pinned !== proof.namespaceId && !(holder.mirror && holder.pinned === null) || holder.kind === 'user' && holder.userId !== userId);

/** Authoritative organization and team membership. A workspace is selected only after this object authorizes it. */
/** Linking joins a Braid organization to a GitHub organization only, which an admin of it must claim. */
const linkProof = (proof: ClaimProof): ClaimProof => !proof.claimable || proof.kind === 'organization' ? { ...proof, link: true }
  : { claimable: false, link: true, reason: 'Only a GitHub organization can be linked to a Braid organization.' };

export class Directory extends DurableObject<BraidEnv> {
  private mirrorCreations = new Map<string, Promise<void>>();
  private mirrorTouches = new Map<string, number>();
  private claimingOwners = new Set<string>();
  constructor(ctx: DurableObjectState, env: BraidEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (team_id, user_id))');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS member_user ON members(user_id)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS workspace_team ON workspaces(team_id)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS public_people (user_id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS team_addresses (slug TEXT PRIMARY KEY, team_id TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS repository_addresses (team_id TEXT NOT NULL, slug TEXT NOT NULL, workspace_id TEXT NOT NULL, PRIMARY KEY (team_id, slug))');
    this.migrate();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mirrors (workspace TEXT PRIMARY KEY, full_name TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, synced_at TEXT, importing INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0, error TEXT)');
    for (const [column, type] of [['private', 'INTEGER NOT NULL DEFAULT 0'], ['repository_id', 'INTEGER'], ['bytes', 'INTEGER NOT NULL DEFAULT 0']]) addColumn(ctx.storage.sql, 'mirrors', column, type);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mirror_budgets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS github_members (team TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(team, user))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, accepted_by TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_receipts (workspace_id TEXT NOT NULL, change_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (workspace_id, change_id, revision, kind))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_outbox (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS notification_due ON notification_outbox(due)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS notification_group ON notification_outbox(user_id, workspace_id, kind, attempts, due)');
    if (env.WORKSPACES) ctx.waitUntil(this.migrateRepositoryReadiness());
  }
  private async protectNamespace(user: AccountIdentity, slug: string, existing?: string, kind?: OwnerKind): Promise<ClaimProof | null> {
    if (existing && this.ctx.storage.sql.exec('SELECT 1 FROM team_addresses WHERE team_id = ? AND slug = ? COLLATE NOCASE', existing, slug).toArray().length) return null;
    if (this.ownerAddressTaken(slug, existing)) throw new HttpError(409, 'An owner already has this slug.');
    const account = await githubAccount(this.env, user.id, slug);
    if (!account) return null;
    const proof = await githubClaimProof(this.env, user, slug, true);
    if (!proof.claimable || proof.namespaceId !== account.id || (kind === 'user' && proof.kind !== 'user')) throw new HttpError(403, proof.reason ?? 'This name belongs to a GitHub account. Prove ownership before using it in Braid.');
    return proof;
  }
  private pinNamespace(teamId: string, slug: string, proof: ClaimProof | null) { if (proof) this.ctx.storage.sql.exec('UPDATE teams SET github_namespace = ?, github_namespace_id = ?, github_kind = ? WHERE id = ?', slug, proof.namespaceId!, proof.kind!, teamId); }
  private mirrorOwner(slug: string): AddressOwner | undefined {
    return this.ctx.storage.sql.exec<AddressOwner>(
      'SELECT t.id, t.slug, t.kind, t.user_id AS userId, t.mirror, t.github_namespace AS githubNamespace, t.github_kind AS githubKind, t.github_namespace_id AS githubNamespaceId, u.github_login AS githubLogin, u.github_id AS githubId, COALESCE(t.github_namespace_id, u.github_id) AS pinned FROM teams t JOIN team_addresses a ON a.team_id = t.id LEFT JOIN users u ON u.id = t.user_id WHERE a.slug = ? COLLATE NOCASE', slug).toArray()[0];
  }
  /** An old address is not proof of the current namespace; unrelated grandfathered owners always win. */
  private mirrorNamespaceAllowed(slug: string): boolean {
    const owner = this.mirrorOwner(slug);
    return !owner || owner.slug === slug && (!!owner.mirror || (owner.kind === 'user'
      ? owner.githubId !== null && owner.githubLogin?.toLowerCase() === slug && (owner.githubNamespaceId === null || owner.githubNamespaceId === owner.githubId)
      : owner.githubNamespace === slug && owner.githubNamespaceId !== null));
  }
  /**
   * A Braid organization GitHub never confirmed, as organizations made before names were checked. Its owner links it to
   * the GitHub organization of the same name once GitHub confirms they administer it; until then it holds the name.
   */
  private unlinkedOrganization(userId: string, slug: string) {
    const owner = this.mirrorOwner(slug);
    return owner && owner.slug === slug && !owner.mirror && owner.kind === 'organization' && owner.githubNamespaceId === null && this.memberRole(userId, owner.id) === 'owner' ? owner : undefined;
  }
  mirrorRecord(workspaceId: string): MirrorRecord | null {
    return this.ctx.storage.sql.exec<MirrorRecord>('SELECT m.workspace AS workspaceId, w.team_id AS teamId, m.full_name AS fullName, m.branch, m.head, m.repository_id AS repositoryId, t.github_namespace_id AS namespaceId, m.private, m.synced_at AS syncedAt, m.importing, m.enabled, m.error FROM mirrors m JOIN workspaces w ON w.id = m.workspace JOIN teams t ON t.id = w.team_id WHERE m.workspace = ?', workspaceId).toArray()[0] ?? null;
  }
  reserveMirrorBytes(workspaceId: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MIRROR_TOTAL_BYTES) return false;
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ bytes: number; enabled: number; error: string | null; syncedAt: string | null }>('SELECT bytes, enabled, error, synced_at AS syncedAt FROM mirrors WHERE workspace = ?', workspaceId).toArray()[0];
      if (!row || row.enabled || row.error) { console.warn(JSON.stringify({ event: 'mirror_transfer_refused', workspaceId, reason: !row ? 'missing' : row.enabled ? 'enabled' : 'error', error: row?.error ?? null })); return false; }
      // Past the budget, a mirror that already serves its default branch only stops copying more history; one that never finished importing is too large.
      if (row.bytes + bytes > MIRROR_TOTAL_BYTES) {
        console.warn(JSON.stringify({ event: 'mirror_transfer_refused', workspaceId, reason: 'budget', used: row.bytes, asked: bytes }));
        if (row.syncedAt === null) this.mirrorUpdated(workspaceId, { importing: false, error: MIRROR_LARGE });
        return false;
      }
      this.ctx.storage.sql.exec('UPDATE mirrors SET bytes = bytes + ? WHERE workspace = ?', bytes, workspaceId); return true;
    });
  }
  releaseMirrorBytes(workspaceId: string, bytes: number) {
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MIRROR_TOTAL_BYTES) this.ctx.storage.sql.exec('UPDATE mirrors SET bytes = MAX(0, bytes - ?) WHERE workspace = ?', bytes, workspaceId);
  }
  /** A copy that replaces a full one starts with the whole transfer budget; what the full copy used went with it. */
  mirrorReplacing(workspaceId: string) {
    this.ctx.storage.sql.exec('UPDATE mirrors SET bytes = 0 WHERE workspace = ? AND enabled = 0', workspaceId);
  }
  mirrorUpdated(workspaceId: string, update: { syncedAt?: string; branch?: string; head?: string; importing?: boolean; error?: string | null }) {
    // A completion already in flight cannot unfreeze a namespace or replace its preserved head.
    this.ctx.storage.sql.exec('UPDATE mirrors SET synced_at = COALESCE(?, synced_at), branch = COALESCE(?, branch), head = COALESCE(?, head), importing = COALESCE(?, importing), error = ? WHERE workspace = ? AND enabled = 0 AND (error IS NULL OR error != ?)',
      update.syncedAt ?? null, update.branch ?? null, update.head ?? null, update.importing === undefined ? null : Number(update.importing), update.error ?? null, workspaceId, MIRROR_NAMESPACE_CHANGED);
  }
  /** Access leases are in memory. No SQLite write or alarm reset happens for a warm/importing read. */
  private async checkMirrorRead(workspaceId: string, userId: string | null = null) {
    const mirror = this.mirrorRecord(workspaceId);
    if (!mirror) return;
    const slug = mirror.fullName.split('/')[0], holder = this.mirrorOwner(slug), pinned = holder?.pinned;
    if (!this.mirrorNamespaceAllowed(slug)) throw mirrorNotFound(!!userId);
    if (mirror.private) this.freezeMoved(workspaceId, pinned, (await privateMirrorRepository(this.env, userId, mirror.fullName, mirror.repositoryId)).owner.id);
    else {
      try { await publicMirrorSource(this.env, mirror.fullName); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        // Withhold old public content first. A viewer's own proof may turn the copy private; never the reverse.
        const upstream = await privateMirrorRepository(this.env, userId, mirror.fullName, mirror.repositoryId);
        if (!upstream.private) throw mirrorNotFound(!!userId);
        this.freezeMoved(workspaceId, pinned, upstream.owner.id);
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('UPDATE teams SET github_namespace_id = ? WHERE id = ? AND github_namespace_id IS NULL', upstream.owner.id, mirror.teamId);
          this.ctx.storage.sql.exec('UPDATE mirrors SET private = 1, repository_id = ? WHERE workspace = ?', upstream.id, workspaceId);
          this.privateBarrier(workspaceId);
          this.ctx.storage.sql.exec("UPDATE workspaces SET visibility = 'private', github_private = 1 WHERE id = ?", workspaceId);
        });
        mirror.private = 1; mirror.repositoryId = upstream.id;
      }
    }
    if (mirror.private) await waitForPublicReads(this.ctx.storage.sql.exec<{ until: number }>('SELECT public_read_until AS until FROM workspaces WHERE id = ?', workspaceId).one().until);
    if (!holder) throw mirrorNotFound(!!userId);
    // An imported mirror that ran out of history budget still serves what it imported; only a failed import is too large.
    if (mirror.error === MIRROR_LARGE && mirror.syncedAt) { this.mirrorUpdated(workspaceId, { error: null }); mirror.error = null; }
    if (mirror.error) throw mirror.error === MIRROR_LARGE ? mirrorTooLarge() : mirror.error === MIRROR_NAMESPACE_CHANGED ? mirrorFrozen() : new HttpError(502, mirror.error);
    if (mirror.enabled) return;
    if (!mirror.importing && mirror.syncedAt && Date.now() - Date.parse(mirror.syncedAt) < MIRROR_SYNC_MS) return;
    if (pinned && !mirror.private) {
      // Existing public snapshots can be read anonymously, but only a fresh visitor-owned proof may refresh them.
      if (!userId) return;
      try { await mirrorNamespaceProof(this.env, mirror, userId); }
      catch (error) { if (!(error instanceof HttpError) || error.code === MIRROR_FROZEN_CODE) throw error; return; }
    }
    if ((this.mirrorTouches.get(workspaceId) ?? 0) > Date.now()) return;
    if (this.mirrorTouches.size >= 1000) this.mirrorTouches.delete(this.mirrorTouches.keys().next().value!);
    this.mirrorTouches.set(workspaceId, Date.now() + 30_000);
    this.ctx.waitUntil(this.env.WORKSPACES.getByName(repositoryKey(mirror.teamId, workspaceId)).readMirror(mirror, userId ?? undefined).catch(error => {
      this.mirrorTouches.delete(workspaceId);
      logFailure('mirror_refresh_failed', error, { workspaceId });
    }));
  }
  private freezeMoved(workspaceId: string, pinned: number | null | undefined, ownerId: number) {
    if (!pinned || pinned === ownerId) return;
    this.mirrorUpdated(workspaceId, { importing: false, error: MIRROR_NAMESPACE_CHANGED });
    throw mirrorFrozen();
  }
  /** Whether this viewer may read the mirror now. Every refusal reads as no, so an answer never names an unreadable GitHub repository. */
  private async mirrorReadable(workspaceId: string, userId: string | null = null): Promise<boolean> {
    try { await this.checkMirrorRead(workspaceId, userId); return true; }
    catch (error) { if (error instanceof HttpError) return false; throw error; }
  }
  private async visibleMirror<T extends { visibility: Visibility }>(workspaceId: string, repo: T, userId: string | null): Promise<T | null> {
    if (!await this.mirrorReadable(workspaceId, userId)) return null;
    return { ...repo, visibility: this.mirrorRecord(workspaceId)?.private ? 'private' : repo.visibility };
  }
  private mirrorBudget(network: string) {
    const sql = this.ctx.storage.sql, time = Date.now();
    for (const [key, limit, expires] of [[`network:${network}`, MIRROR_NETWORK_LIMIT, time + 3_600_000], ['global', MIRROR_DAILY_LIMIT, (Math.floor(time / 86_400_000) + 1) * 86_400_000]] as const) {
      const row = sql.exec<{ used: number; expires: number }>('SELECT used, expires FROM mirror_budgets WHERE key = ?', key).toArray()[0];
      if (row && row.expires > time && row.used >= limit) throw new HttpError(429, key === 'global' ? 'Mirror creation capacity is reached for today.' : 'This network has reached its hourly mirror creation limit.');
      sql.exec('INSERT INTO mirror_budgets VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET used = excluded.used, expires = excluded.expires', key, row && row.expires > time ? row.used + 1 : 1, row && row.expires > time ? row.expires : expires);
    }
    sql.exec('DELETE FROM mirror_budgets WHERE expires <= ?', time);
  }
  private addressWorkspace(owner: string, repo: string): string | undefined {
    return this.ctx.storage.sql.exec<{ id: string }>('SELECT r.workspace_id AS id FROM repository_addresses r JOIN team_addresses a ON a.team_id = r.team_id WHERE a.slug = ? COLLATE NOCASE AND r.slug = ? COLLATE NOCASE', owner, repo).toArray()[0]?.id;
  }
  /**
   * `seeded` is the operator's seeding: it skips the visitor admission budget, and it tries a failed first copy again.
   * The total mirror cap still applies.
   */
  async resolveMirror(user: AccountIdentity | null, owner: string, repo: string, network: string, { seeded = false }: { seeded?: boolean } = {}): Promise<Result<RepositoryAddress>> {
    try {
      let workspaceId = this.addressWorkspace(owner, repo);
      if (!workspaceId) {
        if (RESERVED_OWNERS.has(owner) || !this.mirrorNamespaceAllowed(owner)) throw new HttpError(404, 'Repository not found.');
        const key = `${owner}/${repo}`;
        let creating = this.mirrorCreations.get(key);
        if (!creating) {
          creating = (async () => {
            // Charge attempts, including unavailable sources, before any upstream lookup. Coalesced visits share it.
            if (!seeded) this.ctx.storage.transactionSync(() => this.mirrorBudget(network));
            const source = await mirrorSource(this.env, key, user);
            const existing = this.mirrorOwner(owner), pinned = existing?.pinned;
            if (existing && (!existing.mirror || pinned) && !source.namespaceId) {
              const repo = await privateMirrorRepository(this.env, user?.id ?? null, key);
              if (!pinned || repo.owner.id !== pinned) throw mirrorNotFound(!!user);
              source.namespaceId = repo.owner.id; source.repositoryId = repo.id;
            }
            this.ctx.storage.transactionSync(() => {
              if (this.addressWorkspace(owner, repo)) return;
              if (!this.mirrorNamespaceAllowed(owner)) throw new HttpError(404, 'Repository not found.');
              if (this.claimingOwners.has(owner)) throw new HttpError(409, 'This owner is being claimed. Try again shortly.');
              if (this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM mirrors').one().count >= 1000) throw new HttpError(429, 'Mirror storage capacity is reached.');
              let team = this.mirrorOwner(owner);
              if (team?.pinned && source.namespaceId && team.pinned !== source.namespaceId) throw new HttpError(404, 'Repository not found.');
              const time = now();
              if (!team) {
                const id = crypto.randomUUID();
                this.ctx.storage.sql.exec("INSERT INTO teams (id, name, search_name, slug, created_at, mirror, github_namespace_id) VALUES (?, ?, ?, ?, ?, 1, ?)", id, owner, owner, owner, time, source.namespaceId ?? null);
                this.ctx.storage.sql.exec('INSERT INTO team_addresses VALUES (?, ?)', owner, id);
                team = this.mirrorOwner(owner)!;
              }
              if (source.namespaceId || team.githubId) this.ctx.storage.sql.exec('UPDATE teams SET github_namespace_id = ? WHERE id = ? AND github_namespace_id IS NULL', source.namespaceId ?? team.githubId, team.id);
              const id = crypto.randomUUID();
              this.ctx.storage.sql.exec("INSERT INTO workspaces (id, team_id, name, slug, visibility, visibility_explicit, legacy_visibility, has_commits, created_at, updated_at, description, search_name, search_description) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?, '', ?, '')", id, team.id, repo, repo, source.private ? 'private' : 'public', time, time, repo);
              this.ctx.storage.sql.exec('INSERT INTO repository_addresses VALUES (?, ?, ?)', team.id, repo, id);
              this.ctx.storage.sql.exec('INSERT INTO mirrors (workspace, full_name, branch, head, private, repository_id) VALUES (?, ?, ?, ?, ?, ?)', id, key, source.branch, source.head, Number(source.private ?? false), source.repositoryId ?? null);
            });
          })().finally(() => this.mirrorCreations.delete(key));
          this.mirrorCreations.set(key, creating);
        }
        await creating;
        workspaceId = this.addressWorkspace(owner, repo);
      }
      // The operator's seeding asks the repository to try a failed copy again. Only the repository knows whether its
      // import ended or is still running, so it decides; a frozen namespace stays frozen.
      const failed = seeded && workspaceId ? this.mirrorRecord(workspaceId) : null;
      if (failed?.error && failed.error !== MIRROR_NAMESPACE_CHANGED) {
        await this.env.WORKSPACES.getByName(repositoryKey(failed.teamId, failed.workspaceId)).retryMirror(failed, user?.id);
        this.mirrorTouches.delete(failed.workspaceId);
      }
      if (workspaceId) await this.checkMirrorRead(workspaceId, user?.id ?? null);
      const result = await this.resolveRepository(user?.id ?? null, owner, repo);
      if (result.ok && result.data.mirror) result.data.mirror.claimable = (await this.claimStatus(user, owner)).claimable;
      return result;
    } catch (error) {
      return refused(error instanceof HttpError && error.code === MIRROR_NOT_FOUND_CODE ? mirrorNotFound(!!user) : error, 502, 'The GitHub mirror could not be prepared. Try again shortly.');
    }
  }
  async mirrorOwnerRepositories(user: AccountIdentity | null, slug: string): Promise<Result<OwnerRepositories>> {
    try {
      const owner = this.mirrorOwner(slug);
      if (!owner) {
        if (!user) throw new HttpError(404, 'Owner not found.');
        const github = await githubAccount(this.env, user.id, slug);
        if (!github) throw new HttpError(404, 'Owner not found.');
        return { ok: true, data: { owner: { slug, name: github.login, kind: github.type === 'User' ? 'user' : 'organization' }, mirror: true, repositories: [] } };
      }
      const answer = this.ownerRepositories(user?.id ?? null, slug);
      const mirrors = this.ctx.storage.sql.exec<{ id: string; slug: string; name: string; description: string; visibility: Visibility; updatedAt: string }>("SELECT w.id, w.slug, w.name, COALESCE(w.description, '') AS description, w.visibility, w.updated_at AS updatedAt FROM workspaces w JOIN mirrors m ON m.workspace = w.id WHERE w.team_id = ? LIMIT 100", owner.id).toArray();
      const member = !!user && !!this.memberRole(user.id, owner.id);
      const repositories = await Promise.all(mirrors.map(({ id, ...repo }) =>
        hidden(repo.visibility, member, this.mirrorRecord(id)) ? null : this.visibleMirror(id, repo, user?.id ?? null)));
      const visible = repositories.filter(repo => repo !== null);
      if (!answer.ok && !owner.mirror && !visible.length) return answer;
      return { ok: true, data: { ...(answer.ok ? answer.data : { owner: { slug: owner.slug, name: owner.slug, kind: owner.kind }, repositories: [] }),
        repositories: [...(answer.ok ? answer.data.repositories : []), ...visible], ...(owner.mirror ? { mirror: true } : {}) } };
    } catch (error) { return refused(error, 502, 'The owner could not be loaded. Try again shortly.'); }
  }
  async claimStatus(user: AccountIdentity | null, slug: string): Promise<ClaimProof> {
    if (user && this.unlinkedOrganization(user.id, slug)) return linkProof(await githubClaimProof(this.env, user, slug));
    if (RESERVED_OWNERS.has(slug) || !this.mirrorNamespaceAllowed(slug)) return { claimable: false, reason: 'This namespace belongs to an existing Braid owner.' };
    const proof = await githubClaimProof(this.env, user, slug);
    if (heldByOther(this.mirrorOwner(slug), proof, user?.id)) return { claimable: false, reason: 'This namespace belongs to an existing Braid owner.' };
    const personal = user && proof.kind === 'user' ? this.personalOwner(user.id) : null;
    if (personal && personal.slug !== slug) return { claimable: false, reason: 'Your Braid username differs from this GitHub namespace. Existing owners are not moved automatically.' };
    // A name the viewer already owns has nothing to claim, unless mirrors under it are still read-only.
    const owner = this.mirrorOwner(slug);
    if (user && proof.claimable && owner && this.ownedBy(user.id, owner, proof))
      return this.readOnlyMirrors(owner.id) ? { ...proof, owned: true } : { claimable: false, owned: true, reason: 'You already own this name on Braid.' };
    return proof;
  }
  /** The viewer already owns this Braid name, and it is the GitHub account or organization that the proof names. */
  private ownedBy(userId: string, owner: AddressOwner, proof: ClaimProof) {
    if (owner.mirror || proof.namespaceId === undefined) return false;
    return owner.kind === 'user' ? owner.userId === userId && owner.githubId === proof.namespaceId
      : this.memberRole(userId, owner.id) === 'owner' && owner.githubNamespaceId === proof.namespaceId;
  }
  private readOnlyMirrors(teamId: string) {
    return this.ctx.storage.sql.exec('SELECT 1 FROM mirrors m JOIN workspaces w ON w.id = m.workspace WHERE w.team_id = ? AND m.enabled = 0 LIMIT 1', teamId).toArray().length > 0;
  }
  async claimMirrorOwner(user: AccountIdentity, slug: string): Promise<{ ok: true; role: OrganizationRole } | Refusal> {
    if (this.claimingOwners.has(slug)) return refusal(new HttpError(409, 'This owner is being claimed. Try again shortly.'));
    this.claimingOwners.add(slug);
    const paused: string[] = [];
    const started = Date.now();
    try {
      const unlinked = this.unlinkedOrganization(user.id, slug);
      if (unlinked) {
        const proof = linkProof(await githubClaimProof(this.env, user, slug, true));
        if (!proof.claimable) throw new HttpError(403, proof.reason ?? 'GitHub did not confirm ownership.');
        this.ctx.storage.transactionSync(() => {
          // The GitHub check waited on the network: the organization must still be this owner's, and still unlinked.
          if (this.unlinkedOrganization(user.id, slug)?.id !== unlinked.id) throw new HttpError(409, 'This organization changed. Try again.');
          this.pinNamespace(unlinked.id, slug, proof);
          this.audit(unlinked.id, user.id, 'owner.linked', slug);
        });
        return { ok: true, role: 'owner' };
      }
      if (RESERVED_OWNERS.has(slug) || !this.mirrorNamespaceAllowed(slug)) throw new HttpError(409, 'This namespace belongs to an existing Braid owner.');
      const proof = await githubClaimProof(this.env, user, slug, true);
      let owner = this.mirrorOwner(slug);
      if (heldByOther(owner, proof, user.id)) throw new HttpError(403, 'This namespace belongs to a different GitHub identity.');
      // Subsequent GitHub admins become members; a second claim cannot replace or add to the established owners.
      if (owner && !owner.mirror && owner.githubKind === 'organization' && proof.member && this.memberRole(user.id, owner.id) !== 'owner') {
        this.addGitHubMember(user, owner.id); return { ok: true, role: 'member' };
      }
      if (!proof.claimable) {
        if (proof.member && owner && !owner.mirror && owner.githubKind === 'organization' && owner.githubNamespace === slug) {
          this.addGitHubMember(user, owner.id);
          return { ok: true, role: 'member' };
        }
        throw new HttpError(403, proof.reason ?? 'GitHub did not confirm ownership.');
      }
      const personal = proof.kind === 'user' ? this.personalOwner(user.id) : null;
      if (personal && personal.slug !== slug) throw new HttpError(409, 'Your Braid username differs from this GitHub namespace. Existing owners are not moved automatically.');
      if (!owner) {
        this.ctx.storage.transactionSync(() => {
          const id = crypto.randomUUID();
          this.ctx.storage.sql.exec('INSERT INTO teams (id, name, search_name, slug, created_at, mirror, github_namespace_id) VALUES (?, ?, ?, ?, ?, 1, ?)', id, slug, slug, slug, now(), proof.namespaceId!);
          this.ctx.storage.sql.exec('INSERT INTO team_addresses VALUES (?, ?)', slug, id);
        });
        owner = this.mirrorOwner(slug)!;
      }
      const copies = this.ctx.storage.sql.exec<{ id: string }>('SELECT m.workspace AS id FROM mirrors m JOIN workspaces w ON w.id = m.workspace WHERE w.team_id = ? AND m.enabled = 0', owner.id).toArray();
      for (const { id } of copies) {
        const answer = await this.env.WORKSPACES.getByName(repositoryKey(owner.id, id)).stopMirror();
        if (!answer.ok) throw new HttpError(409, answer.error);
        paused.push(repositoryKey(owner.id, id));
      }
      this.ctx.storage.transactionSync(() => {
        // Network waits above cannot overwrite a newly occupied name or personal owner.
        if (Date.now() - started >= 30_000) throw new HttpError(409, 'Claim verification took too long. Try again.');
        if (!this.mirrorNamespaceAllowed(slug)) throw new HttpError(409, 'This namespace belongs to an existing Braid owner.');
        const current = proof.kind === 'user' ? this.personalOwner(user.id) : null;
        if (current && current.id !== owner!.id) throw new HttpError(409, 'Your Braid username changed. Try again.');
        this.remember(user);
        this.ctx.storage.sql.exec('UPDATE teams SET mirror = 0, github_namespace = ?, github_namespace_id = ?, github_kind = ?, kind = ?, user_id = ? WHERE id = ?', slug, proof.namespaceId!, proof.kind!, proof.kind!, proof.kind === 'user' ? user.id : null, owner!.id);
        this.ctx.storage.sql.exec("INSERT INTO members VALUES (?, ?, 'owner') ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'owner'", owner!.id, user.id);
        this.ctx.storage.sql.exec('DELETE FROM github_members WHERE team = ? AND user = ?', owner!.id, user.id);
        if (proof.kind === 'user') this.ctx.storage.sql.exec('UPDATE users SET username = ?, github_id = ?, github_login = ? WHERE id = ?', slug, proof.namespaceId!, slug, user.id);
        this.ctx.storage.sql.exec('UPDATE mirrors SET enabled = 1 WHERE workspace IN (SELECT id FROM workspaces WHERE team_id = ?)', owner!.id);
        this.audit(owner!.id, user.id, 'owner.claimed', slug);
      });
      return { ok: true, role: 'owner' };
    } catch (error) { return refused(error, 502, 'The owner could not be claimed. Try again.'); }
    finally {
      // Commit is Directory-owned; leases also expire after eviction or a lost RPC response.
      await Promise.allSettled(paused.map(key => this.env.WORKSPACES.getByName(key).resumeMirror()));
      this.claimingOwners.delete(slug);
    }
  }
  private addGitHubMember(user: AccountIdentity, teamId: string) {
    this.ctx.storage.transactionSync(() => {
      if (this.memberRole(user.id, teamId)) return;
      this.remember(user);
      this.ctx.storage.sql.exec("INSERT INTO members VALUES (?, ?, 'member')", teamId, user.id);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO github_members VALUES (?, ?)', teamId, user.id);
    });
  }
  /** Account refresh after sign-in admits confirmed org members; automatic grants are removed on failed proof. */
  async syncGitHubMemberships(user: AccountIdentity) {
    const organizations = this.ctx.storage.sql.exec<{ id: string; slug: string; namespaceId: number }>("SELECT id, slug, github_namespace_id AS namespaceId FROM teams WHERE mirror = 0 AND github_kind = 'organization' AND github_namespace = slug ORDER BY id LIMIT 100").toArray();
    for (const organization of organizations) {
      const proof = await githubClaimProof(this.env, user, organization.slug);
      if (proof.member && proof.namespaceId === organization.namespaceId) this.addGitHubMember(user, organization.id);
      else this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM members WHERE team_id = ? AND user_id = ? AND role = 'member' AND EXISTS (SELECT 1 FROM github_members WHERE team = ? AND user = ?)", organization.id, user.id, organization.id, user.id);
        this.ctx.storage.sql.exec('DELETE FROM github_members WHERE team = ? AND user = ?', organization.id, user.id);
      });
    }
  }
  async dispatch<A extends keyof DirectoryInput>(user: AccountIdentity, action: A, input: DirectoryInput[A]): Promise<Result<string>> {
    try {
      if (action === 'list') await this.migrateVisibility(user.id);
      let data: unknown;
      const request = { ...input, action } as DirectoryRequest;
      switch (request.action) {
        case 'list': data = await Promise.all(this.list(user).map(owner => this.visibleOwner(user.id, owner))); break;
        case 'username': {
          const current = this.personalOwner(user.id);
          if (this.ownerAddressTaken(request.username, current?.id)) throw new HttpError(409, 'This username is already taken.');
          await this.protectNamespace(user, request.username, current?.id, 'user');
          data = this.setUsername(user, request.username); break;
        }
        case 'teams': data = this.teams(user.id, request.orgId); break;
        case 'team': data = this.teamDetail(user.id, request.orgId, request.teamId); break;
        case 'createOrgTeam': data = this.createOrgTeam(user.id, request); break;
        case 'updateOrgTeam': data = this.updateOrgTeam(user.id, request); break;
        case 'deleteOrgTeam': this.deleteOrgTeam(user.id, request); data = { ok: true }; break;
        case 'setTeamMember': data = this.setTeamMember(user.id, request); break;
        case 'removeTeamMember': data = this.removeTeamMember(user.id, request); break;
        case 'setTeamRepository': data = this.setTeamRepository(user.id, request); break;
        case 'removeTeamRepository': data = this.removeTeamRepository(user.id, request); break;
        case 'repositoryAccess': data = this.repositoryAccess(user.id, request.orgId, request.workspaceId); break;
        case 'createOrganization':
        case 'createTeam': {
          const slug = this.uniqueSlug(request.name);
          const proof = await this.protectNamespace(user, slug, undefined, 'organization');
          if (this.uniqueSlug(request.name) !== slug) throw new HttpError(409, 'This owner name was just taken. Try again.');
          const organization = this.createOrganization(user, request.name);
          this.pinNamespace(organization.id, slug, proof);
          data = organization; break;
        }
        case 'updateMember': this.updateMember(user.id, request); data = { ok: true }; break;
        case 'replaceInvite': data = await this.replaceInvite(user.id, request.teamId, request.inviteId); break;
        case 'updateTeam': {
          this.role(user.id, request.teamId, true);
          const proof = request.slug ? await this.protectNamespace(user, request.slug, request.teamId, 'organization') : null;
          data = this.updateTeam(user.id, request);
          this.pinNamespace(request.teamId, request.slug!, proof);
          break;
        }
        case 'createWorkspace': data = this.createWorkspace(user.id, request.teamId, request.name, request.visibility); break;
        case 'updateWorkspace': data = this.updateWorkspace(user.id, request); break;
        case 'authorize': data = await this.repositoryGrant(user.id, request.workspaceId, request.write); break;
        case 'members': data = this.members(user.id, request.teamId); break;
        case 'invite': data = await this.invite(user.id, request.teamId, request); break;
        case 'accept': data = await this.accept(user, request.token); break;
        case 'revokeInvite': this.revokeInvite(user.id, request.teamId, request.inviteId); data = { ok: true }; break;
        case 'removeMember': this.removeMember(user.id, request.teamId, request.memberId); data = { ok: true }; break;
        case 'audit': data = this.auditLog(user.id, request.teamId, request.before); break;
        default: throw new HttpError(404, 'Account action not found.');
      }
      return { ok: true, data: JSON.stringify(data) };
    } catch (error) {
      return refused(error, 500, 'The account operation could not complete.');
    }
  }
  /** Old rows start private. No URL or repository name is evidence that an import was public. */
  private migrate() {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS org_teams (id TEXT PRIMARY KEY, org TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', UNIQUE (org, slug))`);
      sql.exec(`CREATE TABLE IF NOT EXISTS org_team_members (team TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('maintainer', 'member')), PRIMARY KEY(team, user))`);
      sql.exec('CREATE INDEX IF NOT EXISTS org_team_member_user ON org_team_members(user, team)');
      sql.exec(`CREATE TABLE IF NOT EXISTS org_team_repositories (team TEXT NOT NULL, workspace TEXT NOT NULL, permission TEXT NOT NULL CHECK(permission IN ('read', 'write')), PRIMARY KEY(team, workspace))`);
      sql.exec('CREATE INDEX IF NOT EXISTS org_team_repository_workspace ON org_team_repositories(workspace, team)');
      addColumn(sql, 'users', 'username', 'TEXT COLLATE NOCASE');
      addColumn(sql, 'users', 'github_id', 'INTEGER');
      addColumn(sql, 'users', 'github_login', 'TEXT');
      addColumn(sql, 'teams', 'kind', "TEXT NOT NULL DEFAULT 'organization' CHECK(kind IN ('user', 'organization'))");
      addColumn(sql, 'teams', 'user_id', 'TEXT');
      addColumn(sql, 'teams', 'mirror', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sql, 'teams', 'github_namespace', 'TEXT');
      addColumn(sql, 'teams', 'github_namespace_id', 'INTEGER');
      addColumn(sql, 'teams', 'github_kind', 'TEXT');
      sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_username ON users(username COLLATE NOCASE)');
      sql.exec('CREATE INDEX IF NOT EXISTS user_git_email ON users(email COLLATE NOCASE)');
      sql.exec('CREATE INDEX IF NOT EXISTS user_git_login ON users(github_login COLLATE NOCASE)');
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS personal_owner ON teams(user_id) WHERE kind = 'user'");
      sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS owner_address_nocase ON team_addresses(slug COLLATE NOCASE)');
      addColumn(sql, 'users', 'notify_attention', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(sql, 'users', 'notify_returned', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(sql, 'teams', 'slug', 'TEXT');
      addColumn(sql, 'teams', 'search_name', 'TEXT');
      addColumn(sql, 'workspaces', 'slug', 'TEXT');
      addColumn(sql, 'workspaces', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
      addColumn(sql, 'workspaces', 'visibility_explicit', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sql, 'workspaces', 'legacy_visibility', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(sql, 'workspaces', 'updated_at', 'TEXT');
      addColumn(sql, 'workspaces', 'description', 'TEXT');
      addColumn(sql, 'workspaces', 'search_name', 'TEXT');
      addColumn(sql, 'workspaces', 'search_description', 'TEXT');
      addColumn(sql, 'workspaces', 'github_private', 'INTEGER');
      addColumn(sql, 'workspaces', 'has_commits', 'INTEGER');
      addColumn(sql, 'workspaces', 'public_read_until', 'INTEGER NOT NULL DEFAULT 0');
      for (const team of sql.exec<{ id: string; name: string }>('SELECT id, name FROM teams WHERE slug IS NULL ORDER BY created_at, id').toArray())
        sql.exec('UPDATE teams SET slug = ? WHERE id = ?', this.uniqueSlug(team.name), team.id);
      for (const repo of sql.exec<{ id: string; team_id: string; name: string }>('SELECT id, team_id, name FROM workspaces WHERE slug IS NULL ORDER BY created_at, id').toArray())
        sql.exec('UPDATE workspaces SET slug = ? WHERE id = ?', this.uniqueSlug(repo.name, repo.team_id), repo.id);
      sql.exec('UPDATE workspaces SET updated_at = created_at WHERE updated_at IS NULL');
      for (const team of sql.exec<{ id: string; name: string }>('SELECT id, name FROM teams WHERE search_name IS NULL').toArray())
        sql.exec('UPDATE teams SET search_name = ? WHERE id = ?', searchText(team.name), team.id);
      for (const repo of sql.exec<{ id: string; name: string; description: string }>("SELECT id, name, COALESCE(description, '') AS description FROM workspaces WHERE search_name IS NULL OR search_description IS NULL").toArray())
        sql.exec('UPDATE workspaces SET search_name = ?, search_description = ? WHERE id = ?', searchText(repo.name), searchText(repo.description), repo.id);
      sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS team_slug ON teams(slug)');
      sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS repository_slug ON workspaces(team_id, slug)');
      sql.exec('INSERT OR IGNORE INTO team_addresses SELECT slug, id FROM teams');
      sql.exec('INSERT OR IGNORE INTO repository_addresses SELECT team_id, slug, id FROM workspaces');
      sql.exec('CREATE INDEX IF NOT EXISTS public_activity ON workspaces(visibility, updated_at DESC, id DESC)');
      sql.exec('CREATE INDEX IF NOT EXISTS public_search_name ON workspaces(visibility, search_name, id)');
      for (const user of sql.exec<{ id: string }>('SELECT id FROM users WHERE NOT EXISTS (SELECT 1 FROM public_people WHERE user_id = users.id)').toArray()) this.recordPerson(user.id);
    });
  }
  private uniqueSlug(name: string, teamId?: string): string {
    const base = slugOf(name) || `${teamId ? 'repo' : 'organization'}-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
    for (let index = 1; ; index++) {
      const suffix = index === 1 ? '' : `-${index}`;
      const candidate = base.slice(0, 39 - suffix.length).replace(/-+$/, '') + suffix;
      const taken = teamId
        ? this.ctx.storage.sql.exec('SELECT id FROM workspaces WHERE team_id = ? AND slug = ? UNION SELECT workspace_id FROM repository_addresses WHERE team_id = ? AND slug = ?', teamId, candidate, teamId, candidate).toArray().length
        : RESERVED_OWNERS.has(candidate) || this.ctx.storage.sql.exec('SELECT id FROM teams WHERE slug = ? COLLATE NOCASE UNION SELECT team_id FROM team_addresses WHERE slug = ? COLLATE NOCASE', candidate, candidate).toArray().length;
      if (!taken) return candidate;
    }
  }
  private async migrateVisibility(userId: string, workspaceId?: string) {
    if (!this.env.WORKSPACES) return;
    const rows = this.ctx.storage.sql.exec<{ id: string; team_id: string }>(`SELECT id, team_id FROM workspaces WHERE legacy_visibility = 1 AND team_id IN (SELECT team_id FROM members WHERE user_id = ?)${workspaceId ? ' AND id = ?' : ''}`, userId, ...(workspaceId ? [workspaceId] : [])).toArray();
    await Promise.all(rows.map(async row => {
      try {
        const metadata = await this.env.WORKSPACES.getByName(repositoryKey(row.team_id, row.id)).publicationMetadata();
        // Recheck after RPC: explicit choices win unless the retained source is private.
        this.ctx.storage.sql.exec("UPDATE workspaces SET visibility = ?, legacy_visibility = 0, description = ?, search_description = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND legacy_visibility = 1 AND (visibility_explicit = 0 OR ? = 0)",
          metadata.sourcePublic === true ? 'public' : 'private', metadata.description, searchText(metadata.description), metadata.updatedAt ?? '', row.id, metadata.sourcePublic === false ? 0 : 1);
      } catch (error) { logFailure('visibility_migration_failed', error, { workspaceId: row.id }); }
    }));
  }
  /** Backfill only pre-migration rows, four at a time. Explore itself remains a directory-only read. */
  private async migrateRepositoryReadiness() {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<{ id: string; teamId: string }>('SELECT id, team_id AS teamId FROM workspaces WHERE has_commits IS NULL').toArray();
    for (let start = 0; start < rows.length; start += 4) await Promise.all(rows.slice(start, start + 4).map(async row => {
      try {
        const repository = await this.env.WORKSPACES.getByName(repositoryKey(row.teamId, row.id)).repository();
        // An import that finished during the lookup already recorded its commit and wins this race.
        sql.exec('UPDATE workspaces SET has_commits = ? WHERE id = ? AND has_commits IS NULL', Number(!!repository?.head), row.id);
      } catch (error) { logFailure('repository_readiness_migration_failed', error, { workspaceId: row.id }); }
    }));
  }
  /** A private source overrides every previous publication choice; only a finished copy makes it discoverable. */
  repositoryImported(workspaceId: string, sourcePublic: boolean | undefined, description?: string, complete = false) {
    const until = sourcePublic === false ? this.privateBarrier(workspaceId) : 0;
    this.ctx.storage.sql.exec("UPDATE workspaces SET visibility = CASE WHEN ? = 0 THEN 'private' ELSE visibility END, legacy_visibility = 0, description = COALESCE(?, description), search_description = COALESCE(?, search_description), has_commits = CASE WHEN ? THEN 1 ELSE has_commits END WHERE id = ?", sourcePublic === undefined ? null : Number(sourcePublic), description ?? null, description === undefined ? null : searchText(description), Number(complete), workspaceId);
    return until;
  }
  /** Confirmed by GitHub before any linked content is synchronized. */
  repositoryLinked(workspaceId: string, isPrivate: boolean, actor: string) {
    const row = this.ctx.storage.sql.exec<{ teamId: string; visibility: Visibility }>('SELECT team_id AS teamId, visibility FROM workspaces WHERE id = ?', workspaceId).toArray()[0];
    if (!row) throw new HttpError(404, 'Repository not found.');
    const until = isPrivate ? this.privateBarrier(workspaceId) : 0;
    this.ctx.storage.sql.exec("UPDATE workspaces SET github_private = ?, visibility = CASE WHEN ? THEN 'private' ELSE visibility END WHERE id = ?", Number(isPrivate), Number(isPrivate), workspaceId);
    if (isPrivate && row.visibility !== 'private') this.audit(row.teamId, actor, 'repository.made-private', workspaceId);
    return until;
  }
  /** Persist the deadline with the flip so retries and overlapping syncs wait for the same old lookup leases. */
  private privateBarrier(workspaceId: string): number {
    this.ctx.storage.sql.exec("UPDATE workspaces SET public_read_until = ? WHERE id = ? AND visibility = 'public'", Date.now() + PUBLIC_READ_TTL, workspaceId);
    return this.ctx.storage.sql.exec<{ until: number }>('SELECT public_read_until AS until FROM workspaces WHERE id = ?', workspaceId).one().until;
  }
  repositoryUnlinked(workspaceId: string) { this.ctx.storage.sql.exec('UPDATE workspaces SET github_private = NULL WHERE id = ?', workspaceId); }
  repositorySecurityEvent(workspaceId: string, action: string, target: string) {
    const row = this.ctx.storage.sql.exec<{ teamId: string }>('SELECT team_id AS teamId FROM workspaces WHERE id = ?', workspaceId).toArray()[0];
    if (row) this.audit(row.teamId, 'Braid security', action, target);
  }

  /** Activity comes from durable workspace/change writes, never from visitors reading a repository. */
  repositoryActivity(workspaceId: string, updatedAt: string, description?: string) {
    this.ctx.storage.sql.exec('UPDATE workspaces SET updated_at = MAX(updated_at, ?), description = COALESCE(?, description), search_description = COALESCE(?, search_description) WHERE id = ?', updatedAt, description ?? null, description === undefined ? null : searchText(description), workspaceId);
  }
  async publicRead(workspaceId: string): Promise<Result<{ teamId: string; workspaceId: string; ownerSlug: string; repoSlug: string }>> {
    const row = this.ctx.storage.sql.exec<{ teamId: string; ownerSlug: string; repoSlug: string }>("SELECT w.team_id AS teamId, t.slug AS ownerSlug, w.slug AS repoSlug FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.id = ? AND w.visibility = 'public'", workspaceId).toArray()[0];
    if (!row || !await this.mirrorReadable(workspaceId)) return repositoryNotFound();
    return { ok: true, data: { ...row, workspaceId } };
  }
  async resolveRepository(userId: string | null, owner: string, repo: string): Promise<Result<RepositoryAddress>> {
    const row = this.ctx.storage.sql.exec<{ workspaceId: string; teamId: string; ownerSlug: string; ownerName: string; ownerKind: OwnerKind; slug: string; name: string; createdAt: string }>('SELECT w.id AS workspaceId, w.team_id AS teamId, t.slug AS ownerSlug, t.name AS ownerName, t.kind AS ownerKind, w.slug, w.name, w.created_at AS createdAt FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE t.id = (SELECT team_id FROM team_addresses WHERE slug = ?) AND w.id = (SELECT workspace_id FROM repository_addresses WHERE team_id = t.id AND slug = ?)', owner, repo).toArray()[0];
    if (!row) return repositoryNotFound();
    const mirror = this.mirrorRecord(row.workspaceId);
    if (!await this.mirrorReadable(row.workspaceId, userId)) return repositoryNotFound();
    if (userId) await this.migrateVisibility(userId, row.workspaceId);
    const { visibility } = this.ctx.storage.sql.exec<{ visibility: Visibility }>('SELECT visibility FROM workspaces WHERE id = ?', row.workspaceId).one();
    const role = userId ? this.memberRole(userId, row.teamId) : undefined;
    if (hidden(visibility, !!role, mirror)) return repositoryNotFound();
    return { ok: true, data: { workspaceId: row.workspaceId, owner: { slug: row.ownerSlug, name: row.ownerName, kind: row.ownerKind }, repo: { slug: row.slug, name: row.name }, visibility, canWrite: !!role && this.repositoryWriter(userId!, row.teamId, row.workspaceId, role),
      // The reservation precedes background setup and remains available while an edge snapshot has no import record.
      ...(mirror ? { mirror: { source: `https://github.com/${mirror.fullName}`, syncedAt: mirror.syncedAt, importing: !!mirror.importing, claimable: false,
        ...(mirror.importing && !mirror.syncedAt ? { startedAt: row.createdAt } : {}) } } : {}) } };
  }
  /** Membership alone can exempt a request before its public address lookup. */
  addressMember(userId: string, owner: string, repo: string): boolean {
    return this.ctx.storage.sql.exec('SELECT m.user_id FROM members m JOIN team_addresses t ON t.team_id = m.team_id JOIN repository_addresses r ON r.team_id = m.team_id WHERE m.user_id = ? AND t.slug = ? AND r.slug = ?', userId, owner, repo).toArray().length > 0;
  }
  async publicRepositories(limit: number, cursor?: RepositoryCursor, { q = '', sort = 'updated' }: RepositorySearch = {}): Promise<RepositoryPage> {
    const sql = this.ctx.storage.sql;
    // Match only public text: counts must not become an oracle for redacted emails or credentials.
    // Literal substrings keep %, _ and quotes as text, never SQL patterns.
    const search = q ? ' AND (instr(t.slug, ?) > 0 OR instr(t.search_name, ?) > 0 OR instr(w.slug, ?) > 0 OR instr(w.search_name, ?) > 0 OR instr(w.search_description, ?) > 0)' : '';
    const bindings = q ? [q, q, q, q, q] : [];
    // A public mirror is listed once its first copy is ready and while it has no error. A source that turns private
    // leaves the list at its next visit, which rechecks GitHub; until then Explore shows only the name it had in public.
    const listed = '(w.has_commits = 1 AND NOT EXISTS (SELECT 1 FROM mirrors gm WHERE gm.workspace = w.id) OR EXISTS (SELECT 1 FROM mirrors gm WHERE gm.workspace = w.id AND gm.private = 0 AND gm.synced_at IS NOT NULL AND gm.error IS NULL))';
    const from = `FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.visibility = 'public' AND ${listed}${search}`;
    const after = !cursor ? '' : cursor.sort === 'name'
      ? ' AND (w.search_name, w.id) > (?, ?)'
      : ' AND (w.updated_at, w.id) < (?, ?)';
    const order = sort === 'name' ? 'w.search_name, w.id' : 'w.updated_at DESC, w.id DESC';
    const rows = sql.exec<{ id: string; ownerSlug: string; ownerName: string; slug: string; name: string; searchName: string; description: string | null; updatedAt: string }>(`SELECT w.id, t.slug AS ownerSlug, t.name AS ownerName, w.slug, w.name, w.search_name AS searchName, w.description, w.updated_at AS updatedAt ${from}${after} ORDER BY ${order} LIMIT ?`,
      ...bindings, ...(cursor ? cursor.sort === 'name' ? [cursor.name, cursor.id] : [cursor.updatedAt, cursor.id] : []), limit + 1).toArray();
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => ({ owner: { slug: row.ownerSlug, name: row.ownerName }, repo: { slug: row.slug, name: row.name }, ...(row.description ? { description: row.description } : {}), updatedAt: row.updatedAt })),
      nextCursor: rows.length > limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id, ...(sort === 'name' ? { sort, name: last.searchName } : {}) }) : null,
      ...(q ? { total: sql.exec<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, ...bindings).one().total } : {}) };
  }
  /** A private-only organization is as undiscoverable as an unknown one to a nonmember. */
  ownerRepositories(userId: string | null, slug: string): Result<OwnerRepositories> {
    const team = this.ctx.storage.sql.exec<{ id: string; slug: string; name: string; kind: OwnerKind; githubId: number | null; member: number }>(`SELECT t.id, t.slug, t.name, t.kind, u.github_id AS githubId, EXISTS(SELECT 1 FROM members m WHERE m.team_id = t.id AND m.user_id = ?) AS member FROM teams t JOIN team_addresses a ON a.team_id = t.id LEFT JOIN users u ON u.id = t.user_id WHERE a.slug = ? COLLATE NOCASE`, userId, slug).toArray()[0];
    if (!team) return refusal(new HttpError(404, 'Owner not found.'));
    const repositories = this.ctx.storage.sql.exec<OwnerRepositories['repositories'][number]>(`SELECT slug, name, COALESCE(description, '') AS description, visibility, updated_at AS updatedAt FROM workspaces WHERE team_id = ? AND NOT EXISTS (SELECT 1 FROM mirrors m WHERE m.workspace = workspaces.id)${team.member ? '' : " AND visibility = 'public'"} ORDER BY updated_at DESC, id DESC`, team.id).toArray();
    if (team.kind === 'organization' && !team.member && !repositories.length) return refusal(new HttpError(404, 'Owner not found.'));
    return { ok: true, data: { owner: { slug: team.slug, name: team.kind === 'user' ? personName(team.name) : team.name, kind: team.kind,
      ...(team.kind === 'user' ? { avatarUrl: githubAvatar(team.githubId, team.slug) } : {}) }, repositories,
      ...(team.kind === 'organization' && team.member ? { memberCount: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM members WHERE team_id = ?', team.id).one().count } : {}) } };
  }

  updateWorkspace(userId: string, input: DirectoryInput['updateWorkspace']): RepositoryWorkspace {
    return this.ctx.storage.transactionSync(() => {
      this.role(userId, input.teamId, true);
      const current = this.workspaces(input.teamId).find(repo => repo.id === input.workspaceId);
      if (!current) throw new HttpError(404, 'Repository not found.');
      const mirror = this.mirrorRecord(current.id);
      if (mirror?.enabled === 0) throw new HttpError(403, 'Claim this GitHub owner to enable Braid features first.');
      if (input.visibility === 'public' && mirror?.private) throw new HttpError(409, 'The GitHub repository is private.');
      if (input.visibility === 'public' && this.ctx.storage.sql.exec<{ githubPrivate: number | null }>('SELECT github_private AS githubPrivate FROM workspaces WHERE id = ?', current.id).one().githubPrivate === 1) throw new HttpError(409, 'The linked GitHub repository is private.');
      if (input.slug && this.ctx.storage.sql.exec('SELECT workspace_id FROM repository_addresses WHERE team_id = ? AND slug = ? AND workspace_id != ?', input.teamId, input.slug, current.id).toArray().length)
        throw new HttpError(409, 'This organization already has a repository with that slug.');
      const next: RepositoryWorkspace = { ...current, name: input.name ?? current.name, slug: input.slug ?? current.slug, visibility: input.visibility ?? current.visibility };
      const explicit = input.visibility === undefined ? 0 : 1;
      this.ctx.storage.sql.exec('UPDATE workspaces SET name = ?, search_name = ?, slug = ?, visibility = ?, visibility_explicit = CASE WHEN ? THEN 1 ELSE visibility_explicit END, legacy_visibility = CASE WHEN ? THEN 0 ELSE legacy_visibility END, updated_at = ? WHERE id = ?',
        next.name, searchText(next.name), next.slug, next.visibility, explicit, explicit, now(), current.id);
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO repository_addresses VALUES (?, ?, ?)', input.teamId, next.slug, current.id);
      this.audit(input.teamId, userId, 'repository.updated', current.id);
      return next;
    });
  }
  private audit(teamId: string, actor: string, action: string, target: string) {
    this.ctx.storage.sql.exec('INSERT INTO audit (team_id, actor, action, target, created_at) VALUES (?, ?, ?, ?, ?)', teamId, actor, action, target, now());
  }
  /** Random, durable identities also map legacy user:/email: keys without rewriting immutable Git history. */
  publicPerson(userId: string): string | undefined {
    const key = userId.replace(/^user:/, '');
    return this.ctx.storage.sql.exec<{ publicId: string }>('SELECT public_id AS publicId FROM public_people WHERE user_id = ?', key).toArray()[0]?.publicId;
  }
  /** Mint only when recording a person, never as a side effect of a public lookup. */
  recordPerson(userId: string): string {
    return this.ctx.storage.transactionSync(() => {
      const known = this.publicPerson(userId);
      if (known) return known;
      const publicId = crypto.randomUUID().replaceAll('-', '');
      this.ctx.storage.sql.exec('INSERT INTO public_people VALUES (?, ?)', userId.replace(/^user:/, ''), publicId);
      return publicId;
    });
  }
  private remember(user: AccountIdentity) {
    this.ctx.storage.sql.exec('INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name', user.id, user.email.toLowerCase(), user.name);
    this.recordPerson(user.id);
  }

  /** Directory owns mutable handles; old session snapshots never overwrite them. */
  identity(user: AccountIdentity): AccountIdentity {
    const row = this.ctx.storage.sql.exec<{ username: string | null; githubId: number | null }>('SELECT username, github_id AS githubId FROM users WHERE id = ?', user.id).toArray()[0];
    return { ...user, name: personName(user.name), username: row?.username ?? null, avatarUrl: githubAvatar(row?.githubId ?? null, row?.username ?? null) };
  }
  /** On GitHub sign-in, claim only the actual login when free. A collision still asks the person. */
  account(user: AccountIdentity, github: GitHubIdentity | null = null, claimGitHub = false) {
    return this.ctx.storage.transactionSync(() => {
      this.remember(user);
      if (github) this.ctx.storage.sql.exec('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?', github.id, github.login, user.id);
      let identity = this.identity(user);
      if (!identity.username && claimGitHub && github) {
        const candidate = github.login.toLowerCase();
        if (SLUG.test(candidate) && !RESERVED_OWNERS.has(candidate) && !this.ownerAddressTaken(candidate)) {
          this.setUsername(user, candidate);
          identity = this.identity(user);
        }
      }
      const personalOwner = this.personalOwner(user.id);
      if (personalOwner) this.ctx.storage.sql.exec('UPDATE teams SET name = ?, search_name = ? WHERE id = ?', identity.name, searchText(identity.name), personalOwner.id);
      return { user: identity, personalOwner: personalOwner ? { ...personalOwner, name: identity.name } : null,
        usernameSuggestion: identity.username ? null : this.uniqueSlug(github?.login ?? usernameSuggestion(user.email)) };
    });
  }
  avatar(slug: string): number | null {
    return this.ctx.storage.sql.exec<{ id: number | null }>("SELECT u.github_id AS id FROM users u JOIN teams t ON t.user_id = u.id JOIN team_addresses a ON a.team_id = t.id WHERE a.slug = ? COLLATE NOCASE AND t.kind = 'user'", slug).toArray()[0]?.id ?? null;
  }
  personalOwner(userId: string): Organization | null {
    const row = this.ctx.storage.sql.exec<{ id: string; name: string; slug: string }>("SELECT id, name, slug FROM teams WHERE kind = 'user' AND user_id = ?", userId).toArray()[0];
    return row ? { ...row, kind: 'user', role: 'owner', workspaces: this.workspaces(row.id).filter(workspace => !this.mirrorRecord(workspace.id)).map(workspace => ({ ...workspace, canWrite: true })) } : null;
  }
  /** Synchronous metadata helpers omit mirrors. API account views add them only after this viewer's own check. */
  private async visibleOwner(userId: string, owner: Organization): Promise<Organization> {
    const candidates = this.workspaces(owner.id).filter(workspace => !!this.mirrorRecord(workspace.id));
    const visible: RepositoryWorkspace[] = [];
    for (const workspace of candidates) {
      const readable = await this.visibleMirror(workspace.id, workspace, userId);
      if (readable) visible.push({ ...readable, canWrite: this.repositoryWriter(userId, owner.id, workspace.id, owner.role) });
    }
    return { ...owner, workspaces: [...owner.workspaces, ...visible] };
  }
  async accountView(user: AccountIdentity, github: GitHubIdentity | null = null) {
    const result = this.account(user, github);
    return { ...result, personalOwner: result.personalOwner ? await this.visibleOwner(user.id, result.personalOwner) : null };
  }
  private ownerAddressTaken(slug: string, ownerId = ''): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM team_addresses WHERE slug = ? COLLATE NOCASE AND team_id != ?', slug, ownerId).toArray().length > 0;
  }
  setUsername(user: AccountIdentity, username: string) {
    return this.ctx.storage.transactionSync(() => {
      this.remember(user);
      const current = this.personalOwner(user.id);
      if (this.ownerAddressTaken(username, current?.id)) throw new HttpError(409, 'This username is already taken.');
      const id = current?.id ?? crypto.randomUUID();
      if (current) this.ctx.storage.sql.exec('UPDATE teams SET slug = ? WHERE id = ?', username, id);
      else {
        const name = personName(user.name);
        this.ctx.storage.sql.exec("INSERT INTO teams (id, name, search_name, slug, kind, user_id, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?)", id, name, searchText(name), username, user.id, now());
        this.ctx.storage.sql.exec("INSERT INTO members (team_id, user_id, role) VALUES (?, ?, 'owner')", id, user.id);
      }
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO team_addresses VALUES (?, ?)', username, id);
      this.ctx.storage.sql.exec('UPDATE users SET username = ? WHERE id = ?', username, user.id);
      if (current?.slug !== username) this.audit(id, user.id, current ? 'account.username-changed' : 'account.username-chosen', id);
      return { user: this.identity(user), personalOwner: this.personalOwner(user.id)!, usernameSuggestion: null };
    });
  }
  /** Names in membership, audit and comments never expose the private sign-in address. */
  personLabel(userId: string): string {
    const row = this.ctx.storage.sql.exec<{ username: string | null; name: string }>('SELECT username, name FROM users WHERE id = ?', userId.replace(/^user:/, '')).toArray()[0];
    return row ? personHandle(row) : personName(userId);
  }
  /** Reconcile Git evidence privately. A display name is only a match when it is an account login. */
  gitPeople(owners: ProvenanceOwner[]): ProvenanceOwner[] {
    return owners.map(owner => {
      const github = owner.github ?? (owner.email ? githubLogin(owner.email) : undefined);
      const login = github ?? owner.name.replace(/^@/, '');
      // Distinct accounts are conflicting evidence, including accounts awaiting a username.
      // Separate indexed probes avoid an OR table scan on this global Directory object.
      const matches = new Map<string, string | null>();
      for (const [column, value] of [['email', owner.email], ['username', login], ['github_login', login]] as const) {
        if (!value) continue;
        const rows = this.ctx.storage.sql.exec<{ id: string; username: string | null }>(
          `SELECT id, username FROM users WHERE ${column} = ? COLLATE NOCASE LIMIT 2`, value,
        ).toArray();
        for (const row of rows) matches.set(row.id, row.username);
        if (matches.size > 1) break;
      }
      const username = matches.size === 1 ? matches.values().next().value : null;
      const { email: _email, ...publicOwner } = owner;
      return username ? { name: `@${username}` }
        : { ...publicOwner, name: personName(owner.name), ...(github ? { github } : {}) };
    });
  }
  private organizationOnly(id: string) {
    if (!this.ctx.storage.sql.exec("SELECT 1 FROM teams WHERE id = ? AND kind = 'organization'", id).toArray().length) throw new HttpError(404, 'Organization not found.');
  }

  notificationPreferences(user: AccountIdentity): NotificationPreferences {
    this.remember(user);
    const row = this.ctx.storage.sql.exec<{ attention: number; returned: number }>('SELECT notify_attention AS attention, notify_returned AS returned FROM users WHERE id = ?', user.id).one();
    return { attention: !!row.attention, returned: !!row.returned };
  }
  updateNotificationPreferences(user: AccountIdentity, patch: Partial<NotificationPreferences>): NotificationPreferences {
    this.remember(user);
    this.ctx.storage.sql.exec('UPDATE users SET notify_attention = COALESCE(?, notify_attention), notify_returned = COALESCE(?, notify_returned) WHERE id = ?',
      patch.attention === undefined ? null : Number(patch.attention), patch.returned === undefined ? null : Number(patch.returned), user.id);
    return this.notificationPreferences(user);
  }
  /** The signed link has an opaque person id. No account or address is returned to its holder. */
  unsubscribeNotifications(person: string, kind: NotificationKind): void {
    const column = kind === 'attention' ? 'notify_attention' : 'notify_returned';
    this.ctx.storage.sql.exec(`UPDATE users SET ${column} = 0 WHERE id = (SELECT user_id FROM public_people WHERE public_id = ?)`, person);
  }

  /** Record once, then let an alarm batch the next minute of mail without holding up the change engine. */
  async enqueuePullRequestNotification({ workspaceId, kind, change, reason }: PullRequestNotification): Promise<void> {
    if (!this.env.EMAIL || !this.env.EMAIL_FROM) return;
    const sql = this.ctx.storage.sql;
    const repository = sql.exec<{ teamId: string }>('SELECT team_id AS teamId FROM workspaces WHERE id = ?', workspaceId).toArray()[0];
    // Recorded examples and single-owner sandboxes have no Directory address or membership.
    if (!repository) return;
    this.ctx.storage.transactionSync(() => {
      if (!sql.exec('INSERT OR IGNORE INTO notification_receipts VALUES (?, ?, ?, ?)', workspaceId, change.id, change.revision, kind).rowsWritten) return;
      const owner = change.author.owner;
      const ownerId = owner?.id?.startsWith('user:') ? owner.id.slice(5)
        : owner?.publicId ? sql.exec<{ userId: string }>('SELECT user_id AS userId FROM public_people WHERE public_id = ?', owner.publicId).toArray()[0]?.userId : undefined;
      const returnedOwner = isAgent(change.author) ? ownerId : undefined;
      const recipients = sql.exec<{ id: string }>(`SELECT u.id FROM users u JOIN members m ON m.user_id = u.id WHERE m.team_id = ? AND ${kind === 'attention' ? "m.role = 'owner' AND u.notify_attention = 1" : 'u.id = ? AND u.notify_returned = 1'}`,
        repository.teamId, ...(kind === 'returned' ? [returnedOwner ?? ''] : [])).toArray();
      const item: NotificationItem = { number: change.number, title: notificationText(change.title, 200), reason: notificationText(reason, 500), simulated: change.author.kind === 'simulated' };
      for (const recipient of recipients) {
        const due = sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM notification_outbox WHERE user_id = ? AND workspace_id = ? AND kind = ? AND attempts = 0', recipient.id, workspaceId, kind).one().due ?? Date.now() + NOTIFICATION_DELAY;
        sql.exec('INSERT INTO notification_outbox (workspace_id, user_id, kind, value, due) VALUES (?, ?, ?, ?, ?)', workspaceId, recipient.id, kind, JSON.stringify(item), due);
      }
    });
    await this.scheduleNotifications();
  }
  private async scheduleNotifications() {
    const due = this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM notification_outbox').one().due;
    if (due !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, due));
  }
  private notificationRecipient(userId: string, workspaceId: string, kind: NotificationKind) {
    return this.ctx.storage.sql.exec<{ email: string; person: string; owner: string; repo: string }>(`SELECT u.email, p.public_id AS person, t.slug AS owner, w.slug AS repo FROM users u JOIN public_people p ON p.user_id = u.id JOIN members m ON m.user_id = u.id JOIN teams t ON t.id = m.team_id JOIN workspaces w ON w.team_id = t.id WHERE u.id = ? AND w.id = ? AND u.email <> '' AND ${kind === 'attention' ? "m.role = 'owner' AND u.notify_attention = 1" : 'u.notify_returned = 1'}`, userId, workspaceId).toArray()[0];
  }
  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    type Pending = { id: number; workspaceId: string; userId: string; kind: NotificationKind; value: string; attempts: number };
    const rows = sql.exec<Pending>('SELECT id, workspace_id AS workspaceId, user_id AS userId, kind, value, attempts FROM notification_outbox WHERE due <= ? ORDER BY due, id LIMIT 500', Date.now()).toArray();
    const groups = new Map<string, Pending[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.userId, row.workspaceId, row.kind]);
      const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const remove = () => { for (const row of group) sql.exec('DELETE FROM notification_outbox WHERE id = ?', row.id); };
      if (!this.env.EMAIL || !this.env.EMAIL_FROM || !this.notificationRecipient(first.userId, first.workspaceId, first.kind)) { remove(); continue; }
      try {
        const budget = await securityOf(this.env).consume(`notification:${first.userId}`, NOTIFICATION_HOURLY_LIMIT, 3_600_000);
        if (!budget.allowed) {
          for (const row of group) sql.exec('UPDATE notification_outbox SET due = ? WHERE id = ?', Date.now() + budget.retryAfter * 1000, row.id);
          continue;
        }
        // Preferences and access may have changed while the budget RPC was in flight.
        const recipient = this.notificationRecipient(first.userId, first.workspaceId, first.kind);
        if (recipient) await sendPullRequestEmail(this.env, recipient, first.kind, group.map(row => JSON.parse(row.value) as NotificationItem));
        remove();
      } catch (error) {
        for (const row of group) {
          if (row.attempts >= 4) sql.exec('DELETE FROM notification_outbox WHERE id = ?', row.id);
          else sql.exec('UPDATE notification_outbox SET attempts = attempts + 1, due = ? WHERE id = ?', Date.now() + NOTIFICATION_DELAY * 2 ** row.attempts, row.id);
        }
        logFailure('notification_delivery_failed', error, { retrying: first.attempts < 4 });
      }
    }
    await this.scheduleNotifications();
  }
  /** UI membership IDs are opaque, including for legacy accounts keyed by an email. */
  private personId(userId: string): string { return `person:${this.recordPerson(userId)}`; }
  private memberId(personId: string): string {
    if (!personId.startsWith('person:')) return personId; // Legacy tabs and internal callers use account IDs.
    const person = this.ctx.storage.sql.exec<{ id: string }>('SELECT user_id AS id FROM public_people WHERE public_id = ?', personId.slice(7)).toArray()[0];
    if (!person) throw new HttpError(404, 'Member not found.');
    return person.id;
  }
  /** Whether this member, who must exist, is the organization's only owner. */
  private lastOwner(teamId: string, memberId: string): boolean {
    return this.role(memberId, teamId) === 'owner' && this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM members WHERE team_id = ? AND role = 'owner'", teamId).one().count <= 1;
  }
  private memberRole(userId: string, teamId: string) { return this.ctx.storage.sql.exec<{ role: OrganizationRole }>('SELECT role FROM members WHERE team_id = ? AND user_id = ?', teamId, userId).toArray()[0]?.role; }
  private role(userId: string, teamId: string, owner = false): OrganizationRole {
    const role = this.memberRole(userId, teamId);
    if (!role) throw new HttpError(404, 'Repository not found.');
    if (owner && role !== 'owner') throw new HttpError(403, 'Only an organization owner can make this change.');
    return role;
  }
  private organizationRole(userId: string, orgId: string, owner = false) { this.organizationOnly(orgId); return this.role(userId, orgId, owner); }
  list(user: AccountIdentity): Organization[] {
    this.remember(user);
    const teams = this.ctx.storage.sql.exec<{ id: string; name: string; slug: string; role: OrganizationRole }>("SELECT t.id, t.name, t.slug, m.role FROM teams t JOIN members m ON m.team_id = t.id WHERE m.user_id = ? AND t.kind = 'organization' ORDER BY t.created_at, t.id", user.id).toArray();
    return teams.map(team => ({ ...team, workspaces: this.workspaces(team.id).filter(workspace => !this.mirrorRecord(workspace.id)).map(workspace => ({ ...workspace, canWrite: this.repositoryWriter(user.id, team.id, workspace.id, team.role) })) }));
  }
  /** The repositories this person can write, personal first, as an agent that connects for them may name them. */
  writableRepositories(user: AccountIdentity, writableOnly = true): { workspaceId: string; address: string }[] {
    const personal = this.personalOwner(user.id);
    return [...(personal ? [personal] : []), ...this.list(user)].flatMap(owner => owner.workspaces.filter(workspace => !writableOnly || workspace.canWrite)
      .map(workspace => ({ workspaceId: workspace.id, address: `${owner.slug}/${workspace.slug}` })));
  }
  private workspaces(teamId: string): RepositoryWorkspace[] {
    return this.ctx.storage.sql.exec<{ id: string; organizationId: string; name: string; slug: string; visibility: Visibility; createdAt: string }>('SELECT id, team_id AS organizationId, name, slug, visibility, created_at AS createdAt FROM workspaces WHERE team_id = ? ORDER BY created_at, id', teamId).toArray();
  }
  createOrganization(user: AccountIdentity, name: string): Organization {
    return this.ctx.storage.transactionSync(() => {
      this.remember(user);
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.role = 'owner' AND t.kind = 'organization'", user.id).one().count;
      if (count >= 3) throw new HttpError(409, 'You can own up to three organizations during early access.');
      const id = crypto.randomUUID(), slug = this.uniqueSlug(name);
      this.ctx.storage.sql.exec('INSERT INTO teams (id, name, search_name, slug, created_at) VALUES (?, ?, ?, ?, ?)', id, name, searchText(name), slug, now());
      this.ctx.storage.sql.exec('INSERT INTO team_addresses VALUES (?, ?)', slug, id);
      this.ctx.storage.sql.exec("INSERT INTO members (team_id, user_id, role) VALUES (?, ?, 'owner')", id, user.id);
      this.audit(id, user.id, 'organization.created', id);
      return { id, name, slug, role: 'owner', workspaces: [] };
    });
  }
  private insertWorkspace(teamId: string, name: string, visibility?: Visibility): RepositoryWorkspace {
    const workspace: RepositoryWorkspace = { id: crypto.randomUUID(), organizationId: teamId, name, slug: this.uniqueSlug(name, teamId), visibility: visibility ?? 'private', createdAt: now() };
    this.ctx.storage.sql.exec("INSERT INTO workspaces (id, team_id, name, slug, visibility, visibility_explicit, legacy_visibility, has_commits, created_at, updated_at, search_name, search_description) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, '')", workspace.id, teamId, name, workspace.slug, workspace.visibility, visibility === undefined ? 0 : 1, workspace.createdAt, workspace.createdAt, searchText(name));
    this.ctx.storage.sql.exec('INSERT INTO repository_addresses VALUES (?, ?, ?)', teamId, workspace.slug, workspace.id);
    return workspace;
  }
  updateTeam(userId: string, { teamId, slug, name }: DirectoryInput['updateTeam']): Organization {
    return this.ctx.storage.transactionSync(() => {
      const role = this.organizationRole(userId, teamId, true);
      if (slug !== undefined) {
        if (this.ownerAddressTaken(slug, teamId)) throw new HttpError(409, 'An owner already has this slug.');
        this.ctx.storage.sql.exec('UPDATE teams SET slug = ? WHERE id = ?', slug, teamId);
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO team_addresses VALUES (?, ?)', slug, teamId);
        this.audit(teamId, userId, 'organization.renamed', teamId);
      }
      if (name !== undefined) {
        this.ctx.storage.sql.exec('UPDATE teams SET name = ?, search_name = ? WHERE id = ?', name, searchText(name), teamId);
        this.audit(teamId, userId, 'organization.name-changed', teamId);
      }
      const team = this.ctx.storage.sql.exec<{ id: string; name: string; slug: string }>('SELECT id, name, slug FROM teams WHERE id = ?', teamId).one();
      return { ...team, role, workspaces: this.workspaces(teamId).filter(workspace => !this.mirrorRecord(workspace.id)) };
    });
  }
  /** Idempotent agent onboarding creates only in this person's private namespace. */
  ensureAgentRepository(user: AccountIdentity, name: string) {
    return this.ctx.storage.transactionSync(() => {
      const account = this.account(user);
      const personal = account.personalOwner ?? this.setUsername(user, account.usernameSuggestion!).personalOwner;
      const existing = personal.workspaces.find(repo => repo.slug === name || repo.name === name);
      const workspace = existing ?? this.createWorkspace(user.id, personal.id, name, 'private');
      return { workspaceId: workspace.id, created: !existing, user: this.identity(user) };
    });
  }
  createWorkspace(userId: string, teamId: string, name: string, visibility?: Visibility): RepositoryWorkspace {
    this.role(userId, teamId, true);
    if (this.workspaces(teamId).length >= 10) throw new HttpError(409, 'This owner has reached its ten-repository limit.');
    return this.ctx.storage.transactionSync(() => {
      const workspace = this.insertWorkspace(teamId, name, visibility);
      this.audit(teamId, userId, 'repository.created', workspace.id);
      return workspace;
    });
  }
  /** Whether a person may read or write a repository now; every write path asks immediately before it writes. */
  async access(user: AccountIdentity, workspaceId: string, write: boolean): Promise<Result<RepositoryGrant>> {
    try { return { ok: true, data: await this.repositoryGrant(user.id, workspaceId, write) }; }
    catch (error) { return refused(error, 500, 'The account operation could not complete.'); }
  }
  /** A private mirror's GitHub readers read it without membership. */
  private async repositoryGrant(userId: string, workspaceId: string, write: boolean): Promise<RepositoryGrant> {
    await this.checkMirrorRead(workspaceId, userId);
    try { return this.authorize(userId, workspaceId, write); }
    catch (error) {
      const mirror = this.mirrorRecord(workspaceId);
      if (!mirror?.private || write || !(error instanceof HttpError) || error.status !== 404) throw error;
      const row = this.ctx.storage.sql.exec<{ ownerSlug: string; repoSlug: string }>('SELECT t.slug AS ownerSlug, w.slug AS repoSlug FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.id = ?', workspaceId).one();
      return { ...row, workspaceId, teamId: mirror.teamId, role: 'member', organizationRole: 'member', readOnly: true, privateMirror: !!mirror.private };
    }
  }
  authorize(userId: string, workspaceId: string, write: boolean): RepositoryGrant {
    const row = this.ctx.storage.sql.exec<{ teamId: string; ownerSlug: string; repoSlug: string }>('SELECT w.team_id AS teamId, t.slug AS ownerSlug, w.slug AS repoSlug FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.id = ?', workspaceId).toArray()[0];
    if (!row) throw new HttpError(404, 'Repository not found.');
    const organizationRole = this.role(userId, row.teamId);
    const canWrite = this.repositoryWriter(userId, row.teamId, workspaceId, organizationRole);
    if (write && !canWrite) throw new HttpError(403, 'An organization owner or a team with write access must authorize this change.');
    const mirror = this.mirrorRecord(workspaceId);
    return { ...row, workspaceId, role: canWrite ? 'owner' : 'member', organizationRole, ...(mirror ? { readOnly: !mirror.enabled, privateMirror: !!mirror.private } : {}) };
  }
  private repositoryWriter(userId: string, orgId: string, workspaceId: string, role: OrganizationRole): boolean {
    if (this.mirrorRecord(workspaceId)?.enabled === 0) return false;
    return role === 'owner' || this.ctx.storage.sql.exec(`SELECT 1 FROM org_teams t
      JOIN org_team_members tm ON tm.team = t.id JOIN members m ON m.user_id = tm.user AND m.team_id = t.org
      JOIN org_team_repositories r ON r.team = t.id JOIN workspaces w ON w.id = r.workspace AND w.team_id = t.org
      WHERE t.org = ? AND tm.user = ? AND r.workspace = ? AND r.permission = 'write' LIMIT 1`, orgId, userId, workspaceId).toArray().length > 0;
  }
  /** The organization's teams, or the one whose id or address is `teamId`. */
  teams(userId: string, orgId: string, teamId?: string): OrganizationTeam[] {
    this.organizationRole(userId, orgId);
    return this.ctx.storage.sql.exec<{ id: string; organizationId: string; slug: string; name: string; description: string; memberCount: number; repositoryCount: number; role: TeamRole | null }>(`SELECT t.id, t.org AS organizationId, t.slug, t.name, t.description,
      (SELECT COUNT(*) FROM org_team_members tm JOIN members m ON m.user_id = tm.user AND m.team_id = t.org WHERE tm.team = t.id) AS memberCount,
      (SELECT COUNT(*) FROM org_team_repositories r JOIN workspaces w ON w.id = r.workspace AND w.team_id = t.org WHERE r.team = t.id AND NOT EXISTS (SELECT 1 FROM mirrors m WHERE m.workspace = w.id)) AS repositoryCount,
      (SELECT role FROM org_team_members WHERE team = t.id AND user = ?) AS role FROM org_teams t WHERE t.org = ?${teamId ? ' AND (t.id = ? OR t.slug = ?)' : ''} ORDER BY t.name, t.id`, userId, orgId, ...(teamId ? [teamId, teamId] : [])).toArray();
  }
  private orgTeam(userId: string, orgId: string, teamId: string, manage: 'owner' | 'members' | 'read' = 'read'): OrganizationTeam {
    const role = this.role(userId, orgId);
    const team = this.teams(userId, orgId, teamId)[0];
    if (!team) throw new HttpError(404, 'Team not found.');
    if (role !== 'owner' && (manage === 'owner' || manage === 'members' && team.role !== 'maintainer')) throw new HttpError(403, manage === 'members' ? 'An organization owner or team maintainer can manage members.' : 'Only an organization owner can manage this team.');
    return team;
  }
  teamDetail(userId: string, orgId: string, teamId: string): TeamDetail {
    const team = this.orgTeam(userId, orgId, teamId);
    const owner = this.role(userId, orgId) === 'owner';
    const members = this.ctx.storage.sql.exec<{ id: string; name: string; role: TeamRole }>('SELECT u.id, u.name, tm.role FROM org_team_members tm JOIN users u ON u.id = tm.user JOIN members m ON m.user_id = u.id AND m.team_id = ? WHERE tm.team = ? ORDER BY u.name, u.id', orgId, team.id).toArray().map(member => ({ ...member, id: this.personId(member.id), name: this.personLabel(member.id) }));
    const repositories = this.ctx.storage.sql.exec<{ id: string; slug: string; name: string; permission: RepositoryPermission }>('SELECT w.id, w.slug, w.name, r.permission FROM org_team_repositories r JOIN workspaces w ON w.id = r.workspace AND w.team_id = ? WHERE r.team = ? AND NOT EXISTS (SELECT 1 FROM mirrors m WHERE m.workspace = w.id) ORDER BY w.name, w.id', orgId, team.id).toArray();
    return { team, members, repositories, canManage: owner, canManageMembers: owner || team.role === 'maintainer' };
  }
  createOrgTeam(userId: string, { orgId, name, description = '' }: DirectoryInput['createOrgTeam']): TeamDetail {
    return this.ctx.storage.transactionSync(() => {
      this.role(userId, orgId, true);
      if (this.teams(userId, orgId).length >= 100) throw new HttpError(409, 'This organization has reached its 100-team limit.');
      const id = crypto.randomUUID(), slug = slugOf(name) || `team-${id.slice(0, 6)}`;
      if (this.ctx.storage.sql.exec('SELECT 1 FROM org_teams WHERE org = ? AND slug = ?', orgId, slug).toArray().length) throw new HttpError(409, 'A team already has this address.');
      this.ctx.storage.sql.exec('INSERT INTO org_teams VALUES (?, ?, ?, ?, ?)', id, orgId, slug, name, description);
      this.audit(orgId, userId, 'organization-team.created', id);
      return this.teamDetail(userId, orgId, id);
    });
  }
  updateOrgTeam(userId: string, input: DirectoryInput['updateOrgTeam']): TeamDetail {
    return this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, input.orgId, input.teamId, 'owner');
      if (input.slug && this.ctx.storage.sql.exec('SELECT 1 FROM org_teams WHERE org = ? AND slug = ? AND id != ?', input.orgId, input.slug, team.id).toArray().length) throw new HttpError(409, 'A team already has this address.');
      this.ctx.storage.sql.exec('UPDATE org_teams SET name = ?, slug = ?, description = ? WHERE id = ?', input.name ?? team.name, input.slug ?? team.slug, input.description ?? team.description, team.id);
      this.audit(input.orgId, userId, 'organization-team.updated', team.id);
      return this.teamDetail(userId, input.orgId, team.id);
    });
  }
  deleteOrgTeam(userId: string, { orgId, teamId }: DirectoryInput['deleteOrgTeam']) {
    this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, orgId, teamId, 'owner');
      this.ctx.storage.sql.exec('DELETE FROM org_team_members WHERE team = ?', team.id);
      this.ctx.storage.sql.exec('DELETE FROM org_team_repositories WHERE team = ?', team.id);
      this.ctx.storage.sql.exec('DELETE FROM org_teams WHERE id = ?', team.id);
      this.audit(orgId, userId, 'organization-team.deleted', team.id);
    });
  }
  setTeamMember(userId: string, { orgId, teamId, memberId, role }: DirectoryInput['setTeamMember']): TeamDetail {
    memberId = this.memberId(memberId);
    return this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, orgId, teamId, 'members');
      this.role(memberId, orgId);
      this.ctx.storage.sql.exec('INSERT INTO org_team_members VALUES (?, ?, ?) ON CONFLICT(team, user) DO UPDATE SET role = excluded.role', team.id, memberId, role);
      this.audit(orgId, userId, 'organization-team.member-set', `${team.id}:${memberId}`);
      return this.teamDetail(userId, orgId, team.id);
    });
  }
  removeTeamMember(userId: string, { orgId, teamId, memberId }: DirectoryInput['removeTeamMember']): TeamDetail {
    memberId = this.memberId(memberId);
    return this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, orgId, teamId, 'members');
      this.ctx.storage.sql.exec('DELETE FROM org_team_members WHERE team = ? AND user = ?', team.id, memberId);
      this.audit(orgId, userId, 'organization-team.member-removed', `${team.id}:${memberId}`);
      return this.teamDetail(userId, orgId, team.id);
    });
  }
  private orgRepository(orgId: string, workspaceId: string) {
    if (!this.ctx.storage.sql.exec('SELECT 1 FROM workspaces WHERE team_id = ? AND id = ?', orgId, workspaceId).toArray().length) throw new HttpError(404, 'Repository not found.');
  }
  setTeamRepository(userId: string, { orgId, teamId, workspaceId, permission }: DirectoryInput['setTeamRepository']): TeamDetail {
    return this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, orgId, teamId, 'owner');
      this.orgRepository(orgId, workspaceId);
      this.ctx.storage.sql.exec('INSERT INTO org_team_repositories VALUES (?, ?, ?) ON CONFLICT(team, workspace) DO UPDATE SET permission = excluded.permission', team.id, workspaceId, permission);
      this.audit(orgId, userId, `organization-team.repository-${permission}`, `${team.id}:${workspaceId}`);
      return this.teamDetail(userId, orgId, team.id);
    });
  }
  removeTeamRepository(userId: string, { orgId, teamId, workspaceId }: DirectoryInput['removeTeamRepository']): TeamDetail {
    return this.ctx.storage.transactionSync(() => {
      const team = this.orgTeam(userId, orgId, teamId, 'owner');
      this.orgRepository(orgId, workspaceId);
      this.ctx.storage.sql.exec('DELETE FROM org_team_repositories WHERE team = ? AND workspace = ?', team.id, workspaceId);
      this.audit(orgId, userId, 'organization-team.repository-revoked', `${team.id}:${workspaceId}`);
      return this.teamDetail(userId, orgId, team.id);
    });
  }
  repositoryAccess(userId: string, orgId: string, workspaceId: string): RepositoryAccess {
    this.role(userId, orgId);
    this.orgRepository(orgId, workspaceId);
    const owners = this.memberRows(userId, orgId).filter(member => member.role === 'owner');
    const teams = this.ctx.storage.sql.exec<{ id: string; slug: string; name: string; permission: RepositoryPermission }>('SELECT t.id, t.slug, t.name, r.permission FROM org_teams t JOIN org_team_repositories r ON r.team = t.id WHERE t.org = ? AND r.workspace = ? ORDER BY t.name, t.id', orgId, workspaceId).toArray();
    return { owners, teams };
  }
  private memberRows(userId: string, teamId: string): OrganizationMember[] {
    return this.ctx.storage.sql.exec<{ id: string; username: string | null; role: OrganizationRole }>('SELECT u.id, u.username, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.username, u.id', teamId).toArray().map(member => ({ id: this.personId(member.id), self: member.id === userId, name: this.personLabel(member.id), username: member.username, role: member.role }));
  }
  members(userId: string, teamId: string): { members: OrganizationMember[]; invites: OrganizationInvite[] } {
    const role = this.organizationRole(userId, teamId);
    const invites = role === 'owner' ? this.ctx.storage.sql.exec<{ id: string; role: OrganizationRole; expires: number }>('SELECT id, role, expires FROM invites WHERE team_id = ? AND accepted_by IS NULL AND expires > ? ORDER BY email', teamId, Date.now()).toArray().map(({ expires, ...invite }) => ({ ...invite, expiresAt: new Date(expires).toISOString() })) : [];
    return { members: this.memberRows(userId, teamId), invites };
  }
  async invite(userId: string, teamId: string, { email, role }: { email: string; role: OrganizationRole }) {
    this.organizationRole(userId, teamId, true);
    const { token, hash } = await inviteSecret();
    return this.ctx.storage.transactionSync(() => {
      this.role(userId, teamId, true); // Membership might have changed while hashing.
      const seats = this.ctx.storage.sql.exec<{ count: number }>('SELECT (SELECT COUNT(*) FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?) + (SELECT COUNT(*) FROM invites WHERE team_id = ? AND accepted_by IS NULL AND expires > ?) AS count', teamId, teamId, Date.now()).one().count;
      if (seats >= 20) throw new HttpError(409, 'This organization has reached its twenty-member limit.');
      if (this.ctx.storage.sql.exec('SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?', teamId, email).toArray().length) throw new HttpError(409, 'That person already belongs to this organization.');
      this.ctx.storage.sql.exec('DELETE FROM invites WHERE team_id = ? AND email = ? AND accepted_by IS NULL', teamId, email);
      const id = crypto.randomUUID(), expiresAt = inviteExpiry();
      this.ctx.storage.sql.exec('INSERT INTO invites (id, team_id, email, role, digest, expires) VALUES (?, ?, ?, ?, ?, ?)', id, teamId, email, role, hash, Date.parse(expiresAt));
      this.audit(teamId, userId, 'invite.created', id);
      return { id, role, expiresAt, token };
    });
  }
  async accept(user: AccountIdentity, token: string): Promise<{ organizationId: string }> {
    const hash = await digest(token);
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ id: string; team_id: string; email: string; role: OrganizationRole; expires: number; accepted_by: string | null }>('SELECT id, team_id, email, role, expires, accepted_by FROM invites WHERE digest = ?', hash).toArray()[0];
      if (!row || row.expires <= Date.now() || row.accepted_by) throw new HttpError(410, 'This invitation expired, was revoked, or has already been accepted.');
      this.organizationOnly(row.team_id);
      if (row.email !== user.email.toLowerCase()) throw new HttpError(403, 'Sign in with the email address this invitation was sent to.');
      this.remember(user);
      // Invitations do not change existing members' roles.
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO members (team_id, user_id, role) VALUES (?, ?, ?)', row.team_id, user.id, row.role);
      this.ctx.storage.sql.exec('UPDATE invites SET accepted_by = ? WHERE id = ?', user.id, row.id);
      this.audit(row.team_id, user.id, 'invite.accepted', row.id);
      return { organizationId: row.team_id };
    });
  }
  updateMember(userId: string, { teamId, memberId, role }: DirectoryInput['updateMember']) {
    this.organizationRole(userId, teamId, true);
    memberId = this.memberId(memberId);
    this.ctx.storage.transactionSync(() => {
      if (this.lastOwner(teamId, memberId) && role !== 'owner') throw new HttpError(409, 'An organization must retain at least one owner.');
      this.ctx.storage.sql.exec('UPDATE members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, memberId);
      this.audit(teamId, userId, 'member.role-changed', memberId);
    });
  }
  async replaceInvite(userId: string, teamId: string, inviteId: string) {
    this.organizationRole(userId, teamId, true);
    const { token, hash } = await inviteSecret();
    return this.ctx.storage.transactionSync(() => {
      this.role(userId, teamId, true);
      const invitation = this.ctx.storage.sql.exec<{ role: OrganizationRole }>('SELECT role FROM invites WHERE team_id = ? AND id = ? AND accepted_by IS NULL AND expires > ?', teamId, inviteId, Date.now()).toArray()[0];
      if (!invitation) throw new HttpError(404, 'Invitation not found.');
      const expiresAt = inviteExpiry();
      this.ctx.storage.sql.exec('UPDATE invites SET digest = ?, expires = ? WHERE id = ?', hash, Date.parse(expiresAt), inviteId);
      this.audit(teamId, userId, 'invite.replaced', inviteId);
      return { id: inviteId, role: invitation.role, expiresAt, token };
    });
  }
  revokeInvite(userId: string, teamId: string, inviteId: string) {
    this.organizationRole(userId, teamId, true);
    this.ctx.storage.sql.exec('DELETE FROM invites WHERE team_id = ? AND id = ?', teamId, inviteId);
    this.audit(teamId, userId, 'invite.revoked', inviteId);
  }
  removeMember(userId: string, teamId: string, memberId: string) {
    this.organizationRole(userId, teamId, true);
    memberId = this.memberId(memberId);
    this.ctx.storage.transactionSync(() => {
      if (this.lastOwner(teamId, memberId)) throw new HttpError(409, 'An organization must retain at least one owner.');
      this.ctx.storage.sql.exec('DELETE FROM org_team_members WHERE user = ? AND team IN (SELECT id FROM org_teams WHERE org = ?)', memberId, teamId);
      this.ctx.storage.sql.exec('DELETE FROM members WHERE team_id = ? AND user_id = ?', teamId, memberId);
      this.audit(teamId, userId, 'member.removed', memberId);
    });
  }
  auditLog(userId: string, teamId: string, before: number) {
    this.role(userId, teamId, true);
    return this.ctx.storage.sql.exec<{ id: number; actor: string; action: string; target: string; createdAt: string }>('SELECT id, actor, action, target, created_at AS createdAt FROM audit WHERE team_id = ? AND id < ? ORDER BY id DESC LIMIT 100', teamId, before).toArray().map(entry => ({ ...entry, actor: this.personLabel(entry.actor), target: this.publicPerson(entry.target) ? this.personLabel(entry.target) : redactPublicText(entry.target) }));
  }
}

/** An invitation's secret: its holder receives the token once, and only its digest is stored. */
async function inviteSecret() {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  return { token, hash: await digest(token) };
}
/** Invitations last a week from when they are created or replaced. */
const inviteExpiry = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

/** GitHub's immutable numeric identity also works for linked email accounts. */
const githubAvatar = (id: number | null, username: string | null): string | null => id === null || username === null ? null : `/api/owners/${username}/avatar`;
