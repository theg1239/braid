import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../git/transport';
import { startGitServer } from '../test/git-server';
import { copyInParts } from './mirror-parts';

const servers: Awaited<ReturnType<typeof startGitServer>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

/** GitHub serves any reachable object and filtered packs; Artifacts takes shallow pushes. */
async function pair() {
  const source = await startGitServer(), target = await startGitServer();
  servers.push(source, target);
  source.native(['config', 'uploadpack.allowFilter', 'true']);
  source.native(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  target.native(['config', 'receive.shallowUpdate', 'true']);
  return { source, target };
}
/** Text that barely compresses, so pack sizes follow file sizes. */
const noise = (bytes: number) => randomBytes(bytes).toString('base64');
const endpoint = (server: { remote: string }) => ({ remote: server.remote, token: '' });

describe('copyInParts', () => {
  it('copies a snapshot larger than one part as directories and batches of files, then the commit, shallow, on its branch', async () => {
    const { source, target } = await pair();
    const files = { 'README.md': '# Large\n', 'src/a.ts': noise(3000), 'src/b.ts': noise(3000), 'src/deep/c.ts': noise(3000), 'docs/d.md': noise(3000), 'e.bin': noise(3000) };
    const first = source.commitTree(files, undefined, 'First');
    const commit = source.commitTree({ ...files, 'src/a.ts': noise(3000) }, first, 'Second');
    source.native(['update-ref', 'refs/heads/main', commit]);
    let parts = 0;
    await copyInParts({ source: endpoint(source), target: endpoint(target), commit, branch: 'main', partBytes: 6000, fileBytes: 8000, progress: async () => { parts++; } });
    expect(target.native(['rev-parse', 'refs/heads/main']).trim()).toBe(commit);
    expect(target.native(['ls-tree', '-r', '--name-only', commit]).trim().split('\n').sort()).toEqual(Object.keys(files).sort());
    for (const path of Object.keys(files)) expect(target.native(['cat-file', 'blob', `${commit}:${path}`])).toBe(source.native(['cat-file', 'blob', `${commit}:${path}`]));
    // The parent stays at the source: the copy is one commit deep, as a depth-one import is.
    expect(() => target.native(['cat-file', '-e', first])).toThrow();
    expect(target.native(['for-each-ref', 'refs/braid/']).trim()).toBe('');
    expect(parts).toBeGreaterThan(3);
  });

  it('refuses a file larger than one push may carry', async () => {
    const { source, target } = await pair();
    const commit = source.commitTree({ 'small.txt': 'small\n', 'large.bin': noise(9000) }, undefined, 'Large file');
    source.native(['update-ref', 'refs/heads/main', commit]);
    const copy = copyInParts({ source: endpoint(source), target: endpoint(target), commit, branch: 'main', partBytes: 2000, fileBytes: 4000 });
    await expect(copy).rejects.toBeInstanceOf(GitError);
    await expect(copy).rejects.toMatchObject({ code: 'too_large' });
    expect(() => target.native(['rev-parse', '--verify', 'refs/heads/main'])).toThrow();
  });

  it('resumes from the parts a stopped copy stored', async () => {
    const { source, target } = await pair();
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`dir-${index}/file.txt`, noise(2500)]));
    const commit = source.commitTree(files, undefined, 'Six directories');
    source.native(['update-ref', 'refs/heads/main', commit]);
    const options = { source: endpoint(source), target: endpoint(target), commit, branch: 'main', partBytes: 4000, fileBytes: 8000 };
    let stored = 0;
    await expect(copyInParts({ ...options, progress: async () => { if (++stored === 3) throw new Error('Stopped.'); } })).rejects.toThrow('Stopped.');
    const kept = target.native(['for-each-ref', '--format=%(refname)', 'refs/braid/parts/']).trim().split('\n').filter(Boolean);
    expect(kept.length).toBe(3);
    const before = source.requests.length;
    await copyInParts(options);
    expect(target.native(['rev-parse', 'refs/heads/main']).trim()).toBe(commit);
    expect(target.native(['for-each-ref', 'refs/braid/']).trim()).toBe('');
    // The three stored directories are not fetched again: the trees, one try of the whole root, and the other three.
    const fetched = source.requests.slice(before).filter(request => request.path.endsWith('/git-upload-pack')).length;
    expect(fetched).toBe(5);
  });
});
