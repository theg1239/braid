/*
 * Opens the command menu from anywhere, as GitHub's `t` opens its file finder. The shell owns
 * the menu; screens ask for it through here, so none of them has to reach the shell's state.
 */

export type PaletteScope = 'all' | 'files';

type Listener = (scope: PaletteScope) => void;
const listeners = new Set<Listener>();
let opener: HTMLElement | null = null;

export function openPalette(scope: PaletteScope = 'all') {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  for (const listener of listeners) listener(scope);
}

/** What had focus when the menu was asked to open; the menu hands focus back to it when it closes in place. */
export function paletteOpener(): HTMLElement | null {
  return opener;
}

export function onOpenPalette(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
