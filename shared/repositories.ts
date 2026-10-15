import type { RepositoryListing } from './account';

export type RepositorySort = 'updated' | 'name';

export interface RepositorySearch {
  q?: string;
  sort?: RepositorySort;
}

/** Name cursors carry only the redacted, case-folded public name. */
export type RepositoryCursor = {
  updatedAt: string;
  id: string;
} & ({ sort?: 'updated' } | { sort: 'name'; name: string });

export interface RepositoryPage {
  items: RepositoryListing[];
  nextCursor: string | null;
  /** The complete match count, included when searching. */
  total?: number;
}
