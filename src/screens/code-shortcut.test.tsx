import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeSearch } from '../components/code/CodeSearch';

const state = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], focus: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: (effect: () => void | (() => void)) => state.effects.push(effect), useRef: () => ({ current: { focus: state.focus } }) }));
vi.mock('../lib/router', () => ({ navigate: vi.fn(), paths: { search: () => '/search' } }));
class Target {
  constructor(private editing: boolean) {}
  closest() { return this.editing ? this : null; }
}
const addEventListener = vi.fn(), removeEventListener = vi.fn();
beforeEach(() => {
  state.effects = []; state.focus.mockClear(); addEventListener.mockClear(); removeEventListener.mockClear();
  vi.stubGlobal('Element', Target);
  vi.stubGlobal('window', { addEventListener, removeEventListener });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Code slash shortcut', () => {
  function mount() {
    renderToStaticMarkup(<CodeSearch gitRef="feature/search" />);
    const cleanups = state.effects.map(effect => effect());
    const listener = addEventListener.mock.calls.find(([name]) => name === 'keydown')![1] as (event: KeyboardEvent) => void;
    return { listener, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
  }
  it('focuses repository search from a non-editing target and unregisters on navigation', () => {
    const { listener, unmount } = mount(), preventDefault = vi.fn();
    listener({ key: '/', target: new Target(false), preventDefault } as unknown as KeyboardEvent);
    expect(state.focus).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('keydown', listener);
  });
  it.each([{ key: 'x' }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { defaultPrevented: true }, { target: new Target(true) }])('does not steal focus for %j', input => {
    const { listener } = mount(), preventDefault = vi.fn();
    listener({ key: '/', target: new Target(false), preventDefault, ...input } as unknown as KeyboardEvent);
    expect(state.focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
