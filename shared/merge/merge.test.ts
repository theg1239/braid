import { describe, expect, it } from 'vitest';
import { mergeFile } from './index';
import { mergedText, mergeText } from './diff3';
import { mergeJson } from './json';
import { matchLines, splitLines } from './lines';
import { matchesGlob } from '../glob';

/** Deterministic PRNG so failures reproduce. */
function random(seed: number) {
  return () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
}
const pick = <T>(rand: () => number, items: T[]) => items[Math.floor(rand() * items.length)];
function lcsLength(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  return table[0][0];
}
function validMatch(a: string[], b: string[], match: Int32Array) {
  let last = -1, count = 0;
  for (let i = 0; i < a.length; i++) {
    if (match[i] < 0) continue;
    expect(match[i]).toBeGreaterThan(last);
    expect(a[i]).toBe(b[match[i]]);
    last = match[i]; count++;
  }
  return count;
}
const text = (lines: string[]) => lines.map(line => `${line}\n`).join('');

describe('line matching', () => {
  it('keeps line terminators so end-of-file changes are visible', () => {
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('a\r\nb\n')).toEqual(['a\r\n', 'b\n']);
    expect(splitLines('')).toEqual([]);
  });

  it('finds an optimal alignment with Myers and a valid one with patience', () => {
    const rand = random(7);
    for (let round = 0; round < 400; round++) {
      const alphabet = ['a', 'b', 'c', '}', '', 'd'];
      const a = Array.from({ length: Math.floor(rand() * 18) }, () => pick(rand, alphabet));
      const b = Array.from({ length: Math.floor(rand() * 18) }, () => pick(rand, alphabet));
      expect(validMatch(a, b, matchLines(a, b, { algorithm: 'myers' }))).toBe(lcsLength(a, b));
      validMatch(a, b, matchLines(a, b));
    }
  });

  it('stays valid when the work budget is exhausted', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `${i % 7}`), b = Array.from({ length: 3000 }, (_, i) => `${(i * 3) % 7}`);
    validMatch(a, b, matchLines(a, b, { budget: 1000, algorithm: 'myers' }));
  });
});

