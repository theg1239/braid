import { describe, expect, it } from 'vitest';
import { describeInstruction, editInstructions, instructionId, parseInstructions, withInstructions } from './instructions-file';
import type { Instruction } from './types';

const secrets: Instruction = { id: 'no-secret-logs', text: 'Never log webhook secrets', block: ['console.log(secret'], paths: ['src/**'] };
const backoff: Instruction = { id: 'retries-back-off', text: 'Retries back off; never retry 4xx except 429.' };
const section = (...items: Instruction[]) => ['<!-- braid:instructions:start -->', '## Instructions from Braid', '', ...items.map(item => `- ${describeInstruction(item)}`), '<!-- braid:instructions:end -->'].join('\n');

describe('the instructions file', () => {
  it('reads valid instructions and reports each invalid one by index, keeping what it can', () => {
    const { instructions, errors } = parseInstructions(JSON.stringify({ instructions: [
      secrets,
      { id: 'Not A Slug', text: 'Ignored' },
      { id: 'blank', text: '   ' },
      { id: 'too-wide', text: 'Keep copy short', block: ['x'.repeat(61)], paths: ['docs/**'] },
      { id: 'no-secret-logs', text: 'A second one with the same id' },
      { id: 'bad-paths', text: 'Plain\n  words', paths: 'src/**' },
      'no-em-dashes',
      { id: 'empty-lists', text: 'Nothing to block', block: [], paths: [] },
    ] }));
    expect(instructions).toEqual([
      secrets,
      { id: 'too-wide', text: 'Keep copy short', paths: ['docs/**'] },
      { id: 'bad-paths', text: 'Plain words' },
      { id: 'empty-lists', text: 'Nothing to block' },
    ]);
    expect(errors).toEqual([
      'instructions[1].id must be a short slug such as "no-em-dashes".',
      'instructions[2].text must contain 1–500 characters.',
      'instructions[3].block must list up to 8 strings of 1–60 characters, each on one line.',
      'instructions[4].id repeats "no-secret-logs"; only the first applies.',
      'instructions[5].paths must list up to 10 path patterns, so it covers every file until fixed.',
      'instructions[6] must be an object with an id and a text.',
    ]);
  });

  it('applies nothing from a file that is not an instructions list, and at most a hundred', () => {
    expect(parseInstructions(null)).toEqual({ instructions: [], errors: [] });
    for (const text of ['{', '[]', '{"instructions":{}}']) expect(parseInstructions(text)).toEqual({ instructions: [], errors: [expect.stringMatching(/must be JSON with an "instructions" list/)] });
    const many = parseInstructions(JSON.stringify({ instructions: Array.from({ length: 101 }, (_, index) => ({ id: `rule-${index}`, text: `Rule ${index}` })) }));
    expect(many.instructions).toHaveLength(100);
    expect(many.errors).toEqual(['Only the first 100 instructions apply.']);
  });

  it('adds an instruction with a readable id and removes one, keeping everything else in the file', () => {
    const file = `${JSON.stringify({ $schema: 'https://braid.example/instructions.json', instructions: [secrets, { id: 'Broken Entry', text: 7 }] }, null, 2)}\n`;
    const added = editInstructions(file, { add: { text: 'Never log webhook secrets', block: ['—'] } });
    expect(added).toMatchObject({ instruction: { id: 'never-log-webhook-secrets', text: 'Never log webhook secrets' } });
    if (!('file' in added)) throw new Error('Expected an edit.');
    expect(JSON.parse(added.file)).toEqual({ $schema: 'https://braid.example/instructions.json', instructions: [secrets, { id: 'Broken Entry', text: 7 }, { id: 'never-log-webhook-secrets', text: 'Never log webhook secrets', block: ['—'] }] });
    const removed = editInstructions(added.file, { remove: 'no-secret-logs' });
    expect(removed).toMatchObject({ instruction: { id: 'no-secret-logs', text: 'Never log webhook secrets' } });
    if (!('file' in removed)) throw new Error('Expected an edit.');
    expect(JSON.parse(removed.file).instructions.map((item: { id: string }) => item.id)).toEqual(['Broken Entry', 'never-log-webhook-secrets']);
    expect(editInstructions(null, { add: { text: 'Less text' } })).toEqual({ file: '{\n  "instructions": [\n    {\n      "id": "less-text",\n      "text": "Less text"\n    }\n  ]\n}\n', instruction: { id: 'less-text', text: 'Less text' } });
    expect(editInstructions(file, { remove: 'missing' })).toEqual({ status: 404, error: 'There is no instruction "missing" on main.' });
    expect(editInstructions('{nope', { add: { text: 'x' } })).toMatchObject({ status: 409 });
    const full = JSON.stringify({ instructions: Array.from({ length: 100 }, (_, index) => ({ id: `rule-${index}`, text: 'x' })) });
    expect(editInstructions(full, { add: { text: 'One more' } })).toMatchObject({ status: 409, error: expect.stringContaining('100 instructions') });
  });

  it('makes short, unique ids from an instruction’s first words', () => {
    expect(instructionId('No em dashes in UI copy', new Set())).toBe('no-em-dashes-in-ui-copy');
    expect(instructionId('No em dashes in UI copy', new Set(['no-em-dashes-in-ui-copy', 'no-em-dashes-in-ui-copy-2']))).toBe('no-em-dashes-in-ui-copy-3');
    expect(instructionId('Use `cf`, never wrangler, for every deployment of this Worker', new Set())).toBe('use-cf-never-wrangler-for-every');
    expect(instructionId('Café — déjà vu', new Set())).toBe('cafe-deja-vu');
    expect(instructionId('—', new Set())).toBe('instruction');
    expect(instructionId('x'.repeat(50), new Set())).toBe('x'.repeat(32));
  });
});

