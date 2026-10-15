import type { Change, ChangeGuide, GuideChapter, GuideHunk } from '../../../shared/types';
import { changes } from '../../lib/api';
import { peekLive, refreshLive, useLive } from '../../lib/live';
import { basename } from '../../lib/format';

/*
 * The guided review's data and its arithmetic, apart from the Guide tab so Files changed can read
 * the same answer: one live entry per revision, polled while the model is still writing.
 */

const guideKey = (change: Pick<Change, 'id' | 'revision'>) => `changes:guide:${change.id}:${change.revision}`;

/** A pending guide is read again every few seconds; a ready or failed one only when the page asks. */
const guideInterval = (guide: ChangeGuide | null) => (!guide || guide.status === 'pending' ? 2_500 : 600_000);

/**
 * The revision's guide: nothing until the first answer, then whatever the server says it is. With
 * `enabled` false it only follows an answer another reader already asked for, never starting one.
 */
export function useGuide(change: Pick<Change, 'id' | 'revision'> | null, enabled = true) {
  const key = change ? guideKey(change) : null;
  const live = useLive(key !== null && (enabled || peekLive(key) !== undefined) ? key : null, () => changes.guide(change!.id, change!.revision), guideInterval);
  return { guide: live.data, error: live.error, refreshing: live.refreshing, refresh: live.refresh };
}

/** Try again after a failure: the server writes the guide anew when asked for it. */
export function retryGuide(change: Pick<Change, 'id' | 'revision'>) {
  refreshLive(guideKey(change));
}

/* ---------- Chapters ---------- */

export interface NumberedChapter extends GuideChapter { number: number }

/** Chapters in reading order, numbered once across the whole guide, with Tests and Generated set apart to fold at the end. */
export function arrangeChapters(chapters: GuideChapter[]): { all: NumberedChapter[]; main: NumberedChapter[]; tests: NumberedChapter[]; generated: NumberedChapter[] } {
  const main = chapters.filter((chapter) => chapter.kind !== 'tests' && chapter.kind !== 'generated');
  const tests = chapters.filter((chapter) => chapter.kind === 'tests');
  const generated = chapters.filter((chapter) => chapter.kind === 'generated');
  const all = [...main, ...tests, ...generated].map((chapter, index) => ({ ...chapter, number: index + 1 }));
  const numbered = (list: GuideChapter[]) => list.map((chapter) => all.find((item) => item.id === chapter.id)!);
  return { all, main: numbered(main), tests: numbered(tests), generated: numbered(generated) };
}

/** The quiet word beside a chapter that is not logic: what it is, so a reader can skim past it. */
export function kindNote(kind: GuideChapter['kind']): string | null {
  return kind === 'mechanical' || kind === 'docs' || kind === 'config' ? kind : null;
}

/** The files of a chapter as its row says them: the first file's name and how many more. */
export function filesNote(chapter: GuideChapter): string {
  const [first, ...rest] = chapter.files;
  if (!first) return '';
  return rest.length ? `${basename(first.path)} +${rest.length}` : basename(first.path);
}

/** The chapter's lines of a file on the new side, for the file's header: "lines 12–41, 60–72". */
export function lineRanges(hunks: GuideHunk[]): string {
  const ranges = hunks.filter((hunk) => hunk.newLines > 0).map((hunk) => hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`);
  if (!ranges.length) return hunks.length ? 'removed lines' : '';
  const shown = ranges.slice(0, 3).join(', ');
  const single = ranges.length === 1 && !ranges[0].includes('–');
  return `${single ? 'line' : 'lines'} ${shown}${ranges.length > 3 ? ` +${ranges.length - 3}` : ''}`;
}

/** The viewer's own hunks, as Pierre parses the two texts: enough of each to match the guide's ranges against. */
interface ViewerHunk { additionStart: number; additionCount: number; deletionStart: number; deletionCount: number }

const overlaps = (start: number, count: number, otherStart: number, otherCount: number) =>
  count > 0 && otherCount > 0 && start < otherStart + otherCount && otherStart < start + count;

/**
 * Which of the viewer's hunks the chapter's hunks are, as zero-based indices: the ones whose new
 * lines overlap, or, for a hunk that only removes, whose old lines do. Git keeps three lines of
 * context and the viewer four, so ranges overlap rather than match. A chapter whose ranges match
 * nothing shows the whole file rather than nothing.
 */
export function viewerHunkIndices(viewer: readonly ViewerHunk[], hunks: readonly GuideHunk[]): number[] {
  const picked = new Set<number>();
  for (const hunk of hunks) {
    viewer.forEach((candidate, index) => {
      if (hunk.newLines ? overlaps(hunk.newStart, hunk.newLines, candidate.additionStart, candidate.additionCount) : overlaps(hunk.oldStart, hunk.oldLines, candidate.deletionStart, candidate.deletionCount)) picked.add(index);
    });
  }
  return picked.size ? [...picked].sort((a, b) => a - b) : viewer.map((_, index) => index);
}

/** Rows a chapter's hunks take in a unified diff, for the room kept before the viewer draws them: each line once, and a separator. */
export function hunkRows(hunks: readonly GuideHunk[]): number {
  return hunks.reduce((rows, hunk) => rows + Math.max(hunk.oldLines, hunk.newLines) + 1, 0);
}

/** The id of the chapter to read first: the one asked for when it exists, else the first in reading order. */
export function currentChapter(all: NumberedChapter[], wanted: string | null): NumberedChapter | null {
  return all.find((chapter) => chapter.id === wanted) ?? all[0] ?? null;
}
