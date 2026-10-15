import { useState } from 'react';
import { Banner, Button, Dialog } from '@cloudflare/kumo';
import { errorMessage } from '../../lib/api';
import { EXAMPLE_SESSION_LIMIT } from '../../../shared/errors';

/** Asks before a destructive change and keeps the dialog open with the reason if it fails. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  variant = 'destructive',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'primary' | 'destructive';
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={(next) => {
        if (next || busy) return;
        setError(null);
        onClose();
      }}
    >
      <Dialog size="base" className="dialog">
        <div className="dialog__head">
          <Dialog.Title className="dialog__title">{title}</Dialog.Title>
        </div>
        <Dialog.Description className="dialog__text">{description}</Dialog.Description>
        {error ? <Banner variant="error" size="sm" description={error} /> : null}
        <div className="dialog__actions">
          <Dialog.Close render={(props) => <Button {...props} variant="ghost" disabled={busy}>Cancel</Button>} />
          <Button variant={variant} disabled={busy || error === EXAMPLE_SESSION_LIMIT} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
