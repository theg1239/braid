/*
 * Focus after a task write. "Use this version" and "Merge into main" take themselves away when they succeed, which
 * drops keyboard focus on the body; the outcome that replaces them takes focus instead, so the next Tab continues
 * from there and a screen reader hears where the task stands.
 */
import { useEffect, useRef } from 'react';

/** The write an outcome answers: a choice leads to the next question or the merge; a merge leads to the pull request. */
type Write = 'choice' | 'merge';

const WINDOW_MS = 10_000;
let pending: Write | null = null;
let since = 0;

/** A write succeeded: the first outcome of its kind rendered while focus lies on the body takes it. */
export function expectOutcome(after: Write, now = Date.now()) {
  pending = after;
  since = now;
}

/** Once, within ten seconds of the write, and only when focus was lost; a person who has moved on keeps their place. */
export function outcomeTakesFocus(after: Write, focusOnBody: boolean, now = Date.now()): boolean {
  if (pending !== after || !focusOnBody || now - since > WINDOW_MS) return false;
  pending = null;
  return true;
}

export function useOutcomeFocus<T extends HTMLElement>(after: Write) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (ref.current && outcomeTakesFocus(after, document.activeElement === document.body)) ref.current.focus();
  });
  return ref;
}
