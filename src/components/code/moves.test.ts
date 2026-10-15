import { describe, expect, it } from 'vitest';
import { detectMoves, nonTrivialLine } from './moves';

const block = ['const connection = await connectDatabase();', 'const response = await connection.queryRecords();', 'const entries = response.records.map(normalizeRecord);', 'return entries.filter(isVisibleRecord);'].join('\n');
const transfer = (source = block, target = block) => [{ path: 'old.ts', before: source, after: '' }, { path: 'new.ts', before: '', after: target }];

describe('exact move detection', () => {
  it('matches a unique block across files and includes intervening braces and blank lines', () => {
    const source = block.replace('return entries', '}\n\nreturn entries');
    expect(detectMoves(transfer(source, source))).toEqual([{ from: { path: 'old.ts', line: 1, side: 'deletions' }, to: { path: 'new.ts', line: 1, side: 'additions' }, count: 6 }]);
  });
  it('normalizes indentation and CRLF without changing string contents', () => {
    expect(detectMoves(transfer(block, block.split('\n').map(line => `    ${line}  \r`).join('\n')))).toHaveLength(1);
    const strings = block.replace('connectDatabase()', 'connectDatabase("two words")');
    expect(detectMoves(transfer(strings, strings.replace('two words', 'two  words')))).toEqual([]);
  });
  it('finds a far move within one file', () => {
    const middle = Array.from({ length: 30 }, (_, i) => `const unchanged${i} = ${i};`).join('\n');
    expect(detectMoves([{ path: 'same.ts', before: `${block}\n${middle}\n`, after: `${middle}\n${block}\n` }])).toHaveLength(1);
  });
  it('does not call an adjacent edit or reindentation a move', () => {
    expect(detectMoves([{ path: 'same.ts', before: block, after: block.split('\n').map(line => `  ${line}`).join('\n') }])).toEqual([]);
    const middle = 'const unchanged = true;';
    expect(detectMoves([{ path: 'same.ts', before: `${block}\n${middle}`, after: `${middle}\n${block}` }])).toEqual([]);
  });
  it('rejects short, trivial, repeated and ambiguous boilerplate', () => {
    expect(detectMoves(transfer(block.split('\n').slice(0, 3).join('\n')))).toEqual([]);
    expect(detectMoves(transfer('}\n);\nreturn null;\nreturn true;\n\n'))).toEqual([]);
    expect(detectMoves(transfer(Array(8).fill('const result = await executeQuery();').join('\n')))).toEqual([]);
    expect(detectMoves([...transfer(), { path: 'duplicate.ts', before: '', after: block }])).toEqual([]);
    expect(detectMoves(transfer('// first meaningful example\n// second meaningful example\n// third meaningful example\n// fourth meaningful example'))).toEqual([]);
  });
  it.each(['return null;', 'return true;', 'break;', '}', 'const x = 1;', '# lots of explanatory words'])('rejects the common line %s', line => {
    expect(nonTrivialLine(line)).toBe(false);
  });
  it('never confuses a copy with a cut and bounds huge PRs', () => {
    expect(detectMoves([{ path: 'old.ts', before: block, after: block }, { path: 'new.ts', before: '', after: block }])).toEqual([]);
    expect(detectMoves([{ path: 'huge.ts', before: '', after: 'a'.repeat(2_000_001) }, ...transfer()])).toEqual([]);
  });
});
