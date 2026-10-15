/*
 * This browser's storage. Private modes and full quotas refuse it, and a refusal is never worth
 * showing: a refused read is no stored value, and a refused write keeps the value for this page.
 */

type Area = 'localStorage' | 'sessionStorage';

export function readStored(area: Area, key: string): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return null;
  }
}

/** A stored JSON list. One this version cannot read is no list. */
export function readStoredList<T>(key: string): T[] {
  const stored = readStored('localStorage', key);
  if (!stored) return [];
  try {
    return JSON.parse(stored) as T[];
  } catch {
    return [];
  }
}

/** Stores a value, or with null forgets it. */
export function writeStored(area: Area, key: string, value: string | null) {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch {
    // Refused: the value lasts as long as the page.
  }
}
