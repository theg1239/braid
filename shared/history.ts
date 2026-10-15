import type { ChangeAuthor } from './types';

export interface RepositoryCommit {
  hash: string;
  title: string;
  at: string;
  author: ChangeAuthor;
  pullRequest?: number;
}

export interface CommitPage {
  ref: string;
  path: string;
  items: RepositoryCommit[];
  nextCursor: string | null;
}

export interface CommitFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Null when binary content or a read limit prevents counting lines. */
  additions: number | null;
  deletions: number | null;
  /** Monospace columns across both texts, including tabs and wide characters, for wrapped diff reservations. */
  textColumns?: number;
  binary: boolean;
  tooLarge: boolean;
  beforeMode?: string;
  afterMode?: string;
}

export interface CommitDetail extends RepositoryCommit {
  message: string;
  parents: string[];
  files: CommitFile[];
  filesTruncated: boolean;
  /** A shallow import can contain this commit without its first parent. */
  parentUnavailable: boolean;
}

export interface CommitDiff {
  path: string;
  before: string | null;
  after: string | null;
  binary: boolean;
  tooLarge: boolean;
}
