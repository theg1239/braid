import { use, useEffect, useState, type ComponentType } from 'react';

type Tracked<T> = Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown };

/**
 * A component from a chunk that loads on demand, like React.lazy, with one difference: a chunk
 * that was prefetched renders on the first try. React.lazy always suspends once, and React then
 * holds the fallback for a moment to avoid flicker, so a prefetched screen still appeared late.
 * Here the loading promise carries its own status, which `use` reads synchronously. `prefetch`
 * starts the same load; a failure is kept for rendering to show, so a prefetch need not handle it.
 */
export function lazyComponent<M, P extends object>(load: () => Promise<M>, pick: (module: M) => ComponentType<P>, Pending?: ComponentType): { Component: ComponentType<P>; prefetch: () => Promise<M> } {
  let promise: Tracked<M> | null = null;
  const start = (): Tracked<M> => {
    if (!promise) {
      const tracked: Tracked<M> = load();
      tracked.status = 'pending';
      tracked.then(
        (value) => {
          tracked.status = 'fulfilled';
          tracked.value = value;
        },
        (reason: unknown) => {
          tracked.status = 'rejected';
          tracked.reason = reason;
          // Keep failures for the error boundary's Reload. Retrying a Vite import
          // can skip CSS it has already marked as seen, even when that CSS failed.
        },
      );
      promise = tracked;
    }
    return promise;
  };
  function Component(props: P) {
    // React reads the status the promise carries; the type of `use` only knows plain promises.
    const Loaded = pick(use(start() as Promise<M>));
    return <Loaded {...props} />;
  }
  /** Screens own a stable skeleton, so resolving their chunk need not wait on another boundary's fallback timer. */
  function WithPlaceholder(props: P) {
    const [read] = useState(start);
    const [, redraw] = useState(false);
    useEffect(() => {
      const settled = () => redraw(true);
      read.then(settled, settled);
    }, [read]);
    if (read.status === 'pending') return Pending ? <Pending /> : null;
    const Loaded = pick(use(read as Promise<M>));
    return <Loaded {...props} />;
  }
  return { Component: Pending ? WithPlaceholder : Component, prefetch: start };
}
