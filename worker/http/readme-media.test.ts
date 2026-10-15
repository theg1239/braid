import { expect, it, vi } from 'vitest';
import api from './api';
import { publicRepository } from '../test/public-repository';
import { digest, sessionToken } from './auth';
import { PUBLIC_READ_TTL } from './public-access';

it("names the repository in the address only for a README's media, which an <img> loads without headers", async () => {
  const f = await publicRepository();
  try {
    const read = (query: string) => api.fetch(new Request(`https://braid.example/api/repository?${query}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } }), f.env);
    // Routed to the public repository `w` (this fixture's repository object answers {}).
    expect((await read('workspace=w&path=docs/logo.svg&media=1')).status).toBe(200);
    // Any other read still names its repository in a header.
    expect((await read('workspace=w&path=docs/logo.svg')).status).toBe(401);
    expect((await read('workspace=w&path=docs/logo.svg&download=1')).status).toBe(401);
  } finally { await f.close(); }
});

it('does not cache repository media past a visibility or access change', async () => {
  const f = await publicRepository();
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    Object.assign(f.env.WORKSPACES, { get: () => ({ fetch: async () => new Response(svg, { headers: {
      'content-type': 'image/svg+xml', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    } }) }) });
    const path = `/api/repository?workspace=w&ref=${f.base}&path=logo.svg&media=1`;
    const read = (cookie?: string) => api.fetch(new Request(`https://braid.example${path}`, { headers: cookie ? { cookie } : {} }), f.env);
    const publicImage = await read();
    expect(publicImage.status).toBe(200);
    expect(await publicImage.text()).toBe(svg);
    expect(publicImage.headers.get('cache-control')).toBe('private, no-store');
    expect(publicImage.headers.get('content-security-policy')).toContain('sandbox');
    f.directory.updateWorkspace(f.alice.id, { teamId: 't', workspaceId: 'w', visibility: 'private' });
    const afterLease = Date.now() + PUBLIC_READ_TTL + 1;
    vi.spyOn(Date, 'now').mockReturnValue(afterLease);
    expect((await read()).status).toBe(404);
    const token = await sessionToken(f.env.SESSION_SECRET);
    await f.security.issue(await digest(token), Date.now() + 60_000, f.alice);
    const privateImage = await read(`__Host-braid-session=${token}`);
    expect(privateImage.status).toBe(200);
    expect(privateImage.headers.get('cache-control')).toBe('private, no-store');
  } finally { vi.restoreAllMocks(); await f.close(); }
});
