import type { Change } from '../../shared/types';
import type { ChangeGuide } from '../../shared/guide';
import { explicitGuideAttributes } from '../../shared/git-attributes';
import type { GuideInput } from './guide';

export interface GuideRecording {
  changes: Change[];
  diffs: Record<string, { before: string | null; after: string | null }>;
  guides?: Record<string, ChangeGuide>;
}
/** All files at the requested recorded revision, including paths removed in later revisions. */
export function recordedGuideInput(recorded: GuideRecording, change: Change, revision: number): GuideInput {
  const prefix = `${change.id}:${revision}:`;
  const files = Object.entries(recorded.diffs).filter(([key]) => key.startsWith(prefix)).map(([key, diff]) => ({ path: key.slice(prefix.length), ...diff }));
  const documents = files.filter(file => file.path.split('/').at(-1) === '.gitattributes' && file.after !== null).map(file => ({ path: file.path, content: file.after! }));
  return { title: change.title, summary: change.summary,
    description: [revision === change.revision ? '' : 'This is an earlier revision. The current author description may describe fixes not yet present; explain only the supplied diff.', change.intent, change.rationale].filter(Boolean).join('\n\n'),
    files, attributes: explicitGuideAttributes(files.map(file => file.path), documents) };
}