describe('three-way text merge', () => {
  it('combines edits in different regions of the same file', () => {
    const base = text(['import a', '', 'function one() {', '  return 1;', '}', '', 'function two() {', '  return 2;', '}']);
    const ours = base.replace('return 1;', 'return 10;');
    const theirs = base.replace('return 2;', 'return 20;');
    const result = mergeText(base, ours, theirs);
    expect(result.clean).toBe(true);
    expect(mergedText(result)).toBe(base.replace('return 1;', 'return 10;').replace('return 2;', 'return 20;'));
  });

  it('reports different edits to the same lines as a conflict with each side', () => {
    const base = text(['a', 'b', 'c']);
    const result = mergeText(base, text(['a', 'B1', 'c']), text(['a', 'B2', 'c']));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ baseStart: 1, oursStart: 1, theirsStart: 1, base: ['b\n'], ours: ['B1\n'], theirs: ['B2\n'] }]);
    expect(() => mergedText(result)).toThrow(/unresolved/);
  });

  it('accepts identical edits once', () => {
    const base = text(['a', 'b']);
    const edited = text(['a', 'x', 'b']);
    expect(mergedText(mergeText(base, edited, edited))).toBe(edited);
    expect(mergedText(mergeText(base, text(['a', 'x', 'b', 'y']), text(['a', 'x', 'b'])))).toBe(text(['a', 'x', 'b', 'y']));
  });

  it('unions overlapping insertions only when asked, trunk first', () => {
    const base = text(['const routes = [', "  '/a',", '];']);
    const ours = text(['const routes = [', "  '/a',", "  '/b',", '];']);
    const theirs = text(['const routes = [', "  '/a',", "  '/c',", '];']);
    expect(mergeText(base, ours, theirs, { unionEntries: false }).clean).toBe(false);
    const union = mergeText(base, ours, theirs, { union: true });
    expect(union.strategy).toBe('union');
    expect(mergedText(union)).toBe(text(['const routes = [', "  '/a',", "  '/b',", "  '/c',", '];']));
    // Changing an existing line in the same region is still a conflict.
    expect(mergeText(base, ours, text(['const routes = [', "  '/z',", '];']), { union: true }).clean).toBe(false);
    // Whole list entries at one indentation combine without being asked.
    expect(mergeText(base, ours, theirs).strategy).toBe('union');
  });

  it('combines concurrent list entries but never statements or blocks', () => {
    const base = text(['export const routes = {', "  '/': 'index',", '};']);
    const ours = text(['export const routes = {', "  '/': 'index',", "  '/a': 'a',", '};']);
    const theirs = text(['export const routes = {', "  '/': 'index',", "  '/b': 'b',", '};']);
    expect(mergedText(mergeText(base, ours, theirs))).toBe(text(['export const routes = {', "  '/': 'index',", "  '/a': 'a',", "  '/b': 'b',", '};']));
    expect(mergedText(mergeText(text(['# Notes', '']), text(['# Notes', '', '- one']), text(['# Notes', '', '- two'])))).toBe(text(['# Notes', '', '- one', '- two']));
    // Statements, differently indented entries and multi-line blocks still need a decision.
    expect(mergeText(text(['f() {', '}']), text(['f() {', '  return a;', '}']), text(['f() {', '  return b;', '}'])).clean).toBe(false);
    expect(mergeText(base, ours, text(['export const routes = {', "  '/': 'index',", "      '/b': 'b',", '};'])).clean).toBe(false);
    expect(mergeText(base, ours, text(['export const routes = {', "  '/': 'index',", "  '/b': {", "    handler: 'b',", '  },', '};'])).clean).toBe(false);
    expect(mergeText(base, ours, theirs, { unionEntries: false }).clean).toBe(false);
  });

  it('leaves concurrent import lines for a decision', () => {
    const base = text(["import { a } from './a';", '', 'export const x = a;']);
    const ours = text(["import { a } from './a';", "import { b } from './b';", '', 'export const x = a;']);
    const theirs = text(["import { a } from './a';", "import { c } from './c';", '', 'export const x = a;']);
    expect(mergeText(base, ours, theirs).clean).toBe(false);
  });

  it('includes an import or entry both sides added only once', () => {
    const base = text(["import { a } from './a';", '', 'export const x = a;']);
    const ours = text(["import { a } from './a';", "import { b } from './b';", "import { c } from './c';", '', 'export const x = a;']);
    const theirs = text(["import { a } from './a';", "import { b } from './b';", "import { d } from './d';", '', 'export const x = a;']);
    expect(mergedText(mergeText(base, ours, theirs, { union: true }))).toBe(text(["import { a } from './a';", "import { b } from './b';", "import { c } from './c';", "import { d } from './d';", '', 'export const x = a;']));
    const list = text(['- one']);
    expect(mergedText(mergeText(list, text(['- one', '- two', '- three']), text(['- one', '- two', '- four'])))).toBe(text(['- one', '- two', '- three', '- four']));
    // Repeated structural lines in a forced union are not entries and stay.
    const block = (name: string) => [`it('${name}', () => {`, '  expect(1).toBe(1);', '});'];
    const merged = mergedText(mergeText(text(['']), text(['', ...block('a')]), text(['', ...block('b')]), { union: true }));
    expect(merged.match(/expect\(1\)/g)).toHaveLength(2);
  });

  it('keeps lines separate when both sides append to a file without a final newline', () => {
    const merged = mergeText('a\n', 'a\nb', 'a\nc', { union: true });
    expect(mergedText(merged)).toBe('a\nb\nc');
  });

  it('merges any disjoint pair of edits exactly (randomized)', () => {
    const rand = random(42);
    for (let round = 0; round < 300; round++) {
      const length = 8 + Math.floor(rand() * 40);
      const base = Array.from({ length }, (_, i) => `base ${i}`);
      // Alternate owners for non-adjacent regions so the two sides never touch neighbouring lines.
      const edits: { side: 'a' | 'b'; start: number; end: number; lines: string[] }[] = [];
      let cursor = Math.floor(rand() * 3), side: 'a' | 'b' = rand() < 0.5 ? 'a' : 'b', counter = 0;
      while (cursor < length) {
        const end = Math.min(length, cursor + Math.floor(rand() * 3));
        const inserted = Array.from({ length: Math.floor(rand() * 3) }, () => `${side}-${round}-${counter++}`);
        if (end > cursor || inserted.length) edits.push({ side, start: cursor, end, lines: inserted });
        cursor = end + 2 + Math.floor(rand() * 3);
        side = side === 'a' ? 'b' : 'a';
      }
      const apply = (which: ('a' | 'b')[]) => {
        const output: string[] = [];
        let position = 0;
        for (const edit of edits.filter(edit => which.includes(edit.side))) {
          output.push(...base.slice(position, edit.start), ...edit.lines);
          position = edit.end;
        }
        return text([...output, ...base.slice(position)]);
      };
      const result = mergeText(text(base), apply(['a']), apply(['b']));
      expect(result.clean).toBe(true);
      expect(mergedText(result)).toBe(apply(['a', 'b']));
    }
  });

  it('is symmetric on repetitive code (randomized)', () => {
    const rand = random(99);
    const alphabet = ['{', '}', '', 'return x;', 'x++;', 'if (x) {', 'call();'];
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 4 + Math.floor(rand() * 20) }, () => pick(rand, alphabet));
      const mutate = () => {
        const copy = [...base];
        for (let edits = 1 + Math.floor(rand() * 3); edits > 0; edits--) {
          const at = Math.floor(rand() * (copy.length + 1));
          if (rand() < 0.4 && copy.length) copy.splice(Math.min(at, copy.length - 1), 1);
          else copy.splice(at, 0, `edit ${round} ${edits} ${rand()}`);
        }
        return text(copy);
      };
      const a = mutate(), b = mutate();
      const left = mergeText(text(base), a, b), right = mergeText(text(base), b, a);
      expect(left.clean).toBe(right.clean);
      if (left.clean) expect(mergedText(left)).toBe(mergedText(right));
    }
  });
});

