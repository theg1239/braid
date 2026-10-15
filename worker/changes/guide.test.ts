import { describe, expect, it, vi } from 'vitest';
import { GUIDE_MODEL, guidePrompt, hostedGuide, parseGuide, prepareGuide, type GuideInput } from './guide';

const input: GuideInput = { title: 'Bound retry delays', summary: 'Honor Retry-After up to a minute.', description: 'Avoid unbounded delays from receivers.', attributes: [], files: [
  { path: 'src/delivery.ts', before: 'export const delay = 1000;\n', after: 'export const delay = 60000;\n' },
  { path: 'test/delivery.ts', before: null, after: 'expect(delay).toBe(60000);\n' },
] };
const prepared = prepareGuide(input);
const ref = (i: number) => { const { path, newStart, newLines } = prepared.hunks[i]; return { path, newStart, newLines }; };
const answer = () => ({ before: 'Retries waited a second.', after: 'Retries wait up to a minute.', chapters: [
  { title: 'Bound delivery delays', summary: 'Changes the delay in the delivery module.', kind: 'logic', hunks: [ref(0)] },
  { title: 'Tests', summary: 'Checks the new delay.', kind: 'tests', hunks: [ref(1)] },
] });

describe('model-only guide boundary', () => {
  it('keeps the entire diff, description and explicit attributes in the prompt', () => {
    const prompt = guidePrompt(prepared);
    const data = JSON.parse(prompt[1].content);
    expect(data).toMatchObject({ title: input.title, summary: input.summary, authorDescription: input.description, attributes: [] });
    expect(data.hunks).toHaveLength(2);
    expect(data.hunks[0].diff).toContain('-export const delay = 1000;\n+export const delay = 60000;');
    expect(data.hunks[1].diff).toContain('+expect(delay).toBe(60000);');
  });
  it('parses each Workers AI envelope and restores exact old and new ranges', () => {
    for (const response of [answer(), JSON.stringify(answer()), { response: answer() }, { choices: [{ message: { content: '```json\n' + JSON.stringify(answer()) + '\n```' } }] }]) {
      const result = parseGuide(response, prepared, 7);
      expect(result).toMatchObject({ status: 'ready', revision: 7, generatedBy: GUIDE_MODEL, chapters: [
        { id: 'guide-7-1', kind: 'logic', files: [{ path: 'src/delivery.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] },
        { id: 'guide-7-2', kind: 'tests', files: [{ path: 'test/delivery.ts', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] }] },
      ] });
    }
  });
  it('preserves semantic kinds and grouping chosen by the model, even for misleading paths', () => {
    const value = answer(); value.chapters[0].kind = 'mechanical'; value.chapters[1].kind = 'logic';
    value.chapters.reverse();
    const result = parseGuide(value, prepared, 1);
    expect(result.chapters.map(chapter => [chapter.kind, chapter.files[0].path])).toEqual([['logic', 'test/delivery.ts'], ['mechanical', 'src/delivery.ts']]);
  });
  it('rejects missing, duplicate, invented and renumbered hunks without repairing them', () => {
    const missing = answer(); missing.chapters.pop();
    expect(() => parseGuide(missing, prepared, 1)).toThrow(/Missing 1 hunks/);
    const duplicate = answer(); duplicate.chapters[0].hunks.push(ref(1));
    expect(() => parseGuide(duplicate, prepared, 1)).toThrow(/more than once/);
    for (const ref of [{ path: 'other.ts', newStart: 1, newLines: 1 }, { path: 'src/delivery.ts', newStart: 2, newLines: 1 }]) {
      const invalid = answer(); invalid.chapters[0].hunks = [ref];
      expect(() => parseGuide(invalid, prepared, 1)).toThrow(/absent/);
    }
  });
  it('rejects invalid kinds, empty prose, lengthy titles, coordinates and trailing logic', () => {
    for (const invalid of [null, {}, { ...answer(), before: '' }, { ...answer(), before: 'One sentence. Two sentences. Three sentences.' }, { ...answer(), chapters: [{ ...answer().chapters[0], title: 'one two three four five six seven eight nine' }] },
      { ...answer(), chapters: [{ ...answer().chapters[0], kind: 'heuristic' }] },
      { ...answer(), chapters: [{ ...answer().chapters[0], hunks: [{ ...ref(0), newStart: -1 }] }] }]) expect(() => parseGuide(invalid, prepared, 1)).toThrow(/Invalid guide JSON/);
    const reversed = answer(); reversed.chapters.reverse();
    expect(() => parseGuide(reversed, prepared, 1)).toThrow(/Tests and Generated must be last/);
  });
  it('fails oversized input without silently dropping a file or hunk', () => {
    expect(() => prepareGuide({ ...input, files: [{ path: 'large.ts', before: '', after: 'x'.repeat(100_000) }] })).toThrow(/token budget/);
    expect(() => prepareGuide({ ...input, files: [{ path: 'huge.ts', before: '', after: 'x'.repeat(1_000_001) }] })).toThrow(/diff limit/);
  });
  it('includes deletions, separated hunks and file metadata anchors', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}\n`);
    const changed = [...lines]; changed[1] = 'first\n'; changed[38] = 'last\n';
    const result = prepareGuide({ ...input, files: [
      { path: 'many.ts', before: lines.join(''), after: changed.join('') },
      { path: 'deleted.ts', before: 'gone\n', after: null },
      { path: 'empty', before: null, after: '' },
      { path: 'script', before: 'same', after: 'same', mode: '100755' },
    ] });
    expect(result.hunks.filter(hunk => hunk.path === 'many.ts')).toHaveLength(2);
    expect(result.hunks.find(hunk => hunk.path === 'deleted.ts')).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    expect(result.hunks.find(hunk => hunk.path === 'script')?.diff).toContain('100755');
    expect(result.hunks.find(hunk => hunk.path === 'empty')).toMatchObject({ newStart: 0, newLines: 0 });
  });
  it('uses the strong model and supplies the exact validation error on a retry', async () => {
    const run = vi.fn(async () => ({ response: answer() }));
    await hostedGuide({ run } as unknown as Ai, prepared, 1, GUIDE_MODEL, 'Missing one hunk.');
    const [model, request] = run.mock.calls[0] as unknown as [string, { messages: { content: string }[]; response_format: { type: string } }];
    expect(model).toBe(GUIDE_MODEL);
    expect(request.messages.at(-1)?.content).toContain('Missing one hunk.');
    expect(request.response_format.type).toBe('json_schema');
  });
});
