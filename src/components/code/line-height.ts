import { useSyncExternalStore } from 'react';

const PHONE = '(max-width: 767px)';
function subscribe(listener: () => void) {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** The source gutter is a link on every line; its virtual geometry follows the phone hit area. */
export function useSourceLineHeight() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches ? 32 : 20, () => 20);
}
