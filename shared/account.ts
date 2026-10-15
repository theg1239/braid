export type OrganizationRole = 'owner' | 'member';
/** An empty email means no verified email is available. Old sessions predate usernames; account responses always include username and avatarUrl. */
export interface AccountIdentity { id: string; email: string; name: string; username?: string | null; avatarUrl?: string | null }
export type OwnerKind = 'user' | 'organization';
/** Who may read a repository without signing in. Writes always need an account with access. */
export type Visibility = 'public' | 'private';
/**
 * A repository. `slug` is its address under its organization, as in `/<organization slug>/<slug>`; a public one can be read by
 * anyone, signed in or not.
 */
export interface RepositoryWorkspace { id: string; organizationId: string; name: string; slug: string; visibility: Visibility; createdAt: string; canWrite?: boolean }
export interface Organization { id: string; name: string; slug: string; role: OrganizationRole; workspaces: RepositoryWorkspace[]; kind?: OwnerKind }
/** A repository found by its address, as `GET /api/repos/:owner/:repo` answers for anyone who may read it. */
export interface RepositoryAddress {
  workspaceId: string; owner: { slug: string; name: string; kind?: OwnerKind }; repo: { slug: string; name: string };
  visibility: Visibility;
  /** Whether this viewer may change it: a signed-in member with write access. */
  canWrite: boolean;
  mirror?: { source: string; syncedAt: string | null; importing: boolean; claimable: boolean; /** Server reservation time for the first copy, including preparation. */ startedAt?: string };
}
/** Public repositories, newest activity first, for the landing page and Explore (`GET /api/repos`). */
export interface RepositoryListing { owner: { slug: string; name: string }; repo: { slug: string; name: string }; description?: string; updatedAt: string }
export interface Account { user: AccountIdentity | null; provider: 'github' | 'access' | 'owner-key'; organizations: Organization[]; personalOwner?: Organization | null; usernameSuggestion?: string | null; signupEnabled: boolean; methods: { github: boolean; email: boolean; passkeys: boolean } }
/** Every repository owner available to the person, with their personal space first. */
export function accountOwners(account: Account | null): Organization[] {
  return account ? [...(account.personalOwner ? [account.personalOwner] : []), ...account.organizations] : [];
}
export interface OrganizationMember { id: string; self: boolean; email?: string; name: string; username?: string | null; role: OrganizationRole }
export interface OrganizationInvite { id: string; email?: string; role: OrganizationRole; expiresAt: string }
/** Personal email preferences; both kinds are enabled for new and existing accounts. */
export interface NotificationPreferences { attention: boolean; returned: boolean }
export type NotificationKind = keyof NotificationPreferences;

/** A team belongs to one organization. Repository permissions never cross that boundary. */
export type TeamRole = 'maintainer' | 'member';
export type RepositoryPermission = 'read' | 'write';
export interface OrganizationTeam {
  id: string; organizationId: string; slug: string; name: string; description: string;
  memberCount: number; repositoryCount: number; role: TeamRole | null;
}
export interface TeamDetail {
  team: OrganizationTeam; members: { id: string; name: string; role: TeamRole }[];
  repositories: { id: string; slug: string; name: string; permission: RepositoryPermission }[];
  canManage: boolean; canManageMembers: boolean;
}
export interface RepositoryAccess {
  owners: OrganizationMember[];
  teams: (Pick<OrganizationTeam, 'id' | 'slug' | 'name'> & { permission: RepositoryPermission })[];
}
