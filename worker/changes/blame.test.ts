import { describe, expect, it } from 'vitest';
import { baseRanges, lineCounts, newRanges, resolve, shift } from './blame';

describe('line maps', () => {
  it('keeps unchanged lines with their commit and gives added and changed lines the landing', () => {
    const before = ['one', 'two', 'three', 'four'];
    const first = shift(newRanges(4, 1), before, ['one', 'two', 'TWO and a half', 'three', 'four'], 2);
    expect(first).toEqual({ ranges: [[1, 2, 1], [3, 1, 2], [4, 2, 1]], added: 1 });
    // A changed line belongs to the change that last touched it; removed lines leave the map.
    const second = shift(first.ranges, ['one', 'two', 'TWO and a half', 'three', 'four'], ['one', 'TWO and a half', 'three!', 'four'], 3);
    expect(second.ranges).toEqual([[1, 1, 1], [2, 1, 2], [3, 1, 3], [4, 1, 1]]);
    expect(lineCounts(second.ranges)).toEqual(new Map([[1, 2], [2, 1], [3, 1]]));
  });

  it('keeps where older lines came from until history attributes them', () => {
    const shifted = shift(baseRanges(3), ['a', 'b', 'c'], ['a', 'new', 'c'], 7);
    expect(shifted.ranges).toEqual([[1, 1, 0, 1], [2, 1, 7], [3, 1, 0, 3]]);
    expect(lineCounts(shifted.ranges)).toEqual(new Map([[7, 1]]));
    // GitHub's blame of the base commit says line 1 came from commit 4 and line 3 from commit 5.
    expect(resolve(shifted.ranges, 3, origin => origin === 1 ? 4 : 5)).toEqual([[1, 1, 4], [2, 1, 7], [3, 1, 5]]);
  });

  it('gives a rewrite too large to diff to the landing', () => {
    const before = Array.from({ length: 12_000 }, (_, i) => `old ${i}`), after = Array.from({ length: 12_000 }, (_, i) => `new ${i}`);
    expect(shift(newRanges(before.length, 1), before, after, 2)).toEqual({ ranges: [[1, 12_000, 2]], added: 12_000 });
  });
});
