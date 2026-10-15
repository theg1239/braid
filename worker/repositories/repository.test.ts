import { describe, it, expect, vi } from 'vitest';
import { demoEntries, directoryEntries, fileAt, ObjectMemory, repositoryEntry, repositoryPath, TEXT_LIMIT, treePage } from './repository';

describe('complete repository tree browsing', () => {
  const ref = 'a'.repeat(40);
  it('lists binary, protected, ignored-context and special entries without reading blobs', async () => {
    const readFile = vi.fn(() => { throw new Error('Do not read blobs for directory metadata.'); });
    const raw = [
      { name: '.github', type: 'tree', mode: '040000', hash: 'nested' },
      { name: 'vendor', type: 'tree', mode: '040000', hash: 'vendor' },
      { name: 'pnpm-lock.yaml', type: 'blob', mode: '100644', hash: 'lock' },
      { name: 'photo.png', type: 'blob', mode: '100644', hash: 'image' },
      { name: 'CLAUDE.md', type: 'symlink', mode: '120000', hash: 'link' },
      { name: 'module', type: 'gitlink', mode: '160000', hash: 'module' },
    ];
    const repo = { readFile, readCommit: async () => ({ treeHash: 'root' }), readTree: vi.fn(async (hash: string) => hash === 'root' ? raw : [{ name: 'ci.yml', type: 'blob', mode: '100644', hash: 'file' }]) } as unknown as ArtifactsRepo;
    const entries = await directoryEntries(repo, ref, '');
    expect(entries.map(entry => entry.name)).toEqual(raw.map(entry => entry.name));
    expect(entries.slice(-2).map(entry => entry.kind)).toEqual(['symlink', 'submodule']);
    expect(await directoryEntries(repo, ref, '.github')).toEqual([expect.objectContaining({ path: '.github/ci.yml' })]);
    expect(await repositoryEntry(repo, ref, 'module')).toMatchObject({ kind: 'submodule' });
    await expect(directoryEntries(repo, ref, 'CLAUDE.md')).rejects.toThrow('Directory not found');
    await expect(directoryEntries(repo, ref, 'module')).rejects.toThrow('Directory not found');
    expect(readFile).not.toHaveBeenCalled();
  });
  it('paginates all 1,201 entries without omitting or duplicating a path', () => {
    const entries = Array.from({ length: 1201 }, (_, index) => ({ name: `file-${index}.bin`, path: `file-${index}.bin`, mode: '100644', hash: String(index), kind: 'file' as const }));
    let cursor: string | null = null;
    const listed: string[] = [];
    do { const page = treePage(ref, '', entries, cursor); listed.push(...page.entries.map(e => e.path)); cursor = page.nextCursor; } while (cursor);
    expect(new Set(listed).size).toBe(1201);
    expect(listed.length).toBe(1201);
    for (const invalid of ['-1', '1.2', '1e2', '9007199254740993', '1202']) expect(() => treePage(ref, '', entries, invalid)).toThrow('cursor');
  });
  it('rejects traversal while preserving legitimate hidden and deep paths', () => {
    for (const path of ['../x', 'a/../x', '/root', 'a//x', '.git/config', 'a\\b', 'x\0y']) expect(() => repositoryPath(path)).toThrow();
    expect(repositoryPath('a/'.repeat(40) + '.config')).toBe('a/'.repeat(40) + '.config');
    expect(demoEntries({ 'src/a.ts': '', 'src/lib/b.ts': '', '.braid/tasks/x.json': '' }, 'src').map(e => [e.name, e.kind])).toEqual([['a.ts', 'file'], ['lib', 'dir']]);
  });
});

