import type { MoveEnd, MovedBlock } from './moves';

export interface DiffReview {
  hunks?: readonly number[];
  moves?: readonly MovedBlock[];
  onMove?: (target: MoveEnd) => void;
  moveTarget?: MoveEnd | null;
  onReady?: () => void;
}

export function contextRowHeight(path: string): number {
  return ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css'].includes(path.split('.').at(-1)?.toLowerCase() ?? '') ? 28 : 0;
}
