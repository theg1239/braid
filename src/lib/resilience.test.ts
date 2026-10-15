import { afterEach, expect, it, vi } from 'vitest';
import { EXAMPLE_SESSION_LIMIT } from '../../shared/errors';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['12', 'Tue, 13 Oct 2026 12:00:12 GMT'])('honours Retry-After %s for reads and writes, across endpoints', async after => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': after } })).mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  const { request, ApiError } = await import('./api');
  const error = await request('/api/repository/commits').catch(e => e);
  if (!(error instanceof ApiError)) throw new Error('Expected a rate-limit failure');
  expect(error).toMatchObject({ status: 429, retryAt: Date.now() + 12_000 });
  expect(error.message).toMatch(/^Too many requests\. Try again after /);
  expect(error.message).not.toContain('429');
  await expect(request('/api/changes/1/approve', { method: 'POST' })).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(11_999);
  await expect(request('/api/queue')).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(request('/api/queue')).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('explains the example cap, disables writes through its event, and leaves reads available', async () => {
  const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: 'example_session_limit', error: EXAMPLE_SESSION_LIMIT }, { status: 429, headers: { 'Retry-After': '3600' } })).mockResolvedValue(Response.json({ readable: true }));
  vi.stubGlobal('fetch', fetch);
  const { request, retryDelay } = await import('./api');
  await expect(request('/api/missions/task/merge', { method: 'POST' })).rejects.toMatchObject({ status: 429, message: EXAMPLE_SESSION_LIMIT });
  expect(dispatchEvent.mock.calls[0][0].type).toBe('braid:example-readonly');
  expect(retryDelay()).toBe(0);
  await expect(request('/api/state')).resolves.toEqual({ readable: true });
});

it('treats a 429 without the example code as a rate limit, whatever its text says', async () => {
  const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'The recorded example is read-only on this network until tomorrow.' }, { status: 429, headers: { 'Retry-After': '30' } })));
  const { request } = await import('./api');
  await expect(request('/api/missions/task/merge', { method: 'POST' })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/^Too many requests\. Try again after /) });
  expect(dispatchEvent).not.toHaveBeenCalled();
});

it.each(['headers', 'body', 'early-state'])('bounds stalled %s reads and permits another attempt', async stalled => {
  vi.useFakeTimers();
  const never = new Promise<Response>(() => {});
  const fetch = vi.fn().mockImplementationOnce(() => stalled === 'body' ? Promise.resolve({ ok: true, text: () => never }) : never).mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  const { request, api } = await import('./api');
  if (stalled === 'early-state') vi.stubGlobal('window', { __braidEarly: { reads: { ' /api/state': never } } });
  const attempt = stalled === 'early-state' ? api.state() : request('/api/repository');
  const failed = expect(attempt).rejects.toMatchObject({ status: 0, message: 'The request timed out. Try again.' });
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  if (stalled !== 'early-state') {
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(request('/api/repository')).resolves.toEqual({ ok: true });
  }
});

it('does not expose gateway status codes or pages', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Bad Gateway</h1>', { status: 502 })));
  const { request } = await import('./api');
  await expect(request('/api/state')).rejects.toMatchObject({ status: 502, message: 'Something went wrong. Try again.' });
});
