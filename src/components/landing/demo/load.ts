/** A view of the demo: a file in Code, a pull request, the list or the merge queue, the fleet or the task, or the rules. */
export type DemoView =
  | { tab: 'code'; file?: string }
  | { tab: 'pulls'; pull?: number; checks?: boolean; queue?: boolean }
  | { tab: 'agents'; task?: boolean }
  | { tab: 'settings' };

/** The demo's views and their rows, fetched once: on the first idle moment after the page paints, or on first use. */
let views: Promise<typeof import('./Views')> | undefined;
export const loadViews = () => (views ??= import('./Views'));
