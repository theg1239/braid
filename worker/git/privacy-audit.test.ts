import { expect, it } from 'vitest';
import { withheldFixture, origin } from '../test/withheld';
import api from '../http/api';
import { concat, FLUSH, pktLine } from './transport';

it('hides upload and retention refs and refuses anonymous wants for their commits and raw blob hashes', async () => {
  const f = await withheldFixture();
  try {
    const pushed = await f.beginPush(); await pushed.finish();
    const secretBlob = f.h.git.native(['rev-parse', `${f.tip}:client.ts`]).trim();
    const upload = 'refs/braid/uploads/fixture-owner/pending';
    f.h.git.native(['update-ref', upload, f.tip]);
    const clean = f.h.git.commitTree({ 'clean.txt': 'Public proposed content\n' }, f.base);
    const accepted = await f.beginPush(clean, 'clean'); await accepted.finish();
    const retention = f.h.git.native(['for-each-ref', '--format=%(refname)', 'refs/braid/revisions']).trim();
    expect(retention).toMatch(/^refs\/braid\/revisions\/[a-f0-9]{40}$/);
    const retained = f.h.git.native(['rev-parse', retention]).trim();
    const cleanBlob = f.h.git.native(['rev-parse', `${clean}:clean.txt`]).trim();
    const advertised = await (await f.call('/git/w.git/info/refs?service=git-upload-pack')).text();
    expect(advertised).not.toContain('refs/braid/');
    for (const version of [1, 2] as const) for (const hash of [f.tip, secretBlob, cleanBlob, retained]) {
      const response = await f.upload(hash, version);
      expect(response.status, `v${version} ${hash}`).toBe(404);
    }
    const request = (lines: Uint8Array[]) => api.fetch(new Request(`${origin}/git/w.git/git-upload-pack`, {
      method: 'POST', headers: { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' }, body: concat(lines),
    }), f.env);
    const listed = await request([pktLine('command=ls-refs\n'), new TextEncoder().encode('0001'), FLUSH]);
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain('refs/braid/');
    for (const ref of [upload, retention]) {
      const response = await request([pktLine('command=fetch\n'), new TextEncoder().encode('0001'), pktLine(`want-ref ${ref}\n`), pktLine('done\n'), FLUSH]);
      expect(response.status).toBe(404);
    }
    expect((await f.call(`/api/repository?ref=${secretBlob}&path=client.ts`)).status).toBe(404);
  } finally { await f.close(); }
});
