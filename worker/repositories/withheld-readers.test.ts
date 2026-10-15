import { describe, expect, it } from 'vitest';
import { withheldFixture as fixture, marker, observe, parentText, secret, tipText } from '../test/withheld';

const query = (path: string, values: Record<string, string>) => `${path}?${new URLSearchParams(values)}`;
describe('withheld pushed revisions: the repository read boundary', () => {
  it.each(['incoming', 'deleted'] as const)('refuses the withheld tip and its exclusive parent with the ref %s', async phase => {
    const f = await fixture();
    try {
      const pushed = await f.beginPush();
      if (phase === 'deleted') await pushed.finish();
      expect(await (await f.call(`/api/changes/${pushed.change.id}`)).json()).toMatchObject({ headCommit: f.tip });
      expect(await (await f.call(`/api/changes/${pushed.change.id}/diff?path=client.ts`)).json()).toMatchObject({ withheld: true, before: null, after: null });
      const listed = await (await f.call('/git/w.git/info/refs?service=git-upload-pack')).text();
      expect(listed).not.toContain(f.tip); expect(listed).not.toContain(pushed.incoming);
      const cursor = btoa(JSON.stringify({ v: 1, ref: 'main', path: '', head: f.tip, next: f.parent }));
      const requests = [
        ...[[f.tip, 'client.ts'], [f.parent, 'past.txt']].flatMap(([ref, path]) => [
          ['file', query('/api/repository', { ref, path })],
          ['raw/download', query('/api/repository', { ref, path, download: '1' })],
          ['tree', query('/api/repository/tree', { ref })],
          ['search', query('/api/repository/search', { ref, q: marker })],
          ['history', query('/api/repository/commits', { ref })],
          ['commit', query('/api/repository/commit', { sha: ref })],
          ['commit diff', query('/api/repository/commit/diff', { sha: ref, path })],
          ['compare', query('/api/repository/compare', { base: f.base, head: ref })],
          ['compare diff', query('/api/repository/compare/diff', { base: f.base, head: ref, path })],
          ['compare base', query('/api/repository/compare', { base: ref, head: f.base })],
          ['compare diff base', query('/api/repository/compare/diff', { base: ref, head: f.base, path })],
        ]),
        ['forged history cursor', query('/api/repository/commits', { ref: 'main', cursor })],
        ['parent expression', query('/api/repository', { ref: `${f.tip}^`, path: 'past.txt' })],
        ...(phase === 'incoming' ? [['incoming ref', query('/api/repository', { ref: pushed.incoming, path: 'client.ts' })]] : []),
      ];
      for (const [name, path] of requests) {
        const response = await f.call(path), body = await response.text();
        observe({ phase, reader: name, target: path.includes(f.parent) || path.includes(encodeURIComponent(`${f.tip}^`)) ? 'parent' : 'tip', status: response.status, marker: body.includes(marker), secret: body.includes(secret) });
        expect.soft([403, 404], `${phase}: ${name} must authorize its selected revision`).toContain(response.status);
        expect.soft(body, `${phase}: ${name}`).not.toContain(marker);
        expect.soft(body, `${phase}: ${name}`).not.toContain(secret);
      }
      if (phase === 'incoming') await pushed.finish();
    } finally { await f.close(); }
  });

  it('refuses an earlier withheld revision after a clean replacement, including a file warmed by a member', async () => {
    const f = await fixture();
    try {
      const first = await f.beginPush();
      const path = query('/api/repository', { ref: f.tip, path: 'client.ts' });
      expect(await (await f.call(path, true)).json()).toMatchObject({ content: tipText });
      await first.finish();
      // This part does not assume Artifacts retains unreferenced objects: remove them for real.
      f.h.git.native(['prune', '--expire=now']);
      expect(await f.h.git.repository.readCommit(f.tip)).toBeNull();
      expect(await f.h.git.repository.readCommit(f.parent)).toBeNull();
      const clean = f.h.git.commitTree({ 'client.ts': 'export const safe = true;\n' }, f.base, 'Clean replacement');
      const next = await f.beginPush(clean); await next.finish();
      expect(next.change.id).toBe(first.change.id); expect(next.change.revision).toBe(2);
      expect(await (await f.call(`/api/changes/${first.change.id}/diff?path=client.ts&revision=1`)).json()).toMatchObject({ withheld: true });
      const result = await f.call(path);
      observe({ reader: 'member-warmed file after deletion and prune', status: result.status });
      expect.soft([403, 404]).toContain(result.status);
      expect.soft(await result.text()).not.toContain(secret);
      expect(await (await f.call(query('/api/repository', { ref: clean, path: 'client.ts' }))).json()).toMatchObject({ content: 'export const safe = true;\n' });
    } finally { await f.close(); }
  });

  it('keeps landed history, a side branch, lightweight and annotated tags, and an open clean pull request readable', async () => {
    const f = await fixture();
    try {
      const branch = f.h.git.commitTree({ 'branch.txt': 'published branch\n' }, f.base, 'Branch');
      f.h.git.native(['update-ref', 'refs/heads/feature', branch]);
      const tag = f.h.git.commitTree({ 'tag.txt': 'published tag\n' }, f.base, 'Tag');
      f.h.git.native(['update-ref', 'refs/tags/v1', tag]);
      f.h.git.native(['tag', '-a', 'v2', tag, '-m', 'Annotated tag']);
      const clean = f.h.git.commitTree({ 'clean.txt': 'open pull request\n' }, f.base, 'Clean PR');
      const pushed = await f.beginPush(clean, 'clean'); await pushed.finish();
      expect(await (await f.call(`/api/changes/${pushed.change.id}/diff?path=clean.txt`)).json()).toMatchObject({ after: 'open pull request\n' });
      for (const [ref, path, content] of [[f.base, 'README.md', '# Relay\n'], ['main', 'README.md', '# Relay\n'], ['feature', 'branch.txt', 'published branch\n'], [branch, 'branch.txt', 'published branch\n'], ['refs/tags/v1', 'tag.txt', 'published tag\n'], ['v2', 'tag.txt', 'published tag\n'], [tag, 'tag.txt', 'published tag\n'], [clean, 'clean.txt', 'open pull request\n']]) {
        const response = await f.call(query('/api/repository', { ref, path }));
        expect(response.status, ref).toBe(200); expect(await response.json(), ref).toMatchObject({ content });
      }
      const compared = await f.call(query('/api/repository/compare/diff', { base: f.base, head: clean, path: 'clean.txt' }));
      expect(compared.status).toBe(200); expect(await compared.json()).toMatchObject({ after: 'open pull request\n' });
    } finally { await f.close(); }
  });


  it('rejects duplicate selectors before readers can disagree about the selected hash', async () => {
    const f = await fixture();
    try {
      const pushed = await f.beginPush(); await pushed.finish();
      const response = await f.call(`/api/repository?path=client.ts&ref=${f.tip}&ref=`);
      expect.soft([400, 403, 404]).toContain(response.status);
      expect.soft(await response.text()).not.toContain(secret);
    } finally { await f.close(); }
  });

  it('keeps a previously public clean revision readable after a later secret revision', async () => {
    const f = await fixture();
    try {
      const clean = f.h.git.commitTree({ 'client.ts': 'clean earlier revision\n' }, f.base, 'Clean');
      const first = await f.beginPush(clean); await first.finish();
      const next = await f.beginPush(); await next.finish();
      expect(next.change.id).toBe(first.change.id);
      const response = await f.call(query('/api/repository', { ref: clean, path: 'client.ts' }));
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ content: 'clean earlier revision\n' });
    } finally { await f.close(); }
  });

  it('does not publish a clean replacement that still carries a withheld parent in its Git history', async () => {
    const f = await fixture();
    try {
      const first = await f.beginPush(); await first.finish();
      const clean = f.h.git.commitTree({ 'client.ts': 'export const safe = true;\n' }, f.tip, 'Clean tree with withheld ancestry');
      const next = await f.beginPush(clean); await next.finish();
      expect(await (await f.call(`/api/changes/${next.change.id}/diff?path=client.ts`)).json()).toMatchObject({ after: 'export const safe = true;\n' });
      const read = await f.call(query('/api/repository/commit/diff', { sha: clean, path: 'client.ts' }));
      observe({ reader: 'clean child diff', status: read.status });
      expect.soft([403, 404]).toContain(read.status); expect.soft(await read.text()).not.toContain(secret);
      const pack = await f.upload(clean, 2);
      expect.soft([403, 404]).toContain(pack.status);
    } finally { await f.close(); }
  });

  it('preserves a clean multi-commit pull request and its exclusive parents', async () => {
    const f = await fixture();
    try {
      const first = f.h.git.commitTree({ 'one.txt': 'public one\n' }, f.base, 'First');
      const second = f.h.git.commitTree({ 'two.txt': 'public two\n' }, first, 'Second');
      const pushed = await f.beginPush(second, 'multi'); await pushed.finish();
      for (const [ref, path] of [[first, 'one.txt'], [second, 'two.txt']]) {
        const read = await f.call(query('/api/repository', { ref, path }));
        expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ content: expect.stringContaining('public') });
      }
      const read = await f.call(query('/api/repository/commits', { ref: second }));
      expect(read.status).toBe(200); expect((await read.json() as { items: { hash: string }[] }).items.map((item: { hash: string }) => item.hash)).toEqual([second, first, f.base]);
      expect((await f.upload(second, 2)).status).toBe(200);
    } finally { await f.close(); }
  });

  it('preserves commits reachable through a published merge second parent', async () => {
    const f = await fixture();
    try {
      const side = f.h.git.commitTree({ 'side.txt': 'public side\n' }, f.base, 'Side');
      const tree = f.h.git.native(['rev-parse', `${f.base}^{tree}`]).trim();
      const merge = f.h.git.native(['commit-tree', tree, '-p', f.base, '-p', side], 'Published merge\n').trim();
      f.h.git.native(['update-ref', 'refs/heads/merged', merge]);
      const read = await f.call(query('/api/repository', { ref: side, path: 'side.txt' }));
      expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ content: 'public side\n' });
    } finally { await f.close(); }
  });

  it.each(['incoming', 'deleted'] as const)('rules out withheld content through main-only blame (%s)', async phase => {
    const f = await fixture();
    try {
      const pushed = await f.beginPush(); if (phase === 'deleted') await pushed.finish();
      for (const ref of [f.tip, f.parent, pushed.incoming]) {
        const response = await f.call(query('/api/blame', { ref, path: 'client.ts' }));
        expect(response.status).toBe(400); expect(await response.text()).toContain('Blame reads main');
      }
      // Unknown provenance does not open Git objects for anonymous callers.
      expect(await (await f.call(`/api/provenance?commits=${f.tip},${f.parent}`)).json()).toEqual([]);
      if (phase === 'incoming') await pushed.finish();
      expect(await f.h.git.repository.readCommit(f.tip)).not.toBeNull();
      expect(f.h.git.native(['show', `${f.parent}:past.txt`])).toBe(parentText);
    } finally { await f.close(); }
  });
});
