import { useState } from 'react';
import { Banner, Button, useKumoToastManager } from '@cloudflare/kumo';
import { ApiError, errorMessage } from '../lib/api';
import { navigate, paths } from '../lib/router';
import { useAccount } from './AccountProvider';
import { accountApi } from './api';
import { GateLayout } from './GateLayout';

/** An invitation link opened in this tab. Nothing happens until the person accepts it. */
export function InviteAccept() {
  const { account, refresh, pendingInvite, settleInvite, signOut } = useAccount();
  const toasts = useKumoToastManager();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const finished = failure?.status === 410 || failure?.status === 400;

  const accept = async () => {
    if (!pendingInvite || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { organizationId } = await accountApi.acceptInvite(pendingInvite);
      settleInvite();
      const next = await refresh();
      const team = next?.organizations.find((t) => t.id === organizationId);
      toasts.add({ title: 'Joined the organization', description: team?.name, variant: 'success' });
      navigate(team ? paths.owner(team.slug) : paths.site());
    } catch (err) {
      setFailure({ status: err instanceof ApiError ? err.status : 0, message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <GateLayout title="Organization invitation">
      {account?.user ? <p className="gate__text">Signed in as {account.user.username ? `@${account.user.username}` : account.user.name}</p> : null}
      {failure ? <Banner variant="error" size="sm" description={failure.message} /> : null}
      {finished ? (
        <Button variant="primary" className="gate__wide" onClick={settleInvite}>
          Continue
        </Button>
      ) : (
        <div className="gate__actions">
          <Button variant="ghost" onClick={settleInvite} disabled={busy}>
            Not now
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void accept()}>
            Accept invitation
          </Button>
        </div>
      )}
      {failure?.status === 403 ? (
        <Button variant="ghost" className="gate__wide" onClick={() => void signOut()}>
          Sign in with another account
        </Button>
      ) : null}
    </GateLayout>
  );
}
