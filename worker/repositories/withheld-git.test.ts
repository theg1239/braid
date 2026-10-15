import { describe, expect, it } from 'vitest';
import { extractPack, withheldFixture as fixture, observe, parentText, recovered, tipText } from '../test/withheld';

describe('withheld pushed revisions: anonymous upload-pack', () => {
  it.each([['incoming', 1], ['incoming', 2], ['deleted', 1], ['deleted', 2]] as const)('refuses hidden wants (%s, protocol v%i)', async (phase, version) => {
    const f = await fixture();
    try {
      const pushed = await f.beginPush(); if (phase === 'deleted') await pushed.finish();
      const ad = await (await f.call('/git/w.git/info/refs?service=git-upload-pack')).text();
      expect(ad).not.toContain(f.tip); expect(ad).not.toContain(f.parent);
      for (const hash of [f.tip, f.parent]) for (const gzip of [false, true]) {
        const response = await f.upload(hash, version, gzip), pack = extractPack(response.bytes, version);
        // Decode an actual returned pack in a fresh repository: PACK bytes alone are not proof of disclosure.
        let leaked = false;
        if (pack) leaked = recovered(pack, hash, hash === f.tip ? 'client.ts' : 'past.txt') === (hash === f.tip ? tipText : parentText);
        observe({ phase, version, gzip, target: hash === f.tip ? 'tip' : 'parent', status: response.status, pack: !!pack, recovered: leaked, upstreamError: response.bytes.subarray(0, 140).toString().includes('ERR ') });
        expect.soft(!!pack, `${phase} v${version} gzip=${gzip}: hidden objects must not leave the gateway`).toBe(false);
        expect.soft(leaked).toBe(false);
      }
      if (phase === 'incoming') await pushed.finish();
    } finally { await f.close(); }
  });

  it.each([1, 2] as const)('still transfers advertised history and clean open PR commits (protocol v%i)', async version => {
    const f = await fixture();
    try {
      const clean = f.h.git.commitTree({ 'clean.txt': 'published clean proposal\n' }, f.base, 'Clean');
      const pushed = await f.beginPush(clean, 'clean');
      // Git v1 in this fixture refuses dangling commits after deletion; v2 allows them.
      if (version === 2) await pushed.finish();
      for (const [hash, path, content] of [[f.base, 'README.md', '# Relay\n'], [clean, 'clean.txt', 'published clean proposal\n']]) {
        const response = await f.upload(hash, version), pack = extractPack(response.bytes, version);
        expect(response.status).toBe(200); expect(pack).not.toBeNull();
        expect(recovered(pack!, hash, path)).toBe(content);
      }
      if (version === 1) await pushed.finish();
    } finally { await f.close(); }
  });
});
