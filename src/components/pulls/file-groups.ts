import type { ChangeGuide, GuideChapterKind } from '../../../shared/guide';

interface FileGroups<T> { main: T[]; tests: T[]; generated: T[] }

/** Only explicit attributes and ready Guide kinds affect order; filenames and file contents never do. */
export function groupFiles<T extends { path: string }>(files: readonly T[], guide?: ChangeGuide | null): FileGroups<T> {
  const attributes = new Map(guide?.attributes.map(attribute => [attribute.path, attribute]));
  const kinds = new Map<string, Set<GuideChapterKind>>();
  if (guide?.status === 'ready') for (const chapter of guide.chapters) for (const file of chapter.files) {
    const set = kinds.get(file.path) ?? new Set<GuideChapterKind>();
    set.add(chapter.kind); kinds.set(file.path, set);
  }
  const main: T[] = [], supporting: T[] = [], tests: T[] = [], generated: T[] = [];
  for (const file of files) {
    const attribute = attributes.get(file.path), assigned = kinds.get(file.path);
    if (attribute?.generated === true || attribute?.vendored === true) generated.push(file);
    else if (!assigned?.size || assigned.has('logic') || assigned.has('mechanical')) main.push(file);
    else if (assigned.has('config') || assigned.has('docs')) supporting.push(file);
    else if (assigned.has('tests')) tests.push(file);
    else if (assigned.has('generated') && attribute?.generated !== false) generated.push(file);
    else main.push(file);
  }
  return { main: [...main, ...supporting], tests, generated };
}

export function groupingKey(groups: FileGroups<{ path: string }>): string {
  return JSON.stringify([groups.main.map(file => file.path), groups.tests.map(file => file.path), groups.generated.map(file => file.path)]);
}
