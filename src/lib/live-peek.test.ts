import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('reads already loaded data without starting requests or retaining another repository’s answer', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => {} });
  const { peekLive, primeLive } = await import('./live');
  const { resetWorkspaceCaches } = await import('./api');
  const read = vi.fn(async () => ({ title: 'Retry deliveries' }));
  expect(peekLive('suggestion-data')).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  primeLive('suggestion-data', read, 60_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(peekLive('suggestion-data')).toEqual({ title: 'Retry deliveries' });
  for (let i = 0; i < 10; i++) peekLive('suggestion-data');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(1);
  resetWorkspaceCaches();
  expect(peekLive('suggestion-data')).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
});