describe('structural JSON merge', () => {
  const pkg = (dependencies: Record<string, string>, version = '1.0.0') => JSON.stringify({ name: 'relay', version, dependencies }, null, 2) + '\n';

  it('adds dependencies from both sides in sorted order', () => {
    const merged = mergeJson(pkg({ hono: '^4.0.0' }), pkg({ hono: '^4.0.0', jose: '^6.0.0' }), pkg({ hono: '^4.0.0', 'drizzle-orm': '^1.0.0' }));
    expect(merged).toEqual({ text: pkg({ 'drizzle-orm': '^1.0.0', hono: '^4.0.0', jose: '^6.0.0' }), conflicts: [] });
  });

  it('reports the exact key both sides changed differently', () => {
    expect(mergeJson(pkg({ hono: '^4.0.0' }), pkg({ hono: '^4.1.0' }), pkg({ hono: '^4.2.0' }))).toEqual({ text: null, conflicts: ['$.dependencies.hono'] });
  });

  it('applies a deletion and an unrelated change', () => {
    const base = pkg({ hono: '^4.0.0', jose: '^6.0.0' });
    expect(mergeJson(base, pkg({ hono: '^4.0.0' }), pkg({ hono: '^4.0.0', jose: '^6.0.0' }, '1.1.0'))?.text).toBe(pkg({ hono: '^4.0.0' }, '1.1.0'));
  });

  it('appends to arrays from both sides and refuses reformatting', () => {
    const base = '{\n  "files": ["a"]\n}\n';
    expect(mergeJson('{"files":["a"]}', '{"files":["a","b"]}', '{"files":["a","c"]}')).toBeNull();
    const merged = mergeJson(JSON.stringify({ files: ['a'] }, null, 2) + '\n', JSON.stringify({ files: ['a', 'b'] }, null, 2) + '\n', JSON.stringify({ files: ['a', 'c'] }, null, 2) + '\n');
    expect(JSON.parse(merged!.text!)).toEqual({ files: ['a', 'b', 'c'] });
    expect(base).toContain('files');
  });
});

describe('file merge strategies', () => {
  it('chooses the least surprising strategy', () => {
    expect(mergeFile('a.ts', 'x\n', 'x\n', 'y\n')).toEqual({ clean: true, text: 'y\n', strategy: 'fast-forward' });
    expect(mergeFile('CHANGELOG.md', '# Log\n', '# Log\n- one\n', '# Log\n- two\n')).toEqual({ clean: true, text: '# Log\n- one\n- two\n', strategy: 'union' });
    const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps }, null, 2) + '\n';
    expect(mergeFile('package.json', pkg({ a: '1' }), pkg({ a: '1', b: '1' }), pkg({ a: '1', c: '1' }))).toMatchObject({ clean: true, strategy: 'json' });
    const conflict = mergeFile('src/a.ts', 'x\n', 'y\n', 'z\n');
    expect(conflict.clean).toBe(false);
    expect(mergeFile('src/a.ts', 'a\n', 'a\nb\n', 'a\nc\n', { union: ['src/**'] })).toMatchObject({ clean: true, strategy: 'union' });
  });
});

