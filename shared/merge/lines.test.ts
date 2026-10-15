import { describe, expect, it } from 'vitest';
import { matchLines } from './lines';

describe('matching a changed range between shared edges', () => {
  it.each(['patience', 'myers'] as const)('preserves original indices after insertions and deletions with %s', algorithm => {
    const a = ['start\n', 'same\n', 'one\n', 'two\n', 'end\r\n', 'no newline'];
    const b = ['start\n', 'same\n', 'insert\n', 'one\n', 'two\n', 'extra\n', 'end\r\n', 'no newline'];
    expect([...matchLines(a, b, { algorithm })]).toEqual([0, 1, 3, 4, 6, 7]);
    expect([...matchLines(b, a, { algorithm })]).toEqual([0, 1, -1, 2, 3, -1, 4, 5]);
    expect([...matchLines(a, a, { algorithm })]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...matchLines(['a\n', 'b'], ['a\n', 'b\n'], { algorithm })]).toEqual([0, -1]);
  });
});
