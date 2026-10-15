import { beforeAll, describe, expect, it } from 'vitest';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { parseDiffFromFile } from '@pierre/diffs';
import { preloadFileDiff } from '@pierre/diffs/ssr';
import { selectHunks } from './select-hunks';
import { grammarDeclarations, enclosingDeclaration, hunkFunctionContext } from './function-context';

let highlighter: Awaited<ReturnType<typeof createHighlighterCore>>;
beforeAll(async () => {
  highlighter = await createHighlighterCore({ themes: [], engine: createJavaScriptRegexEngine(), langs: await Promise.all([
    import('@shikijs/langs/typescript'), import('@shikijs/langs/tsx'), import('@shikijs/langs/javascript'), import('@shikijs/langs/jsx'),
    import('@shikijs/langs/css'), import('@shikijs/langs/python'), import('@shikijs/langs/go'), import('@shikijs/langs/rust'),
  ]) });
});
const declarations = (language: string, text: string) => grammarDeclarations(highlighter.getLanguage(language), text, language);

describe('TextMate function context', () => {
  it.each(['typescript', 'javascript', 'tsx', 'jsx'])('finds function bodies and nested declarations in %s', lang => {
    const source = 'function outer(items) {\n  for (const item of items) {\n    function inner() {\n      return item.value;\n    }\n    consume(inner());\n  }\n}\nfunction next() {\n  return false;\n}';
    const ranges = declarations(lang, source);
    expect(enclosingDeclaration(ranges, 4)?.signature).toBe('function inner() {');
    expect(enclosingDeclaration(ranges, 6)?.signature).toBe('function outer(items) {');
    expect(enclosingDeclaration(ranges, 10)?.signature).toBe('function next() {');
    expect(enclosingDeclaration(ranges, 12)).toBeUndefined();
  });
  it('distinguishes adjacent methods, arrow bodies, strings and comments', () => {
    const source = 'class Store {\n  save() {\n    return "function fake() {";\n  }\n  read = async () => {\n    // function fake() {\n    return this.value;\n  };\n}\nconst tail = 1;';
    const ranges = declarations('typescript', source);
    expect(enclosingDeclaration(ranges, 3)?.signature).toBe('save() {');
    expect(enclosingDeclaration(ranges, 7)?.signature).toBe('read = async () => {');
    expect(enclosingDeclaration(ranges, 9)?.signature).toBe('class Store {');
    expect(enclosingDeclaration(ranges, 10)).toBeUndefined();
    expect(ranges.some(range => range.signature.includes('fake'))).toBe(false);
  });
  it('uses CSS selector and property-list scopes for nested blocks', () => {
    const source = '.outer,\n.other {\n  color: red;\n  .inner {\n    content: "} .fake {";\n    margin: 2px;\n  }\n}\n.next {\n  color: blue;\n}';
    const ranges = declarations('css', source);
    expect(enclosingDeclaration(ranges, 3)?.start).toBe(1);
    expect(enclosingDeclaration(ranges, 6)?.signature).toBe('.inner {');
    expect(enclosingDeclaration(ranges, 10)?.signature).toBe('.next {');
  });
  it.each([['python', 'def run():\n    return value'], ['go', 'func run() {\n  return value\n}'], ['rust', 'fn run() {\n  return value;\n}']])('leaves %s unchanged when its grammar does not scope a body', (lang, source) => {
    expect(declarations(lang, source)).toEqual([]);
  });
  it('omits incomplete functions and refuses oversized inputs', () => {
    expect(declarations('typescript', 'function unfinished() {\n  return value;')).toEqual([]);
    expect(declarations('typescript', 'function large() {\n' + 'x'.repeat(2_001) + '\n}')).toEqual([]);
  });
  it.each([12, 70])('expands only bounded leading context, including deleted code (%i lines)', count => {
    const before = ['function beforeOnly() {', ...Array.from({ length: count }, (_, i) => `  consume(value${i});`), '}'].join('\n');
    const after = before.replace(`  consume(value${count - 2});\n`, '');
    const diff = parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after });
    const context = { before: declarations('typescript', before), after: declarations('typescript', after) };
    const anchor = hunkFunctionContext(diff.hunks[0], context)!;
    expect(anchor.side).toBe('deletions');
    expect(anchor.declaration.start).toBe(1);
    expect(anchor.leading).toBe(count < 40 ? diff.hunks[0].deletionStart - 1 : 0);
  });
  it('selects Guide hunks without renumbering source lines or exposing omitted changes as context', () => {
    const before = Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5\n', 'changed 5\n').replace('line 60\n', 'changed 60\n');
    const diff = parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after });
    const selected = selectHunks(diff, [1]);
    expect(selected.hunks).toHaveLength(1);
    expect(selected.hunks[0].additionStart).toBe(diff.hunks[1].additionStart);
    expect(selected.hunks[0].unifiedLineStart).toBe(0);
    expect(selected.isPartial).toBe(false);
    expect(diff.hunks).toHaveLength(2);
  });
  it('renders tour #36 README context starting at line 3 through Pierre', async () => {
    const before = '# Relay · a tiny webhook service\n\nA Workers-native webhook delivery example.\n\n## Delivery\n\nPOST an event to a configured HTTPS endpoint. Delivery currently makes one attempt.\n\n## Receivers\n\nTeams receiving Relay webhooks should read [the receiver contract](docs/receivers.md): how to verify signatures and drop duplicate deliveries.\n';
    const after = before.replace(' Delivery currently makes one attempt.', '') + '\n## Retries\n\nRelay retries 5xx and network errors up to three times with jittered backoff.\n';
    const diff = parseDiffFromFile({ name: 'README.md', contents: before }, { name: 'README.md', contents: after });
    expect(diff.hunks[0]).toMatchObject({ deletionStart: 3, deletionCount: 9, additionStart: 3, additionCount: 13 });
    const { prerenderedHTML } = await preloadFileDiff({ fileDiff: selectHunks(diff, [0]), options: { preferredHighlighter: 'shiki-js', theme: 'github-dark', diffStyle: 'unified' } });
    expect(prerenderedHTML).toContain('data-line="3"');
    expect(prerenderedHTML).toContain('data-line="15"');
    expect(prerenderedHTML).toContain('jittered backoff');
  });
  it('anchors projected hunks against the original complete file', () => {
    const body = (name: string) => `function ${name}() {\n${Array.from({ length: 24 }, (_, i) => `  ${name}(value${i});`).join('\n')}\n}\n`;
    const before = body('first') + body('second');
    const after = before.replace('first(value12)', 'first(nextValue)').replace('second(value12)', 'second(nextValue)');
    const selected = selectHunks(parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after }), [1]);
    expect(hunkFunctionContext(selected.hunks[0], { before: declarations('typescript', before), after: declarations('typescript', after) })?.declaration.signature).toBe('function second() {');
  });
  it.each([0, 1])('renders selected hunk %i when omitted changes alter the file length', async index => {
    const before = Array.from({ length: 90 }, (_, i) => `unchanged ${i}`).join('\n');
    const after = before.replace('unchanged 5\n', 'first change\nnew first line\n').replace('unchanged 60\n', 'last change\nnew last line\n');
    const diff = parseDiffFromFile({ name: 'a.txt', contents: before }, { name: 'a.txt', contents: after });
    const selected = selectHunks(diff, [index]);
    const { prerenderedHTML } = await preloadFileDiff({ fileDiff: selected, options: { preferredHighlighter: 'shiki-js', theme: 'github-dark', diffStyle: 'unified' } });
    expect(prerenderedHTML).toContain(index === 0 ? 'new first line' : 'new last line');
    expect(prerenderedHTML).not.toContain(index === 0 ? 'last change' : 'first change');
    expect(prerenderedHTML).toContain(`data-line="${diff.hunks[index].additionStart}"`);
  });
});
