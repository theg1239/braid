import { describe, expect, it } from 'vitest';
import type { ChangeGuide, GuideChapterKind } from '../../../shared/guide';
import { groupFiles } from './file-groups';

const files = ['aaa.test.ts', 'build/generated.js', 'package-lock.json', 'README.md', 'src/logic.ts'].map(path => ({ path }));
function guide(kinds: [string, GuideChapterKind][]): ChangeGuide {
  return { status: 'ready', revision: 1, attributes: [], generatedBy: 'test-model', chapters: kinds.map(([path, kind], index) => ({ id: String(index), title: kind, summary: '', kind, files: [{ path, hunks: [] }] })) };
}
const paths = (items: { path: string }[]) => items.map(item => item.path);
describe('explicit file grouping', () => {
  it('preserves the existing order without assigning any meaning to path names', () => {
    expect(groupFiles(files)).toEqual({ main: files, tests: [], generated: [] });
  });
  it('puts logic first, then config/docs, then collapsed Tests and Generated', () => {
    const groups = groupFiles(files, guide([['aaa.test.ts', 'tests'], ['build/generated.js', 'generated'], ['package-lock.json', 'config'], ['README.md', 'docs'], ['src/logic.ts', 'logic']]));
    expect(paths(groups.main)).toEqual(['src/logic.ts', 'package-lock.json', 'README.md']);
    expect(paths(groups.tests)).toEqual(['aaa.test.ts']);
    expect(paths(groups.generated)).toEqual(['build/generated.js']);
  });
  it.each(['pending', 'failed'] as const)('ignores chapter kinds while the guide is %s', status => {
    expect(groupFiles(files, { ...guide([['aaa.test.ts', 'tests']]), status }).main).toEqual(files);
  });
  it('uses explicit generated/vendored flags even while the model is pending', () => {
    const value = { ...guide([]), status: 'pending' as const, attributes: [{ path: 'src/logic.ts', generated: true }, { path: 'README.md', vendored: true }, { path: 'build/generated.js', generated: false }] };
    const groups = groupFiles(files, value);
    expect(paths(groups.generated)).toEqual(['README.md', 'src/logic.ts']);
    expect(paths(groups.main)).toContain('build/generated.js');
  });
  it('keeps mixed logic/tests visible and preserves explicit generated unsets', () => {
    const value = guide([['aaa.test.ts', 'tests'], ['aaa.test.ts', 'logic'], ['build/generated.js', 'generated']]);
    value.attributes = [{ path: 'build/generated.js', generated: false }];
    expect(groupFiles(files, value)).toEqual({ main: files, tests: [], generated: [] });
  });
});
