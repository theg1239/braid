import type { ChangeAuthor } from './types';

export interface BranchCommit { hash: string; title: string; time: string; author: ChangeAuthor }
export interface RepositoryBranch { name: string; tip: BranchCommit | null }
export interface RepositoryBranches { defaultBranch: string; branches: RepositoryBranch[] }
export interface ComparedFile {
  path: string; additions: number; deletions: number;
  added: boolean; deleted: boolean; binary: boolean; tooLarge: boolean;
  beforeMode?: string; afterMode?: string;
}
export interface RepositoryComparison {
  base: string; head: string; mergeBase: string | null;
  status: 'ready' | 'identical' | 'unrelated' | 'limited' | 'multiple-bases';
  commits: BranchCommit[]; commitsTruncated: boolean;
  files: ComparedFile[]; filesTruncated: boolean;
}
export interface RepositoryDiff {
  path: string; before: string | null; after: string | null; binary: boolean; tooLarge: boolean;
}