describe('real-merge replay regressions', () => {
  // Minimized and renamed from Flask 97c830190ff8, tests/test_basic.py.
  // Repeated blank lines aligned through the same newly added test twice.
  it('refuses a clean result that depends on an ambiguous repeated-line alignment', () => {
    const base = '\nanchor\n\ncontext-a\ncontext-b\ncontext-c\n\ntail-a\ntail-b\n\n';
    const ours = 'anchor\n\ndef test_common():\n\ncontext-a\ncontext-b\ncontext-c\ntail-a\ntail-b\n';
    const theirs = 'anchor\n\ndef test_common():\n\ncontext-a\ncontext-b\ncontext-c\n\ntail-a\ntail-b\n\n';
    expect(mergeFile('tests/test_common.py', base, ours, theirs).clean).toBe(false);
    expect(mergeFile('tests/test_common.py', base, theirs, ours).clean).toBe(false);
  });

  // Express History.md merges combined whole release sections whose meaning
  // still needed a maintainer's decision. A filename is not append-only policy.
  it('requires explicit policy to concatenate competing Markdown sections', () => {
    const base = '# Previous release\n';
    const ours = '# Current release\n\nUpdated the client.\n' + base;
    const theirs = '# Maintenance release\n\nUpdated the server.\n' + base;
    expect(mergeFile('CHANGELOG.md', base, ours, theirs).clean).toBe(false);
    expect(mergeFile('CHANGELOG.md', base, ours, theirs, { union: ['CHANGELOG.md'] })).toEqual({ clean: true, strategy: 'union', text: '# Current release\n\nUpdated the client.\n# Maintenance release\n\nUpdated the server.\n' + base });
  });

  // Express c96c690dc087 duplicated a shared test helper/suite in res.location.js.
  it('does not concatenate overlapping additions of whole test blocks', () => {
    const base = 'describe("suite", () => {\n});\n';
    const ours = base.replace('});', '  it("left", () => checkLeft());\n  it("shared", () => checkShared());\n});');
    const theirs = base.replace('});', '  it("shared", () => checkShared());\n  it("right", () => checkRight());\n});');
    expect(mergeFile('test/feature.test.ts', base, ours, theirs).clean).toBe(false);
  });

  // json-schema-spec 73e324810296 added two versions of CONTRIBUTING.md;
  // Express 6ac6305b533d similarly duplicated common release sections.
  it('does not union independently added documents with overlapping sections', () => {
    const ours = '# Guide\n\n## Review\nRead every change.\n';
    const theirs = '# Contributions\n\n## Review\nRead every change.\n';
    expect(mergeFile('CONTRIBUTING.md', '', ours, theirs).clean).toBe(false);
  });

  it.each(['feature.test.ts', 'tests/feature.ts', 'docs/example.md'])('does not infer safe code concatenation from %s', path => {
    const base = 'function check() {\n}\n';
    expect(mergeFile(path, base, 'function check() {\n  const result = 1;\n}\n', 'function check() {\n  const result = 2;\n}\n').clean).toBe(false);
  });

  it('keeps conflicting new JSON members away from the line-entry union', () => {
    const base = '{\n  "scripts": {\n    "test": "run"\n  }\n}\n';
    const ours = base.replace('  "scripts": {', '  "version": "1",\n  "scripts": {');
    const theirs = base.replace('  "scripts": {', '  "version": "2",\n  "scripts": {');
    expect(mergeFile('package.json', base, ours, theirs)).toMatchObject({ clean: false, jsonPaths: ['$.version'] });
    expect(mergeFile('package.json', base, ours, theirs, { union: ['*.json'] }).clean).toBe(false);
  });

  it('does not combine different assignments to one new object key', () => {
    const base = 'const routes = {\n};\n';
    const ours = "const routes = {\n  '/health': 'first',\n};\n";
    const theirs = "const routes = {\n  '/health': 'second',\n};\n";
    expect(mergeFile('routes.ts', base, ours, theirs).clean).toBe(false);
  });

  it('does not treat partial import statements as complete comma-terminated entries', () => {
    const base = '  shared,\n} from "module";\n';
    expect(mergeText(base, 'import { left,\n' + base, 'import { right,\n' + base).clean).toBe(false);
  });

  // Express 501e24e0a941 needed the new prototype helper applied to code added
  // on the other branch. Compatible import bindings do not prove compatibility.
  it('does not infer that concurrent imports and their callers are independent', () => {
    const base = 'const version = 1;\n\nfunction apply(target) {\n  target.__proto__ = source;\n}\n';
    const ours = base.replace('const version', "const router = require('./router');\nconst version") + '\nfunction added(target) {\n  target.__proto__ = source;\n}\n';
    const theirs = base.replace('const version', "const setPrototype = require('./prototype');\nconst version").replace('target.__proto__ = source;', 'setPrototype(target, source);');
    expect(mergeFile('app.js', base, ours, theirs).clean).toBe(false);
  });

  // Flask daca74d93a0e needed an incoming test adapted to the refactored context.
  it('keeps overlapping Python imports for review even when one was added on both sides', () => {
    const base = 'import framework\n\ndef test_existing():\n    pass\n';
    const ours = base.replace('import framework\n', 'import framework\nfrom framework.testing import Client\n');
    const theirs = base.replace('import framework\n', 'import framework\nfrom framework.context import request_ctx\nfrom framework.testing import Client\n');
    expect(mergeFile('tests/test_context.py', base, ours, theirs).clean).toBe(false);
  });

  it('preserves CRLF and independent changes to the final newline', () => {
    expect(mergeFile('code.txt', 'a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n')).toMatchObject({ clean: true, text: 'A\r\nb\r\nC\r\n' });
    expect(mergeFile('code.txt', 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nc')).toMatchObject({ clean: true, text: 'A\nb\nc' });
    expect(mergeFile('code.txt', 'a\nb\n', 'a\r\nb\r\n', 'a\nB\n').clean).toBe(false);
    expect(mergeFile('CHANGELOG.md', '# Log\r\n', '# Log\r\n- first', '# Log\r\n- second')).toMatchObject({ clean: true, text: '# Log\r\n- first\r\n- second' });
  });
});

describe('structural merge data preservation', () => {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  it('preserves literal prototype-related keys as ordinary own properties', () => {
    const base = '{}\n';
    const ours = '{\n  "__proto__": {\n    "enabled": true\n  },\n  "constructor": 1\n}\n';
    const result = mergeJson(base, ours, json({ other: 2 }));
    expect(result?.text).not.toBeNull();
    expect(JSON.parse(result!.text!)).toEqual(JSON.parse('{"__proto__":{"enabled":true},"constructor":1,"other":2}'));
    expect(Object.hasOwn(JSON.parse(result!.text!), '__proto__')).toBe(true);
  });

  it.each([
    '{\n  "value": 9007199254740993\n}\n',
    '{\n  "value": 1,\n  "value": 2\n}\n',
  ])('refuses an incoming value JSON.parse cannot preserve', theirs => {
    expect(mergeJson('{}\n', json({ other: 1 }), theirs)).toBeNull();
    expect(mergeJson(theirs, json({ other: 1 }), json({ next: 2 }))).toBeNull();
  });

  it('does not discard incoming formatting changes during structural merge', () => {
    expect(mergeJson('{}\n', json({ ours: 1 }), json({ theirs: 2 }).trimEnd())).toBeNull();
    expect(mergeJson(json({ original: 1 }), json({ original: 1, ours: 1 }), JSON.stringify({ original: 1, theirs: 2 }, null, 4) + '\n')).toBeNull();
  });

  it('preserves append multiplicity while recognizing reordered object members', () => {
    const base = json({ items: [] });
    const ours = json({ items: [{ a: 1, b: 2 }] });
    const theirs = json({ items: [{ b: 2, a: 1 }, { b: 2, a: 1 }, 3] });
    expect(JSON.parse(mergeJson(base, ours, theirs)!.text!)).toEqual({ items: [{ a: 1, b: 2 }, { b: 2, a: 1 }, 3] });
  });

  it('combines large append lists without dropping values', () => {
    const ours = Array.from({ length: 10_000 }, (_, i) => i);
    const theirs = Array.from({ length: 10_000 }, (_, i) => i + 5_000);
    const result = mergeJson(json({ items: [] }), json({ items: ours }), json({ items: theirs }));
    expect(JSON.parse(result!.text!).items).toEqual(Array.from({ length: 15_000 }, (_, i) => i));
  });
});

describe('path globs', () => {
  it('follows CODEOWNERS-style matching', () => {
    expect(matchesGlob('docs/guide.md', '*.md')).toBe(true);
    expect(matchesGlob('README.md', '*.md')).toBe(true);
    expect(matchesGlob('src/billing/charge.ts', 'src/billing/')).toBe(true);
    expect(matchesGlob('src/billing/charge.ts', 'src/billing')).toBe(true);
    expect(matchesGlob('src/billingx/charge.ts', 'src/billing')).toBe(false);
    expect(matchesGlob('src/a/b/c.test.ts', '**/*.test.*')).toBe(true);
    expect(matchesGlob('migrations/001.sql', '{migrations,db}/**')).toBe(true);
    expect(matchesGlob('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/index.ts', 'src/*.ts')).toBe(false);
  });
});
