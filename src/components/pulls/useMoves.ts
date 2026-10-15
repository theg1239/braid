import { useCallback, useEffect, useState } from 'react';
import type { Change } from '../../../shared/types';
import { readChangeDiff } from '../../lib/resources';
import type { MoveFile, MovedBlock } from '../code/moves';

/** Reads at most 80 files after the first diff paints, sharing normal reads; matching stays in a lazy worker. */
export function useMoves(change: Change, files: readonly { path: string }[], since?: number) {
  const key = `${change.id}:${change.revision}:${since ?? ''}`;
  const [painted, setPainted] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; moves: MovedBlock[] } | null>(null);
  const onReady = useCallback(() => setPainted(key), [key]);
  useEffect(() => {
    if (painted !== key) return;
    let cancelled = false;
    const run = async () => {
      const input: MoveFile[] = [];
      let cursor = 0, characters = 0;
      const read = async () => {
        while (!cancelled && cursor < Math.min(files.length, 80) && characters < 2_000_000) {
          const file = files[cursor++];
          try {
            const diff = await readChangeDiff(change.id, change.revision, file.path, since);
            if (cancelled || diff.binary || diff.withheld || diff.revision !== change.revision) continue;
            characters += (diff.before?.length ?? 0) + (diff.after?.length ?? 0);
            if (characters <= 2_000_000) input.push({ path: file.path, before: diff.before, after: diff.after });
          } catch { /* A failed optional read leaves the normal file's retry control in charge. */ }
        }
      };
      await Promise.all([read(), read()]);
      if (cancelled) return;
      const { analyzeMoves } = await import('../code/analysis-client');
      const moves = await analyzeMoves(input.sort((a, b) => a.path.localeCompare(b.path)));
      if (!cancelled && moves) setResult({ key, moves });
    };
    void run();
    return () => { cancelled = true; };
  }, [key, painted, files, change.id, change.revision, since]);
  return { moves: result?.key === key ? result.moves : undefined, onReady };
}
