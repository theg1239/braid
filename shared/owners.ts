import type { OwnerKind, Visibility } from './account';

/** An organization's repositories visible to the caller, newest activity first. */
export interface OwnerRepositories {
  owner: { slug: string; name: string; kind?: OwnerKind; avatarUrl?: string | null };
  memberCount?: number;
  /** An unclaimed GitHub namespace, with no Braid members. */
  mirror?: boolean;
  repositories: { slug: string; name: string; description: string; visibility: Visibility; updatedAt: string }[];
}
