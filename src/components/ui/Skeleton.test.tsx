import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingRegion } from './Skeleton';

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], setWaiting: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect), useState: () => [false, hooks.setWaiting] }));

beforeEach(() => { hooks.effects = []; hooks.setWaiting.mockClear(); vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('slow reads', () => {
  it('keeps the region accessible without adding visible loading words or a spinner', () => {
    const html = renderToStaticMarkup(<LoadingRegion><span>Content placeholder</span></LoadingRegion>);
    hooks.effects.forEach(effect => effect());
    expect(html).toContain('Content placeholder');
    expect(html).not.toContain('Still loading');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/<svg[^>]*role="status"/);
    vi.advanceTimersByTime(15_000);
    expect(hooks.setWaiting).not.toHaveBeenCalled();
  });
  it('cancels the announcement when the read finishes or the user changes pages', () => {
    renderToStaticMarkup(<LoadingRegion><span /></LoadingRegion>);
    hooks.effects.forEach(effect => effect()?.());
    vi.advanceTimersByTime(9_000);
    expect(hooks.setWaiting).not.toHaveBeenCalled();
  });
  it('keeps nested reads quiet too', () => {
    renderToStaticMarkup(<LoadingRegion><LoadingRegion><span /></LoadingRegion></LoadingRegion>);
    hooks.effects.forEach(effect => effect());
    vi.advanceTimersByTime(8_000);
    expect(hooks.setWaiting).not.toHaveBeenCalled();
  });
});
