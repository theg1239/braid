import { useState } from 'react';
import { Button, useKumoToastManager } from '@cloudflare/kumo';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { changes, errorMessage } from '../../lib/api';
import { setLive } from '../../lib/live';
import { liveBlocker, useSnapshot } from '../../store/workspace';

/** Pauses or resumes merging for an owner; null while the viewer cannot write. */
export function useLandingToggle(): { busy: boolean; toggle: (enabled: boolean) => Promise<void> } | null {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const blocker = liveBlocker(snapshot);
  const [busy, setBusy] = useState(false);
  if (blocker) return null;
  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      setLive('queue', await changes.setLanding(next));
      toasts.add({ title: next ? 'Merging resumed' : 'Merging paused' });
    } catch (err) {
      toasts.add({ title: 'Could not change the merge queue', description: errorMessage(err), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return { busy, toggle };
}

/** Owners pause and resume merging. Compact, it is the one control on a warning line. */
export function QueueControl({ enabled, compact = false }: { enabled: boolean; compact?: boolean }) {
  const landing = useLandingToggle();
  if (!landing) return null;
  const { busy, toggle } = landing;
  const size = compact ? 'sm' : 'base';
  return enabled ? (
    <Button variant="secondary" size={size} icon={PauseIcon} loading={busy} onClick={() => void toggle(false)}>
      Pause merging
    </Button>
  ) : (
    <Button variant={compact ? 'secondary' : 'primary'} size={size} icon={PlayIcon} loading={busy} onClick={() => void toggle(true)}>
      Resume merging
    </Button>
  );
}
