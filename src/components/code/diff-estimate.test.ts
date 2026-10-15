import { describe, expect, it } from 'vitest';
import { diffEstimate, retainedDiffHeight } from './diff-estimate';

describe('diff reservations', () => {
  it.each([20, 24])('reserves the full file at %i px per line', lineHeight => {
    expect(diffEstimate({ added: true, additions: 250, deletions: 0 }, lineHeight)).toBe(16 + 250 * lineHeight);
    expect(diffEstimate({ deleted: true, additions: 0, deletions: 400 }, lineHeight)).toBe(16 + 400 * lineHeight);
  });
  it('allows context for modifications and one row for an empty diff', () => {
    expect(diffEstimate({ additions: 2, deletions: 1 }, 20)).toBe(716);
    expect(diffEstimate({ added: true, additions: 0, deletions: 0 }, 20)).toBe(36);
  });
  it('allows both sides and separators when two additions form separate hunks', () => {
    // Two one-line additions, eight context lines per hunk, three 32 px separators.
    expect(diffEstimate({ additions: 2, deletions: 0 }, 20)).toBeGreaterThanOrEqual(16 + 18 * 20 + 3 * 32);
  });
  it('reserves long paragraphs at the available width, including unchanged context', () => {
    const file = { additions: 1, deletions: 1 };
    const desktop = diffEstimate(file, 20, { textColumns: 8_000, columns: 160 });
    const phone = diffEstimate(file, 20, { textColumns: 8_000, columns: 30 });
    expect(desktop).toBeGreaterThanOrEqual(100 * 20);
    expect(phone).toBeGreaterThan(desktop * 4);
    // No width has been measured yet, or the viewer is narrower than its gutters.
    expect(Number.isFinite(diffEstimate(file, 20, { textColumns: 8_000, columns: 0 }))).toBe(true);
  });
  it('only removes surplus height beyond the viewport, including when scrolling back', () => {
    expect(retainedDiffHeight(1_000, 500, 950, 900)).toBe(500);
    expect(retainedDiffHeight(1_000, 500, 400, 900)).toBe(500);
    expect(retainedDiffHeight(1_000, 500, 399, 900)).toBe(1_000);
    expect(retainedDiffHeight(1_000, 500, -1_100, 900)).toBe(1_000);
    expect(retainedDiffHeight(1_000, 1_200, 0, 900)).toBe(1_200);
  });
});
