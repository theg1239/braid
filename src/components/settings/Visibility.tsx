import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import type { Visibility } from '../../../shared/account';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/** Both visibility transitions require a deliberate confirmation. */
export function VisibilityControl({ value, busy, change }: { value: Visibility; busy: boolean; change: (value: Visibility) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const next = value === 'public' ? 'private' : 'public';
  return <>
    <Button variant="secondary-destructive" size="sm" disabled={busy} onClick={() => setOpen(true)}>Make {next}</Button>
    <ConfirmDialog open={open} title={`Make repository ${next}?`} description={next === 'public' ? 'Anyone on the internet will be able to see this repository and its history.' : 'Only collaborators will be able to see this repository.'} confirmLabel="Confirm" variant={next === 'public' ? 'primary' : 'destructive'} onConfirm={() => change(next)} onClose={() => setOpen(false)} />
  </>;
}
