import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VisibilityControl } from './Visibility';

const state = vi.hoisted(() => ({ open: false, button: null as null | { onClick(): void; disabled: boolean }, dialog: null as null | { open: boolean; onConfirm(): Promise<void>; onClose(): void } }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useState: () => [state.open, (open: boolean) => { state.open = open; }] }));
vi.mock('@cloudflare/kumo', () => ({ Button: (props: { children: string; onClick(): void; disabled: boolean }) => { state.button = props; return <button disabled={props.disabled}>{props.children}</button>; } }));
vi.mock('../ui/ConfirmDialog', () => ({ ConfirmDialog: (props: { open: boolean; description: string; confirmLabel: string; onConfirm(): Promise<void>; onClose(): void }) => {
  state.dialog = props;
  return props.open ? <div role="alertdialog">{props.description}<button>{props.confirmLabel}</button><button>Cancel</button></div> : null;
} }));
beforeEach(() => { state.open = false; });

describe('repository visibility confirmation', () => {
  it.each([
    ['private', 'public', 'Anyone on the internet will be able to see this repository and its history.'],
    ['public', 'private', 'Only collaborators will be able to see this repository.'],
  ] as const)('confirms changing %s to %s and cancels without a write', async (value, next, reason) => {
    const change = vi.fn(async () => {});
    const render = () => renderToStaticMarkup(<VisibilityControl value={value} busy={false} change={change} />);
    expect(render()).toContain(`Make ${next}`);
    state.button!.onClick();
    expect(change).not.toHaveBeenCalled();
    expect(render()).toContain(reason);
    state.dialog!.onClose(); render();
    expect(state.dialog!.open).toBe(false);
    expect(change).not.toHaveBeenCalled();
    state.button!.onClick(); render();
    await state.dialog!.onConfirm();
    expect(change).toHaveBeenCalledExactlyOnceWith(next);
  });
  it('disables visibility changes during a request', () => {
    renderToStaticMarkup(<VisibilityControl value="public" busy change={vi.fn()} />);
    expect(state.button!.disabled).toBe(true);
  });
});