describe('files at a commit', () => {
  const ref = 'a'.repeat(40);
  const root: ArtifactsTreeEntry[] = [
    { name: 'README.md', type: 'blob', mode: '100644', hash: 'readme' }, { name: 'COPY.md', type: 'blob', mode: '100644', hash: 'readme' }, { name: 'BOM.md', type: 'blob', mode: '100644', hash: 'bom' },
    { name: 'photo.png', type: 'blob', mode: '100644', hash: 'photo' }, { name: 'big.txt', type: 'blob', mode: '100644', hash: 'big' },
    { name: 'huge.bin', type: 'blob', mode: '100644', hash: 'huge' }, { name: 'link', type: 'symlink', mode: '120000', hash: 'link' },
    { name: 'module', type: 'gitlink', mode: '160000', hash: 'module' }, { name: 'src', type: 'tree', mode: '040000', hash: 'src' },
  ];
  const blobs: Record<string, string | Uint8Array> = { readme: '# Relay\n', bom: '\uFEFF# Relay\n', photo: new Uint8Array([0x89, 0x50, 0, 1]), big: 'x'.repeat(TEXT_LIMIT + 1), link: 'README.md' };
  const source = () => ({
    readCommit: vi.fn(async () => ({ treeHash: 'root' })),
    readTree: vi.fn(async (hash: string) => hash === 'root' ? root : hash === 'src' ? [] : null),
    readBlob: vi.fn(async (hash: string) => {
      if (hash === 'huge') throw Object.assign(new Error('too large'), { code: 'MEMORY_LIMIT' });
      return hash in blobs ? new Blob([blobs[hash] as string]) : null;
    }),
  });
  it('answers text, binaries, oversized files, symlinks, submodules and directories as the browser shows them', async () => {
    const repo = source();
    expect(await fileAt(repo, ref, 'README.md')).toEqual({ path: 'README.md', ref, hash: 'readme', size: 8, content: '# Relay\n', kind: 'text' });
    expect(await fileAt(repo, ref, 'BOM.md')).toMatchObject({ size: 11, content: '# Relay\n', kind: 'text' });
    expect(await fileAt(repo, ref, 'photo.png')).toMatchObject({ kind: 'binary', content: '', size: 4 });
    expect(await fileAt(repo, ref, 'big.txt')).toMatchObject({ kind: 'large', content: '', size: TEXT_LIMIT + 1 });
    expect(await fileAt(repo, ref, 'huge.bin')).toEqual({ path: 'huge.bin', ref, hash: 'huge', content: '', kind: 'large' });
    expect(await fileAt(repo, ref, 'link')).toMatchObject({ kind: 'symlink', content: 'README.md' });
    expect(await fileAt(repo, ref, 'module')).toEqual({ path: 'module', ref, hash: 'module', content: '', kind: 'submodule' });
    expect(await fileAt(repo, ref, 'src')).toEqual({ path: 'src', ref, hash: 'src', content: '', kind: 'dir' });
    await expect(fileAt(repo, ref, 'missing.ts')).rejects.toThrow('File not found');
    await expect(fileAt(repo, 'b'.repeat(40), '../x')).rejects.toThrow('Invalid repository path');
  });
  it('reads each commit, tree and blob from Artifacts once, however many paths or concurrent readers share them', async () => {
    const repo = source(), reader = new ObjectMemory().reader(repo);
    const [first, second] = await Promise.all([fileAt(reader, ref, 'README.md'), fileAt(reader, ref, 'COPY.md')]);
    expect(first.content).toBe('# Relay\n'); expect(second.content).toBe('# Relay\n');
    expect((await directoryEntries(reader, ref, '')).map(item => item.name)).toContain('src');
    await directoryEntries(reader, ref, 'src');
    expect(repo.readCommit).toHaveBeenCalledTimes(1);
    expect(repo.readTree.mock.calls).toEqual([['root'], ['src']]);
    expect(repo.readBlob).toHaveBeenCalledTimes(1);
    // A blob Artifacts could not buffer, and an object it does not have, are asked for again rather than remembered.
    await fileAt(reader, ref, 'huge.bin'); await fileAt(reader, ref, 'huge.bin');
    expect(repo.readBlob.mock.calls.slice(1)).toEqual([['huge'], ['huge']]);
    await expect(fileAt(reader, ref, 'src/missing.ts')).rejects.toThrow('File not found');
    await expect(fileAt(reader, 'b'.repeat(40), 'README.md')).resolves.toMatchObject({ kind: 'text' });
    expect(repo.readTree.mock.calls.filter(([hash]) => hash === 'src')).toHaveLength(1);
  });
  it('keeps what it holds within its byte bound, dropping the least recently used first and never a blob too large to keep', async () => {
    const readTree = vi.fn(async (hash: string) => Array.from({ length: 10 }, (_, index) => ({ name: `${hash}-${index}`, type: 'blob' as const, mode: '100644', hash: `${hash}:${index}` })));
    const readBlob = vi.fn(async (hash: string) => new Blob([new Uint8Array(hash === 'big' ? 2 * 1024 * 1024 : 100)]));
    // Each tree counts 1,280 bytes, so four fit in 5,200 and a fifth evicts the least recently used; a blob over a megabyte is read every time.
    const reader = new ObjectMemory(5_200).reader({ readCommit: vi.fn(), readTree, readBlob });
    for (const hash of ['t0', 't1', 't2', 't3']) await reader.readTree(hash);
    await reader.readTree('t0');
    await reader.readTree('t4');
    expect(readTree).toHaveBeenCalledTimes(5);
    await reader.readTree('t0'); await reader.readTree('t4');
    expect(readTree).toHaveBeenCalledTimes(5);
    await reader.readTree('t1');
    expect(readTree).toHaveBeenCalledTimes(6);
    await reader.readBlob('big'); await reader.readBlob('big'); await reader.readBlob('small'); await reader.readBlob('small');
    expect(readBlob.mock.calls).toEqual([['big'], ['big'], ['small']]);
  });
});
