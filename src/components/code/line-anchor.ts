import { useSyncExternalStore } from 'react';
import { useRoute } from '../../lib/router';

export function lineFromHash(hash: string): number | null {
  const match = /^#L([1-9]\d*)$/.exec(hash);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) ? line : null;
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function useLineAnchor(): number | null {
  const route = useRoute();
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => route.hash);
  return lineFromHash(hash);
}

export function scrollToSourceLine(node: HTMLElement, top: number) {
  window.scrollTo({ top: Math.max(0, window.scrollY + node.getBoundingClientRect().top + top - window.innerHeight / 3), behavior: 'instant' });
}
