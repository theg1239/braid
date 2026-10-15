import { describe, expect, it, vi } from 'vitest';
import type { GuideChapter } from '../../../shared/types';
import { arrangeChapters, currentChapter, filesNote, hunkRows, kindNote, lineRanges, viewerHunkIndices } from './guide';

vi.mock('../../lib/api', () => ({ changes: { guide: vi.fn() } }));
vi.mock('../../lib/live', () => ({ useLive: vi.fn(), refreshLive: vi.fn(), peekLive: vi.fn() }));

const chapter = (id: string, kind: GuideChapter['kind'], ...paths: string[]): GuideChapter => ({ id, title: id, summary: '', kind, files: paths.map((path) => ({ path, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] })) });

describe('chapter order', () => {
  it('numbers chapters once across the guide, with tests and generated last', () => {
    const arranged = arrangeChapters([chapter('t', 'tests', 'a.test.ts'), chapter('a', 'logic', 'a.ts'), chapter('g', 'generated', 'lock'), chapter('b', 'docs', 'README.md')]);
    expect(arranged.all.map((item) => `${item.number}:${item.id}`)).toEqual(['1:a', '2:b', '3:t', '4:g']);
    expect(arranged.main.map((item) => item.id)).toEqual(['a', 'b']);
    expect(arranged.tests[0].number).toBe(3);
    expect(arranged.generated[0].number).toBe(4);
  });

  it('opens on the chapter asked for, else the first', () => {
    const { all } = arrangeChapters([chapter('a', 'logic', 'a.ts'), chapter('b', 'logic', 'b.ts')]);
    expect(currentChapter(all, 'b')?.id).toBe('b');
    expect(currentChapter(all, 'gone')?.id).toBe('a');
    expect(currentChapter([], null)).toBeNull();
  });

  it('marks mechanical, docs and config quietly and nothing else', () => {
    expect(kindNote('mechanical')).toBe('mechanical');
    expect(kindNote('docs')).toBe('docs');
    expect(kindNote('logic')).toBeNull();
    expect(kindNote('tests')).toBeNull();
  });

  it('names the first file and counts the rest', () => {
    expect(filesNote(chapter('a', 'logic', 'src/limit.ts', 'src/api.ts', 'src/types.ts'))).toBe('limit.ts +2');
    expect(filesNote(chapter('a', 'logic', 'src/limit.ts'))).toBe('limit.ts');
  });
});

describe('hunks', () => {
  it('says the new-side lines a chapter covers', () => {
    expect(lineRanges([{ oldStart: 10, oldLines: 3, newStart: 12, newLines: 30 }])).toBe('lines 12–41');
    expect(lineRanges([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }])).toBe('line 1');
    expect(lineRanges([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1 }])).toBe('lines 1–2, 9');
    expect(lineRanges([{ oldStart: 5, oldLines: 2, newStart: 4, newLines: 0 }])).toBe('removed lines');
  });

  it('matches the guide ranges to the viewer hunks by overlap on the new side', () => {
    const viewer = [
      { additionStart: 1, additionCount: 9, deletionStart: 1, deletionCount: 8 },
      { additionStart: 40, additionCount: 10, deletionStart: 39, deletionCount: 10 },
      { additionStart: 90, additionCount: 6, deletionStart: 89, deletionCount: 6 },
    ];
    expect(viewerHunkIndices(viewer, [{ oldStart: 40, oldLines: 8, newStart: 41, newLines: 8 }])).toEqual([1]);
    expect(viewerHunkIndices(viewer, [{ oldStart: 2, oldLines: 6, newStart: 2, newLines: 7 }, { oldStart: 90, oldLines: 4, newStart: 91, newLines: 4 }])).toEqual([0, 2]);
  });

  it('matches a hunk that only removes by its old lines, and falls back to every hunk', () => {
    const viewer = [{ additionStart: 1, additionCount: 4, deletionStart: 1, deletionCount: 4 }, { additionStart: 20, additionCount: 4, deletionStart: 20, deletionCount: 8 }];
    expect(viewerHunkIndices(viewer, [{ oldStart: 22, oldLines: 4, newStart: 21, newLines: 0 }])).toEqual([1]);
    expect(viewerHunkIndices(viewer, [{ oldStart: 500, oldLines: 2, newStart: 500, newLines: 2 }])).toEqual([0, 1]);
  });

  it('keeps room for each line once and a separator per hunk', () => {
    expect(hunkRows([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }, { oldStart: 9, oldLines: 2, newStart: 11, newLines: 2 }])).toBe(9);
  });
});
