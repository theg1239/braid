import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, repository, testContext } from '../test/helpers';
import { collectChanges, validatePush } from './collect';

afterEach(cleanup);

describe('submission sizes', () => {
  it('collects more than 256 text files and more than 3 MiB of content', () => {
    const repo = repository(), base = repo.commit({ 'README.md': 'Base\n' }, 'Start');
    repo.commit(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`file-${i}.txt`, 'line\n'.repeat(3000)])), 'Add files');
    const { context } = testContext({ cwd: repo.root, env: repo.env });
    const result = collectChanges(context, repo.root, base, []);
    expect(result.files).toHaveLength(257);
    expect(result.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content ?? ''), 0)).toBeGreaterThan(3 * 1024 * 1024);
  });

  it('validates 50 MiB of binary files for native Git submission without a JSON text conversion', () => {
    const repo = repository(), base = repo.commit({ 'README.md': 'Base\n' }, 'Start');
    const blob = 'binary\0'.repeat(Math.ceil(25 * 1024 * 1024 / 7)).slice(0, 25 * 1024 * 1024);
    repo.commit({ 'a.bin': blob, 'b.bin': blob.slice(0, -1) + 'b' }, 'Add assets');
    const { context } = testContext({ cwd: repo.root, env: repo.env });
    expect(() => validatePush(context, repo.root, base, [])).not.toThrow();
    expect(() => collectChanges(context, repo.root, base, [])).toThrow('Binary');
  });
});
