import { afterEach, expect, it, vi } from 'vitest';
import api from './api';
import { servePage } from './social';
import { publicRepository } from '../test/public-repository';
import type { BraidEnv } from '../env';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Fixed HTML shell: capture exactly the tags the page handler appends. Attribute escaping
// is covered separately in social.test.ts; this fixture exercises gateway visibility.
function rewriter() {
  vi.stubGlobal('HTMLRewriter', class {
    appended = '';
    on(_selector: string, handler: { element(head: { append(text: string): void }): void }) {
      handler.element({ append: text => { this.appended += text; } }); return this;
    }
    transform(response: Response) { return new Response(`<html><head>${this.appended}</head></html>`, response); }
  });
}

it('does not unfurl private or unknown repository names and file paths to a signed-out crawler', async () => {
  const f = await publicRepository(); rewriter();
  try {
    f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
    f.env.ASSETS = { fetch: async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html', etag: 'shared-shell', 'cache-control': 'public, max-age=600' } }) } as unknown as Fetcher;
    const address = `/${f.team.slug}/${f.team.workspaces[0].slug}`;
    for (const path of [address, `${address}/blob/main/confidential-plan.md`, '/unknown/private/blob/main/payroll.csv']) {
      const response = await api.fetch(new Request(`https://braid.example${path}`), f.env);
      const text = await response.text();
      expect.soft(response.status).toBe(200);
      expect.soft(text).not.toContain(f.team.slug);
      expect.soft(text).not.toMatch(/confidential-plan|payroll|unknown\/private/);
      expect.soft(text).toContain('property="og:title" content="Braid');
      expect.soft(response.headers.get('cache-control')).toBe('no-store');
    }
  } finally { await f.close(); }
});

it('titles only public repository URLs and rechecks visibility without accepting caller identity', async () => {
  const f = await publicRepository(); rewriter();
  try {
    f.env.ASSETS = { fetch: async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html', etag: 'shared-shell' } }) } as unknown as Fetcher;
    const path = `/${f.team.slug}/${f.team.workspaces[0].slug}/blob/main/README.md`;
    const request = () => new Request(`https://braid.example${path}?token=do-not-unfurl`, { headers: { 'if-none-match': 'shared-shell', 'x-braid-public': 'true', 'x-braid-role': 'owner' } });
    const published = await api.fetch(request(), f.env);
    expect(await published.text()).toContain(`README.md · ${f.team.slug}/${f.team.workspaces[0].slug}`);
    expect(published.headers.has('etag')).toBe(false);
    f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
    const hidden = await api.fetch(request(), f.env);
    expect.soft(await hidden.text()).not.toMatch(/README\.md|do-not-unfurl/);
    expect.soft(hidden.headers.has('etag')).toBe(false);
  } finally { await f.close(); }
});

it('keeps the generic preview when the visibility lookup fails, and logs only what failed', async () => {
  rewriter();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = Object.assign(new Error('lookup of acme/secret-plan failed'), { code: 'OVERLOADED' });
  const env = { ASSETS: { fetch: async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }) },
    DIRECTORY: { idFromName: (name: string) => name, get: () => ({ resolveRepository: async () => { throw failure; } }) } } as unknown as BraidEnv;
  const page = await servePage(new Request('https://braid.example/acme/secret-plan/blob/main/plan.md'), env);
  expect(await page.text()).not.toMatch(/secret-plan|plan\.md/);
  expect(warn.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([{ event: 'social_preview_failed', error: 'Error', code: 'OVERLOADED' }]);
});
