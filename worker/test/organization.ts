import type { AccountIdentity, Visibility } from '../../shared/account';
import type { Directory } from '../accounts/directory';

/** Repository-focused tests explicitly create their fixture; organizations themselves start empty. */
export function organizationWithRepository(directory: Directory, user: AccountIdentity, name: string, visibility?: Visibility) {
  const organization = directory.createOrganization(user, name);
  const workspace = directory.createWorkspace(user.id, organization.id, 'Repository', visibility);
  return { ...organization, workspaces: [workspace] };
}
