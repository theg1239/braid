import type { ReactNode } from 'react';

interface DiffAnnotation {
  side: 'deletions' | 'additions';
  lineNumber: number;
  metadata: ReactNode;
}

export interface DiffComments {
  annotations?: DiffAnnotation[];
  onAddComment?: (line: number, side: DiffAnnotation['side'], restoreFocus: () => void) => void;
}
