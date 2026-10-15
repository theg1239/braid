import { useState, type FormEvent } from 'react';
import { Banner, Button, SensitiveInput, useKumoToastManager } from '@cloudflare/kumo';
import { LockKeyIcon, LockKeyOpenIcon } from '@phosphor-icons/react';
import { AccountIdentity, GitHubSignIn, Passkeys } from '../../account/AccountSettings';
import { useAccount } from '../../account/AccountProvider';
import { api, errorMessage } from '../../lib/api';
import { navigate, paths } from '../../lib/router';
import { useSnapshot, useWorkspace } from '../../store/workspace';
import { Notifications } from './Notifications';
import { Row, Section } from './Section';

/** The person's profile and sign-in methods, or on the single-owner deployment its owner key. */
export function Account({ signedIn }: { signedIn: boolean }) {
  const snapshot = useSnapshot();
  const { account } = useAccount();
  if (signedIn) {
    return (
      <>
      <Section id="account" title="Profile" rows>
        <AccountIdentity />
      </Section>
      <Section id="sign-in" title="Sign-in methods" rows>
        {account?.methods.github ? <GitHubSignIn /> : null}
        {account?.methods.email ? <Row label="Email code"><span className="srow__value">Enabled</span></Row> : null}
        {!account?.methods.github && !account?.methods.email ? <Row label="Provider"><span className="srow__value">{account?.provider === 'access' ? 'Cloudflare Access' : 'Owner key'}</span></Row> : null}
      </Section>
        {account?.methods.passkeys ? (
          <Section id="passkeys" title="Passkeys" rows><Passkeys /></Section>
        ) : null}
        {account?.user ? <Notifications key={account.user.id} userId={account.user.id} /> : null}
      </>
    );
  }
  return <OwnerKey live={snapshot.capabilities.mode === 'live' || snapshot.capabilities.authenticated} />;
}

/** The single-owner deployment's key, exchanged for an HttpOnly session cookie. The key is never stored here. */
function OwnerKey({ live }: { live: boolean }) {
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.unlock(token.trim());
      setToken('');
      toasts.add({ title: 'Your repository is open', variant: 'success' });
      await refresh();
      navigate(paths.home());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.lock();
      toasts.add({ title: 'Back to the recorded example' });
      await refresh();
      navigate(paths.home());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (live) {
    return (
      <Section id="access" title="Owner" rows>
        <Row label="Your repository">
          <Button variant="secondary" size="sm" icon={LockKeyIcon} loading={busy} onClick={() => void lock()}>
            Lock
          </Button>
        </Row>
        {error ? (
          <div className="srow srow--wide">
            <Banner variant="error" size="sm" description={error} />
          </div>
        ) : null}
      </Section>
    );
  }
  return (
    <form onSubmit={unlock}>
      <Section
        id="access"
        title="Owner"
        rows
        foot={
          <>
            {error ? <Banner variant="error" size="sm" description={error} /> : null}
            <Button type="submit" variant="secondary" icon={LockKeyOpenIcon} loading={busy} disabled={!token.trim()}>
              Open your repository
            </Button>
          </>
        }
      >
        <Row label="Owner key">
          <SensitiveInput aria-label="Owner key" value={token} onValueChange={setToken} autoComplete="current-password" className="srow__input" />
        </Row>
      </Section>
    </form>
  );
}
