import { useKumoToastManager } from '@cloudflare/kumo';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { changes } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { navigate, paths } from '../../lib/router';
import { EXAMPLE_REASON, EXAMPLE_REVERT, liveBlocker } from '../../store/workspace';

/** Why a merged pull request cannot be reverted by this viewer, or null when it can. */
export function revertBlocker(snapshot: WorkspaceSnapshot): string | null {
  const blocker = liveBlocker(snapshot);
  return blocker === EXAMPLE_REASON ? EXAMPLE_REVERT : blocker;
}

/**
 * Opens the pull request that reverts a merged one and goes to it. A failure is thrown for the
 * confirmation dialog, which keeps it on screen.
 */
export function useRevert(): (merged: { id: string; number: number }) => Promise<void> {
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  return async (merged) => {
    const key = attempt.key(['revert', merged.id]);
    try {
      const created = await changes.revert(merged.id, key);
      attempt.settle();
      toasts.add({ title: 'Revert opened', description: `#${created.number} reverts #${merged.number}.`, variant: 'success' });
      refreshLive('changes');
      navigate(paths.pull(created.number));
    } catch (err) {
      attempt.settle(err);
      throw err;
    }
  };
}
