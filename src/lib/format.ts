export function shortHash(hash: string | undefined | null, length = 7): string {
  if (!hash) return '';
  return hash.slice(0, length);
}

export function relativeTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function absoluteTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function possessive(name: string): string {
  return `${name}'s`;
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index + 1);
}

/** Bytes as people read them, for a size next to a line count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A download name that keeps the extension: `app.before.ts` for `src/app.ts` tagged `before`. */
export function taggedFilename(path: string, tag: string): string {
  const name = basename(path);
  const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'copy';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}.${safe}${name.slice(dot)}` : `${name}.${safe}`;
}

export function isModifierKey(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The command palette's shortcut as this platform writes it, and as `aria-keyshortcuts` names it. */
export const PALETTE_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? { label: '⌘K', aria: 'Meta+K' } : { label: 'Ctrl K', aria: 'Control+K' };
