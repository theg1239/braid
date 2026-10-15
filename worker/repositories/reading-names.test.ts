import { describe, expect, it } from 'vitest';
import { readingNames } from './repository';
import { NOTES_REF } from '../../shared/provenance';

const head = 'a'.repeat(40), tree = 'b'.repeat(40);
/**
 * A Workers RPC stub answers any property with a remote one, so `method.bind` is a call to the far side rather than
 * Function.prototype.bind, and the stub is not a promise. Plain fakes hide that; this one behaves like the stub.
 */
function rpcStub() {
  const method = <T>(answer: (...args: unknown[]) => T) => Object.assign(async (...args: unknown[]) => answer(...args), { bind: () => Promise.resolve('remote bind') });
  return {
    log: method((options: unknown) => {
      const ref = (options as { ref?: string }).ref;
      if (ref?.startsWith('refs/')) throw new Error('Artifacts does not accept refs/... names');
      return ref === head ? [{ hash: head }] : [];
    }),
    readCommit: method((hash: unknown) => (hash === head ? { hash: head, tree } : null)),
    readTree: method(() => [{ name: 'README.md', hash: 'c'.repeat(40), mode: '100644', type: 'blob' }]),
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

describe('reading a live repository through an RPC stub', () => {
  it('calls the stub’s methods directly, never through bind, and is not a promise', async () => {
    const repo = readingNames(rpcStub(), { branch: 'main', head });
    expect(await repo.readCommit(head)).toEqual({ hash: head, tree });
    expect(await repo.readTree(tree)).toHaveLength(1);
    // The default branch, which this copy cannot resolve by name, is read at the recorded head.
    expect(await repo.log({ ref: 'main', limit: 1 })).toEqual([{ hash: head }]);
    expect(await repo.log({ ref: 'refs/heads/main', limit: 1 })).toEqual([{ hash: head }]);
    expect((repo as unknown as { then?: unknown }).then).toBeUndefined();
    expect(await Promise.resolve(repo)).toBe(repo);
  });
  it('reads notes by their known commit and treats absent or unavailable notes as optional', async () => {
    const known = readingNames(rpcStub(), { branch: 'main', head, notes: async () => head });
    expect(await known.log({ ref: NOTES_REF, limit: 1 })).toEqual([{ hash: head }]);
    // The stub has no Git-token methods: a cached miss must not start another upstream lookup.
    for (const notes of [undefined, async () => null, async () => { throw new Error('Trunk unavailable'); }]) {
      const repo = readingNames(rpcStub(), { branch: 'main', head, notes });
      expect(await repo.log({ ref: NOTES_REF, limit: 1 })).toEqual([]);
    }
  });
});
