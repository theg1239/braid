import * as v from 'valibot';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { RepositoryWorkspace, Organization, OrganizationInvite, OrganizationMember, OrganizationRole, Visibility, OrganizationTeam, TeamDetail, TeamRole, RepositoryPermission, RepositoryAccess } from '../../shared/account';
import type { MirrorOwnerRepositories } from './mirrors';
import type { RepositoryPage, RepositorySearch } from '../../shared/repositories';
import { errorMessage, request } from '../lib/api';
import { accountFields, organizationResponse } from './read';

import type { AgentScope } from '../../shared/types';
export type { AgentScope } from '../../shared/types';

/** A pending agent request, as the approval screen shows it. `expires` is epoch milliseconds. */
export interface AgentRequest {
  label: string;
  scope: AgentScope;
  expires: number;
}

export interface AgentConnection {
  id: string;
  workspaceId: string;
  scope: AgentScope;
  label: string;
  expires: number;
}

export interface Passkey {
  id: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  createdAt: string;
}

export interface CreatedInvite extends OrganizationInvite {
  token: string;
}

export interface OrganizationRoster {
  members: OrganizationMember[];
  invites: OrganizationInvite[];
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const orgTeam = (orgId: string, teamId: string) => `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`;
const remove: RequestInit = { method: 'DELETE' };
const organization = (id: string) => `/api/orgs/${encodeURIComponent(id)}`;
const agentRequest = (code: string) => `/api/agent/requests/${encodeURIComponent(code)}`;

/** A browser closing the passkey sheet is not a failure worth a technical message. */
export function passkeyError(error: unknown): string {
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return 'The passkey request was cancelled.';
  return errorMessage(error);
}

/**
 * Account, organization and sign-in endpoints for the screens that change them. They use the session cookie and never
 * carry a repository scope. The account read every page needs is in read.ts.
 */
export const accountApi = {
  username: async (username: string) => v.parse(v.object({ user: accountFields.user, personalOwner: organizationResponse, usernameSuggestion: v.nullable(v.string()) }), await request<unknown>('/api/account/username', patch({ username }))),

  emailStart: (email: string) => request<{ flowId: string; expiresAt: string }>('/api/auth/email/start', post({ email })),
  emailVerify: (flowId: string, code: string) => request<{ ok: true }>('/api/auth/email/verify', post({ flowId, code })),
  passkeySignInOptions: () => request<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkeys/authenticate/options', post({})),
  passkeySignIn: (flowId: string, response: AuthenticationResponseJSON) => request<{ ok: true }>('/api/auth/passkeys/authenticate/verify', post({ flowId, response })),
  passkeyRegisterOptions: () => request<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/register/options', post({})),
  passkeyRegister: (flowId: string, response: RegistrationResponseJSON) => request<{ ok: true }>('/api/auth/passkeys/register/verify', post({ flowId, response })),
  passkeys: () => request<Passkey[]>('/api/auth/passkeys'),
  removePasskey: (id: string) => request<{ ok: true }>(`/api/auth/passkeys/${encodeURIComponent(id)}`, remove),

  teams: (orgId: string) => request<OrganizationTeam[]>(`${organization(orgId)}/teams`),
  team: (orgId: string, teamId: string) => request<TeamDetail>(orgTeam(orgId, teamId)),
  createTeam: (orgId: string, name: string, description: string) => request<TeamDetail>(`${organization(orgId)}/teams`, post({ name, description })),
  updateTeam: (orgId: string, teamId: string, changes: { name?: string; slug?: string; description?: string }) => request<TeamDetail>(orgTeam(orgId, teamId), patch(changes)),
  deleteTeam: (orgId: string, teamId: string) => request<{ ok: true }>(orgTeam(orgId, teamId), remove),
  setTeamMember: (orgId: string, teamId: string, memberId: string, role: TeamRole) => request<TeamDetail>(`${orgTeam(orgId, teamId)}/members/${encodeURIComponent(memberId)}`, put({ role })),
  removeTeamMember: (orgId: string, teamId: string, memberId: string) => request<TeamDetail>(`${orgTeam(orgId, teamId)}/members/${encodeURIComponent(memberId)}`, remove),
  setTeamRepository: (orgId: string, teamId: string, workspaceId: string, permission: RepositoryPermission) => request<TeamDetail>(`${orgTeam(orgId, teamId)}/repositories/${encodeURIComponent(workspaceId)}`, put({ permission })),
  removeTeamRepository: (orgId: string, teamId: string, workspaceId: string) => request<TeamDetail>(`${orgTeam(orgId, teamId)}/repositories/${encodeURIComponent(workspaceId)}`, remove),
  repositoryAccess: (orgId: string, workspaceId: string) => request<RepositoryAccess>(`/api/owners/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/access`),
  createOrganization: (name: string) => request<Organization>('/api/orgs', post({ name })),
  updateOrganization: (teamId: string, changes: { slug?: string; name?: string }) => request<Organization>(organization(teamId), patch(changes)),
  createWorkspace: (teamId: string, name: string, visibility: Visibility) => request<RepositoryWorkspace>(`/api/owners/${encodeURIComponent(teamId)}/workspaces`, post({ name, visibility })),
  /** Owners rename a repository, change its slug or make it public or private. */
  updateWorkspace: (teamId: string, workspaceId: string, changes: { visibility?: Visibility; slug?: string; name?: string }) =>
    request<RepositoryWorkspace>(`/api/owners/${encodeURIComponent(teamId)}/workspaces/${encodeURIComponent(workspaceId)}`, patch(changes)),
  /** Public repositories, with the same search and sort on every page. */
  repositories: (cursor?: string | null, limit = 30, { q, sort }: RepositorySearch = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    if (q) query.set('q', q);
    if (sort) query.set('sort', sort);
    return request<RepositoryPage>(`/api/repos?${query}`);
  },
  owner: async (slug: string): Promise<MirrorOwnerRepositories> => v.parse(v.object({
    owner: v.object({ slug: v.string(), name: v.string(), kind: v.optional(v.picklist(['user', 'organization']), 'organization'), avatarUrl: v.optional(v.nullable(v.string()), null), mirror: v.optional(v.boolean()), claimable: v.optional(v.boolean()) }),
    mirror: v.optional(v.boolean()), claimable: v.optional(v.boolean()),
    memberCount: v.optional(v.number()),
    repositories: v.array(v.object({ slug: v.string(), name: v.string(), description: v.string(), visibility: v.picklist(['public', 'private']), updatedAt: v.string() })),
  }), await request<unknown>(`/api/owners/${encodeURIComponent(slug)}`)),
  /** An organization's members and, for its owners, the open invitations. */
  roster: (teamId: string) => request<OrganizationRoster>(`${organization(teamId)}/members`),
  invite: (teamId: string, email: string, role: OrganizationRole) => request<CreatedInvite>(`${organization(teamId)}/invites`, post({ email, role })),
  revokeInvite: (teamId: string, inviteId: string) => request<{ ok: true }>(`${organization(teamId)}/invites/${encodeURIComponent(inviteId)}`, remove),
  replaceInvite: (orgId: string, inviteId: string) => request<CreatedInvite>(`${organization(orgId)}/invites/${encodeURIComponent(inviteId)}`, post({})),
  updateMember: (orgId: string, userId: string, role: OrganizationRole) => request<{ ok: true }>(`${organization(orgId)}/members/${encodeURIComponent(userId)}`, patch({ role })),
  removeMember: (teamId: string, userId: string) => request<{ ok: true }>(`${organization(teamId)}/members/${encodeURIComponent(userId)}`, remove),
  audit: (teamId: string) => request<AuditEntry[]>(`${organization(teamId)}/audit`),
  acceptInvite: (token: string) => request<{ organizationId: string }>('/api/invites/accept', post({ token })),

  agentRequest: (code: string) => request<AgentRequest>(agentRequest(code)),
  approveAgent: (code: string, workspaceId: string, scope: AgentScope) => request<{ ok: true }>(agentRequest(code), post({ workspaceId, scope })),
  denyAgent: (code: string) => request<{ ok: true }>(agentRequest(code), remove),
  connections: () => request<AgentConnection[]>('/api/agent/connections'),
  revokeConnection: (id: string) => request<{ ok: true }>(`/api/agent/connections/${encodeURIComponent(id)}`, remove),
};

/** What each agent permission allows, in the words the approval screen and the connection list share. */
export const AGENT_SCOPE: Record<AgentScope, { label: string; allows: string }> = {
  work: { label: 'Local work', allows: 'Read this repository, share progress and submit proposals for seven days. You can revoke access at any time. Git access is read-only; merging requires your approval.' },
  read: { label: 'Read', allows: 'Read the repository, tasks and context.' },
  setup: { label: 'Set up', allows: 'Read everything, create or import the repository, add context and start tasks.' },
  fleet: { label: 'Agent fleet', allows: 'Run many agents under this approval for seven days. Each agent gets its own identity, earns trust separately and submits changes that your policy decides; none can approve or merge.' },
};
