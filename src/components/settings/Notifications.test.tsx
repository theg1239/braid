import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotificationKind, NotificationPreferences } from '../../../shared/account';
import { Notifications } from './Notifications';
import { request } from '../../lib/api';
import { setLive, useLive } from '../../lib/live';

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, switches: new Map<string, { checked: boolean; disabled: boolean; onCheckedChange(value: boolean): void }>() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => {
  const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial;
  return [state.values[index], (value: unknown) => { state.values[index] = value; }];
} }));
vi.mock('../../lib/live', () => ({ useLive: vi.fn(), setLive: vi.fn() }));
vi.mock('../../lib/api', () => ({ request: vi.fn(), errorMessage: (error: Error) => error.message }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), Switch: (props: { 'aria-labelledby': string; checked: boolean; disabled: boolean; onCheckedChange(value: boolean): void }) => {
  state.switches.set(props['aria-labelledby'], props);
  return <button role="switch" aria-labelledby={props['aria-labelledby']} aria-checked={props.checked} disabled={props.disabled} />;
} }));

const live = (data: NotificationPreferences | null, error: string | null = null) => ({ data, error, loading: !data && !error, refreshing: false, errorStatus: null, updatedAt: null, refresh: vi.fn() });
const render = () => { state.cursor = 0; state.switches.clear(); return renderToStaticMarkup(<Notifications userId="person-1" />); };
beforeEach(() => {
  state.values = []; vi.clearAllMocks();
  vi.mocked(useLive).mockReturnValue(live({ attention: true, returned: true }));
});

describe('account notification toggles', () => {
  it('renders two named, checked switches with no email address or explanatory paragraph', async () => {
    const html = render();
    expect(html).toContain('Email me when a pull request needs me');
    expect(html).toContain('Email me when my agents’ pull requests are sent back');
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/@|<p/);
    expect(useLive).toHaveBeenCalledWith('notifications:person-1', expect.any(Function), 60_000);
    const read = vi.mocked(useLive).mock.calls[0][1]; await read();
    expect(request).toHaveBeenCalledWith('/api/notifications');
  });

  it.each(['attention', 'returned'] as NotificationKind[])('saves only the %s preference and reflects the server’s saved value', async kind => {
    const preferences = { attention: true, returned: true, [kind]: false };
    vi.mocked(request).mockResolvedValue(preferences);
    render(); state.switches.get(`notify-${kind}`)!.onCheckedChange(false);
    await vi.waitFor(() => expect(setLive).toHaveBeenCalledWith('notifications:person-1', preferences));
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/notifications', { method: 'PATCH', body: JSON.stringify({ [kind]: false }) });
    vi.mocked(useLive).mockReturnValue(live(preferences)); render();
    expect(state.switches.get(`notify-${kind}`)!.checked).toBe(false);
    expect(state.switches.get(`notify-${kind === 'attention' ? 'returned' : 'attention'}`)!.checked).toBe(true);
  });

  it('disables both switches while saving and leaves saved preferences intact on failure', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(request).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    render(); state.switches.get('notify-attention')!.onCheckedChange(false);
    render(); expect([...state.switches.values()].every(control => control.disabled)).toBe(true);
    fail(new Error('Could not save notifications.'));
    await vi.waitFor(() => expect(state.values[0]).toBeNull());
    const html = render();
    expect(html).toContain('role="alert"'); expect(html).toContain('Could not save notifications.');
    expect(state.switches.get('notify-attention')!.checked).toBe(true);
    expect(state.switches.get('notify-attention')!.disabled).toBe(false);
    expect(setLive).not.toHaveBeenCalled();
  });

  it('loads preferences before offering controls and offers retry after a failed read', () => {
    vi.mocked(useLive).mockReturnValue(live(null));
    const pending = render();
    expect(pending).toContain('aria-label="Loading notifications"'); expect(state.switches.size).toBe(0);
    expect(pending).not.toContain('>Loading notifications<');
    expect(pending).toContain('Email me when a pull request needs me');
    expect(pending).toContain('Email me when my agents’ pull requests are sent back');
    expect(pending.match(/class="srow srow--compact"/g)).toHaveLength(2);
    expect(pending.match(/class="srow__control"/g)).toHaveLength(2);
    vi.mocked(useLive).mockReturnValue(live({ attention: true, returned: false }));
    const ready = render();
    expect(ready.match(/class="srow srow--compact"/g)).toHaveLength(2);
    expect(ready).not.toContain('skeleton-line');
    vi.mocked(useLive).mockReturnValue(live(null, 'Could not load notifications.'));
    const html = render(); expect(html).toContain('Try again'); expect(html).toContain('Could not load notifications.');
    expect(state.switches.size).toBe(0);
  });
});