describe('the Braid section of AGENTS.md', () => {
  it('describes each instruction on one line with what it blocks where', () => {
    expect(describeInstruction(secrets)).toBe('Never log webhook secrets. Blocked in `src/**`: `console.log(secret`.');
    expect(describeInstruction(backoff)).toBe('Retries back off; never retry 4xx except 429.');
    expect(describeInstruction({ id: 'a', text: 'Docs stay short', paths: ['docs/**', '*.md'] })).toBe('Docs stay short. Applies to `docs/**`, `*.md`.');
    expect(describeInstruction({ id: 'b', text: 'No inline code markers', block: ['`any`'] })).toBe('No inline code markers. Blocked: `` `any` ``.');
  });

  it('appends the section, replaces it in place and keeps every other byte', () => {
    const agents = '# Working agreements\r\n\r\nKeep the delivery interface small.';
    const first = withInstructions(agents, [secrets])!;
    expect(first).toBe(`${agents}\r\n\r\n${section(secrets).replaceAll('\n', '\r\n')}\r\n`);
    const edited = `${first}\r\n## Local notes\r\nRun npm test.\r\n`;
    const second = withInstructions(edited, [secrets, backoff])!;
    expect(second).toBe(`${agents}\r\n\r\n${section(secrets, backoff).replaceAll('\n', '\r\n')}\r\n\r\n## Local notes\r\nRun npm test.\r\n`);
    expect(withInstructions('', [backoff])).toBe(`${section(backoff)}\n`);
    expect(withInstructions(null, [backoff])).toBe(`${section(backoff)}\n`);
  });

  it('only treats markers on lines of their own as the section', () => {
    const quoted = 'Braid writes `<!-- braid:instructions:start -->` and an end marker.\n';
    expect(withInstructions(quoted, [backoff])).toBe(`${quoted}\n${section(backoff)}\n`);
  });

  it('removes the section with its last instruction, and a file that held nothing else', () => {
    const agents = '# Agents\n\nRead the README.\n';
    expect(withInstructions(withInstructions(agents, [secrets]), [])).toBe(agents);
    expect(withInstructions(withInstructions(null, [secrets]), [])).toBeNull();
    expect(withInstructions(agents, [])).toBe(agents);
    expect(withInstructions(null, [])).toBeNull();
  });
});
