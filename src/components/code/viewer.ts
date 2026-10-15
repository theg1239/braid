import { lazyComponent } from '../../lib/lazy';

/*
 * The chunks that draw code: pierre.tsx, the viewer with its highlighter and worker pool, and
 * markdown.tsx, prose with its parser. Each loads the first time it shows. These handles are all
 * the shell carries of the code components, so a link can warm a chunk without loading the rest.
 */
const loadViewer = () => import('./pierre').then(async module => {
  await module.prepareViewer();
  return module;
});

const viewer = {
  diff: lazyComponent(loadViewer, (m) => m.Diff),
  source: lazyComponent(loadViewer, (m) => m.Source),
  conflict: lazyComponent(loadViewer, (m) => m.Conflict),
};
const markdown = lazyComponent(() => import('./markdown'), (m) => m.Markdown);

export const Diff = viewer.diff.Component;
export const Source = viewer.source.Component;
export const Conflict = viewer.conflict.Component;
export const Markdown = markdown.Component;

/** Warms the viewer's chunk, for links that lead to code. */
export function prefetchCode() {
  for (const part of Object.values(viewer)) void part.prefetch();
}

/** Warms the Markdown chunk, for links that lead to a README. */
export function prefetchMarkdown() {
  void markdown.prefetch();
}
