import type { FileChange } from './types';

/** Final file identity, including deletion and executable-bit changes. */
export function changeIdentity(file: FileChange): string {
  return JSON.stringify([file.deleted ?? false, file.mode ?? null, file.afterHash ?? file.after]);
}

export type GitFileEdit = string | null | { content: string; mode: '100644' | '100755' };
export function fileEdit(file: FileChange): GitFileEdit {
  if (file.contentRef) throw new Error('Load stored proposal content before publishing.');
  return file.deleted ? null : file.mode ? { content: file.after, mode: file.mode } : file.after;
}
/** The new text an edit leaves, or null when it deletes the file. */
export function editContent(edit: GitFileEdit): string | null {
  return edit === null || typeof edit === 'string' ? edit : edit.content;
}
/** Edits by path, as the file list a change submits. */
export function editedFiles(files: Record<string, GitFileEdit>) {
  return Object.entries(files).map(([path, edit]) => ({ path, content: editContent(edit), ...(edit && typeof edit !== 'string' ? { mode: edit.mode } : {}) }));
}
