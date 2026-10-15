/** GET /api/changes/:id/guide?revision=N. Kinds and reading order are authored by the model. */
export type GuideChapterKind = 'logic' | 'tests' | 'generated' | 'docs' | 'config' | 'mechanical';
export interface GuideHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }
/** Only explicit .gitattributes values. Omitted means unspecified; false is an explicit unset. */
export interface GuideFileAttributes { path: string; generated?: boolean; vendored?: boolean }
export interface GuideChapter {
  id: string; title: string; summary: string; kind: GuideChapterKind;
  files: { path: string; hunks: GuideHunk[] }[];
}
export interface ChangeGuide {
  status: 'ready' | 'pending' | 'failed'; revision: number;
  before?: string; after?: string; error?: string;
  chapters: GuideChapter[];
  /** Workers AI model ID, including for pending and failed runs. */
  generatedBy: string;
  attributes: GuideFileAttributes[];
}
