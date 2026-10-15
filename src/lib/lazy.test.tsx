import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { lazyComponent } from './lazy';

const Screen = () => <main>Styled screen</main>;
const Pending = () => <div aria-busy="true">Loading styles</div>;

describe('lazy screen readiness', () => {
  it('shares the pending import between prefetches and renders', async () => {
    let ready!: (module: { Screen: typeof Screen }) => void;
    const load = vi.fn(() => new Promise<{ Screen: typeof Screen }>(resolve => { ready = resolve; }));
    const { Component, prefetch } = lazyComponent(load, module => module.Screen, Pending);
    const pending = prefetch();
    expect(prefetch()).toBe(pending);
    expect(renderToStaticMarkup(<Component />)).toContain('Loading styles');
    expect(renderToStaticMarkup(<Component />)).not.toContain('Styled screen');
    ready({ Screen });
    await pending;
    expect(renderToStaticMarkup(<Component />)).toBe('<main>Styled screen</main>');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, Pending])('keeps a failed prefetch rejected on the first render (placeholder=%s)', async placeholder => {
    const error = new Error('Unable to preload CSS for /screen.css');
    // Vite remembers the failed stylesheet. A second import can return code with
    // no CSS; the failed promise must reach the error boundary instead.
    const load = vi.fn<() => Promise<{ Screen: typeof Screen }>>()
      .mockRejectedValueOnce(error).mockResolvedValue({ Screen });
    const { Component, prefetch } = lazyComponent(load, module => module.Screen, placeholder);
    const failed = prefetch();
    await expect(failed).rejects.toBe(error);
    expect(prefetch()).toBe(failed);
    await expect(prefetch()).rejects.toBe(error);
    expect(() => renderToStaticMarkup(<Component />)).toThrow(error);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
