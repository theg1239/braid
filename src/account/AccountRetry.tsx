import { useState } from 'react';
import { Button } from '@cloudflare/kumo';
import { useAccount } from './AccountProvider';

/** A failed account read leaves public pages usable and offers another attempt in the header. */
export function AccountRetry() {
  const { refresh } = useAccount();
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="ghost" size="sm" loading={busy} onClick={async () => {
      setBusy(true);
      await refresh();
      setBusy(false);
    }}>
      Retry sign-in
    </Button>
  );
}
