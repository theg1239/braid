import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';

/*
 * The landing's background artwork: one folder under ./art per candidate, each a default-exported component that
 * fixes itself behind the page. `?art=<folder>` previews a candidate; CHOSEN is the one the page shows. It mounts
 * once the browser is idle after the hero paints, so the artwork never delays the first view.
 */
const loaders = import.meta.glob<{ default: ComponentType }>('./art/*/index.tsx');
const CHOSEN = 'descent';
const components = new Map<string, LazyExoticComponent<ComponentType>>();

export function LandingArt() {
  const [Art, setArt] = useState<LazyExoticComponent<ComponentType> | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('art') ?? CHOSEN;
    const load = loaders[`./art/${id}/index.tsx`];
    if (!load) return;
    const show = () => {
      if (!components.has(id)) components.set(id, lazy(load));
      setArt(() => components.get(id)!);
    };
    if ('requestIdleCallback' in window) {
      const handle = requestIdleCallback(show, { timeout: 1500 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(show, 300);
    return () => clearTimeout(timer);
  }, []);
  return Art ? <Suspense fallback={null}><Art /></Suspense> : null;
}
