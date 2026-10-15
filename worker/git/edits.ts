import type { GitFileEdit as TextEdit } from '../../shared/changes';

/** A blob already stored in this repository. Its bytes never enter a landing plan. */
export interface BlobEdit { blob: string; mode?: '100644' | '100755' }
export type GitFileEdit = TextEdit | BlobEdit;
export const isBlobEdit = (edit: GitFileEdit): edit is BlobEdit => edit !== null && typeof edit === 'object' && 'blob' in edit;
export function editContent(edit: GitFileEdit): string | null {
  if (isBlobEdit(edit)) throw new Error('Read the Git blob before using its text.');
  return edit === null || typeof edit === 'string' ? edit : edit.content;
}
export function editedFiles(files: Record<string, GitFileEdit>) {
  return Object.entries(files).map(([path, edit]) => isBlobEdit(edit) ? { path, ...edit }
    : { path, content: editContent(edit), ...(edit && typeof edit !== 'string' ? { mode: edit.mode } : {}) });
}
