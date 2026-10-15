import { createContext, useContext } from 'react';
import type { RepositoryAddress } from '../../shared/account';
import type { WorkspaceSnapshot } from '../../shared/types';
import type { OwnerRepositories } from '../../shared/owners';
import { request } from '../lib/api';

export interface RepositoryMirror {
  source: string;
  syncedAt: string | null;
  importing: boolean;
  /** Server-recorded reservation time for the first copy, including its preparation. */
  startedAt?: string;
  claimable?: boolean;
}
export type MirrorAddress = RepositoryAddress & { mirror?: RepositoryMirror };
export type MirrorSnapshot = WorkspaceSnapshot & { mirror?: RepositoryMirror };
/** `link` joins a Braid organization of the same name to GitHub instead of claiming a new owner. */
interface OwnerClaim { claimable: boolean; kind?: 'user' | 'organization'; link?: boolean; owned?: boolean; reason?: string }
export type MirrorOwnerRepositories = OwnerRepositories & { mirror?: boolean; claimable?: boolean; owner: OwnerRepositories['owner'] & { mirror?: boolean; claimable?: boolean } };

export const MirrorContext = createContext<RepositoryMirror | null>(null);
export const useMirror = () => useContext(MirrorContext);
const claimPath = (slug: string) => `/api/owners/${encodeURIComponent(slug)}/claim`;
export const ownerClaim = (slug: string) => request<OwnerClaim>(claimPath(slug));
export const claimOwner = (slug: string) => request<{ ok: true; role: 'owner' | 'member' }>(claimPath(slug), { method: 'POST' });

/** The codes a GitHub mirror refuses with. Each shows `MirrorError` with the server's reason instead of a generic failure. */
export const MIRROR_NOT_FOUND = 'github_not_found_or_private';
export const MIRROR_TOO_LARGE = 'mirror_too_large';
export const isMirrorFailure = (code: string | null | undefined) => code === MIRROR_NOT_FOUND || code === MIRROR_TOO_LARGE;
