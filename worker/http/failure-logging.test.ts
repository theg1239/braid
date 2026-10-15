import { afterEach, expect, it, vi } from 'vitest';
import api from './api';
import { edgeCache } from '../test/edge-cache';
import type { BraidEnv } from '../env';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps a gateway failure diagnosable without recording upstream credentials', async () => {
  edgeCache();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const env = {
    AUTH_MODE: 'owner-key', LIVE_ENABLED: 'false',
    IP_LIMITER: { limit: async () => ({ success: true }) }, ANONYMOUS_LIMITER: { limit: async () => ({ success: true }) },
    SECURITY: { idFromName: () => 'security', get: () => ({}) },
    WORKSPACES: { idFromName: (name: string) => name, get: () => ({ fetch: async () => { throw Object.assign(new Error('https://secret:password@upstream.test'), { code: 'UPSTREAM_UNAVAILABLE' }); } }) },
  } as unknown as BraidEnv;
  const response = await api.fetch(new Request('https://braid.test/api/state'), env);
  expect(response.status).toBe(500);
  const logs = warn.mock.calls.map(([line]) => JSON.parse(line));
  expect(logs).toContainEqual(expect.objectContaining({ event: 'request_failed', error: 'Error', code: 'UPSTREAM_UNAVAILABLE', status: 500, requestId: expect.any(String) }));
  expect(JSON.stringify(logs)).not.toContain('password'); expect(await response.text()).not.toContain('password');
});
