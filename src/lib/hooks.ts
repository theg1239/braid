import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKumoToastManager } from '@cloudflare/kumo';
import { newIdempotencyKey, outcomeUnknown } from './api';

interface IdempotencyKeys {
  /** The key for this request. It stays the same while the request is unchanged and unsettled. */
  key: (request: unknown) => string;
  /** Call with no argument after success, or with the error after a failure. */
  settle: (error?: unknown) => void;
}

/**
 * One Idempotency-Key per attempted write. A retry of the same request reuses its key, so a
 * write whose answer was lost cannot apply twice. Editing the request, a success, or a
 * definite refusal starts a new attempt with a new key.
 */
export function useIdempotencyKey(): IdempotencyKeys {
  const attempt = useRef<{ request: string; key: string } | null>(null);
  return useMemo(
    () => ({
      key: (request) => {
        const signature = JSON.stringify(request);
        if (attempt.current?.request !== signature) attempt.current = { request: signature, key: newIdempotencyKey() };
        return attempt.current.key;
      },
      settle: (error) => {
        if (error === undefined || !outcomeUnknown(error)) attempt.current = null;
      },
    }),
    [],
  );
}

/** Observes the width of an element. Returns a ref callback and the latest width. */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

/** Re-renders on an interval so relative times stay fresh. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Copies text and remembers which key was copied for a moment, for inline confirmation. When the
 * browser refuses, a toast says so and holds the text to copy by hand, unless it is on screen already.
 */
export function useCopy(): [copied: string | null, copy: (text: string, key?: string, onScreen?: boolean) => Promise<boolean>] {
  const toasts = useKumoToastManager();
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const copy = useCallback(async (text: string, key = text, onScreen = false) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toasts.add({ title: 'Copy failed', description: onScreen ? undefined : text, variant: 'error' });
      return false;
    }
    setCopied(key);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1600);
    return true;
  }, [toasts]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return [copied, copy];
}

export function downloadText(filename: string, text: string, type = 'text/markdown') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

/** Saves a response body exactly as the server sent it. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
