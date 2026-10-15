/** Offsets are UTF-16 indices into the displayed path or content, with an exclusive end. */
export interface SearchHighlight { start: number; end: number }
export interface SearchLine { line: number; content: string; highlights: SearchHighlight[] }
export interface RepositorySearch {
  /** The immutable commit searched. */
  ref: string;
  files: { path: string; highlights: SearchHighlight[] }[];
  results: { path: string; matches: SearchLine[] }[];
  /** Number of content occurrences, excluding filename matches. */
  matchCount: number;
  truncated: boolean;
}

export interface SearchRepository {
  owner: string;
  name: string;
  visibility: 'public' | 'private';
  recorded?: boolean;
}
export interface GlobalSearch {
  repositories: (SearchRepository & RepositorySearch)[];
  searched: SearchRepository[];
  unavailable: SearchRepository[];
  matchCount: number;
  truncated: boolean;
}
