export interface RepositoryEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'submodule';
  hash: string;
  mode: string;
  lastCommit?: { hash: string; title: string; at: string };
}
export interface RepositoryTree {
  ref: string;
  path: string;
  entries: RepositoryEntry[];
  nextCursor: string | null;
  /** On tree/commits: every entry in the directory has a witnessed last commit. */
  historyComplete?: boolean;
}
export interface RepositoryFile {
  content: string;
  path: string;
  ref: string;
  kind?: 'text' | 'binary' | 'large' | 'symlink' | 'submodule' | 'dir';
  size?: number;
  hash?: string;
}
