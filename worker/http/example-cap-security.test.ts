import { expect, it, vi } from 'vitest';
import api from './api';
import { publicRepository } from '../test/public-repository';
import type { BraidEnv } from '../env';

it('allows exactly forty isolated writable examples and never upgrades the fallback marker', async () => {
  const f = await publicRepository();
  try {
    const keys: string[] = [];
    const work = vi.fn(async () => Response.json({ capabilities: { mode: 'demo' } }));
    f.env.WORKSPACES = { idFromName: (name: string) => { keys.push(name); return name; }, get: () => ({ fetch: work }) } as unknown as BraidEnv['WORKSPACES'];
    const call = (method: string, cookie = '') => api.fetch(new Request(`https://braid.example/api/${method === 'GET' ? 'state' : 'context'}`, {
      method, headers: { origin: 'https://braid.example', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.37', 'x-braid-workspace': 'demo', cookie },
      ...(method === 'GET' ? {} : { body: '{"text":"fixture"}' }),
    }), f.env);
    const first = await Promise.all(Array.from({ length: 40 }, () => call('POST')));
    expect(first.map(response => response.status)).toEqual(Array(40).fill(200));
    expect(new Set(keys).size).toBe(40);
    const cookies = first.map(response => response.headers.get('set-cookie')!.split(';')[0]);
    expect(new Set(cookies).size).toBe(40);
    const sessions = vi.spyOn(f.security, 'exampleSession');
    const refused = await call('POST');
    expect(refused.status).toBe(429);
    const marker = refused.headers.get('set-cookie')!.split(';')[0];
    expect(marker.startsWith('braid-demo-shared=')).toBe(true);
    expect((await call('POST', marker)).status).toBe(429);
    expect(sessions).toHaveBeenCalledTimes(1);
    const read = await call('GET', marker);
    expect(await read.json()).toMatchObject({ capabilities: { canWrite: false } });
    expect(keys.at(-1)).toMatch(/^demo:shared:/);
    expect((await call('POST', marker.replace('braid-demo-shared=', 'braid-demo='))).status).toBe(429);
    // An existing private example remains writable; it does not consume a new slot.
    expect((await call('POST', cookies[0])).status).toBe(200);
    expect(keys.at(-1)).not.toMatch(/^demo:shared:/);
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); await f.close(); }
});
