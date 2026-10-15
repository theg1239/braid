import { describe, expect, it } from 'vitest';
import { changedFiles } from './history';

const files = (entries: Record<string, string>): ArtifactsTreeEntry[] => Object.entries(entries).map(([name, hash]) => ({ name, hash, mode: '100644', type: 'blob' }));

describe('the files a push changes', () => {
  it('keeps a byte-order mark, so the change lands the file as it was pushed', async () => {
    const artifacts = { readTree: async (hash: string) => hash === 'after' ? files({ 'notes.txt': 'bom' }) : [], readBlob: async () => new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])]) };
    expect(await changedFiles(artifacts, 'before', 'after')).toEqual([{ path: 'notes.txt', blob: 'bom', mode: '100644' }]);
  });

  it('refuses a pushed tree Artifacts cannot read rather than proposing to delete what it holds', async () => {
    const artifacts = { readTree: async (hash: string) => hash === 'before' ? files({ 'kept.txt': 'kept' }) : null, readBlob: async () => null };
    await expect(changedFiles(artifacts, 'before', 'after')).rejects.toMatchObject({ status: 503 });
  });
});
