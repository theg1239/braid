import { useCallback, useEffect, useState } from 'react';
import { Button, SkeletonLine, useKumoToastManager } from '@cloudflare/kumo';
import { FingerprintIcon, SignOutIcon } from '@phosphor-icons/react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, api, errorMessage } from '../lib/api';
import type { GitHubConnection } from '../../shared/github';
import { absoluteTime, relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { SkeletonLine as Placeholder } from '../components/ui/Skeleton';
import { Row, SettingsEmpty, SettingsError } from '../components/settings/Section';
import { useAccount } from './AccountProvider';
import { AGENT_SCOPE, accountApi, passkeyError, type AgentConnection, type Passkey } from './api';
import { useRepository } from './RepositoryGate';
import { navigate } from '../lib/router';
import { writeSession } from './session';
import { UsernameSetting } from './Username';

/** Who is signed in, with sign out. */
export function AccountIdentity() {
  const { account, signOut } = useAccount();
  const toasts = useKumoToastManager();
  const [busy, setBusy] = useState(false);
  const user = account?.user;
  if (!user) return null;
  return (
    <>
    <UsernameSetting />
    <Row compact label="Name"><span className="srow__value">{user.name || 'Not set'}</span></Row>
    <Row compact label="Email"><span className="srow__value">{user.email}</span></Row>
    <Row compact label="Session">
      <Button
        variant="secondary"
        size="sm"
        icon={SignOutIcon}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await signOut();
          } catch (err) {
            toasts.add({ title: 'Sign out failed', description: errorMessage(err), variant: 'error' });
            setBusy(false);
          }
        }}
      >
        Sign out
      </Button>
    </Row>
    </>
  );
}

/** GitHub as a sign-in method, with the login its connection reports to repository owners. */
export function GitHubSignIn() {
  const { owner } = useRepository();
  const [github, setGitHub] = useState<GitHubConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setGitHub(await api.githubConnection()); setError(null); }
    catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { if (owner) void load(); }, [owner, load]);
  if (error) return <Row label="GitHub" hint={<SettingsError>{error}</SettingsError>}><Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></Row>;
  return <Row label="GitHub">{github?.connected && github.login ? <span className="srow__value mono">{github.login}</span> : null}</Row>;
}

/** Passkeys on this account. Adding or removing one needs a sign-in from the last two hours; after that the person confirms it's them, as in GitHub's sudo mode. */
export function Passkeys() {
  const toasts = useKumoToastManager();
  const { account } = useAccount();
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [confirm, setConfirm] = useState<'needed' | 'busy' | null>(null);
  const supported = browserSupportsWebAuthn();
  /** The server answers 401 to a signed-in person only when their sign-in is too old to change passkeys. */
  const needsConfirm = (err: unknown) => err instanceof ApiError && err.status === 401;

  /** Confirm with an existing passkey, GitHub when configured, or an email code. */
  const confirmIdentity = async () => {
    setConfirm('busy');
    setError(null);
    try {
      if (keys?.length) {
        const { flowId, options } = await accountApi.passkeySignInOptions();
        await accountApi.passkeySignIn(flowId, await startAuthentication({ optionsJSON: options }));
        setConfirm(null);
        return;
      }
      const next = window.location.pathname + window.location.search + window.location.hash;
      if (account?.methods.github) {
        writeSession('next', next);
        window.location.assign('/api/auth/github');
      } else {
        navigate(`/signin?${new URLSearchParams({ next, confirm: '1' })}`);
      }
    } catch (err) {
      setConfirm('needed');
      setError(passkeyError(err));
    }
  };

  const load = useCallback(async () => {
    try {
      setKeys(await accountApi.passkeys());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const { flowId, options } = await accountApi.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      await accountApi.passkeyRegister(flowId, response);
      toasts.add({ title: 'Passkey added', variant: 'success' });
      await load();
    } catch (err) {
      if (needsConfirm(err)) setConfirm('needed');
      else setError(passkeyError(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      {error ? <Row label={keys ? 'Something went wrong' : 'Couldn’t load passkeys'} hint={<SettingsError>{error}</SettingsError>}>{keys ? null : <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}</Row> : null}
      {confirm ? (
        <Row label="Confirm it’s you" hint={keys?.length ? 'Use one of your passkeys.' : account?.methods.github ? 'Sign in with GitHub again.' : 'Sign in again.'}>
          <Button size="sm" variant="primary" loading={confirm === 'busy'} onClick={() => void confirmIdentity()}>Confirm</Button>
        </Row>
      ) : null}
      {keys === null && !error ? <div className="srow srow--compact" aria-busy="true" aria-label="Loading passkeys">
        <div className="srow__text"><span className="srow__label">Passkey</span><span className="srow__hint"><Placeholder width={180} height={10} /></span></div>
        <div className="srow__control"><Button size="sm" variant="ghost" disabled>Remove</Button></div>
      </div> : null}
      {keys?.map(key => <Row compact key={key.id} label="Passkey" hint={`Added ${absoluteTime(key.createdAt)}`}><Button size="sm" variant="ghost" onClick={() => setRemoving(key)}>Remove</Button></Row>)}
      {keys?.length === 0 ? <SettingsEmpty>No passkeys added.</SettingsEmpty> : null}
      <Row label="Add a passkey" hint={supported ? undefined : 'This browser does not support passkeys.'}>
        <Button size="sm" variant="secondary" icon={FingerprintIcon} loading={adding} disabled={!supported} onClick={() => void add()}>Add passkey</Button>
      </Row>
      <ConfirmDialog
        open={!!removing}
        title="Remove this passkey?"
        description="You can no longer sign in with it."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await accountApi.removePasskey(removing.id);
          } catch (err) {
            if (!needsConfirm(err)) throw err;
            setRemoving(null);
            setConfirm('needed');
            return;
          }
          toasts.add({ title: 'Passkey removed' });
          await load();
        }}
      />
    </>
  );
}

/** Coding agents this person approved, each limited to one repository until it expires or is revoked. */
export function AgentConnections() {
  const { scope } = useRepository();
  const { account } = useAccount();
  const toasts = useKumoToastManager();
  const now = useNow();
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AgentConnection | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections((await accountApi.connections()).filter(connection => connection.workspaceId === scope));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [scope]);

  useEffect(() => {
    setConnections(null);
    void load();
  }, [load]);

  return (
    <>
      {error ? <Row label="Could not load connected agents" hint={<SettingsError>{error}</SettingsError>}><Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></Row> : null}
      {connections === null && !error ? <div className="settings-loading" aria-busy="true" aria-label="Loading connected agents"><SkeletonLine /></div> : null}
      {connections?.map(connection => {
        const expires = new Date(connection.expires).toISOString();
        return <Row compact key={connection.id} label={<>{connection.label}{account?.user ? <span className="quiet"> for {account.user.username ? `@${account.user.username}` : account.user.name}</span> : null}</>} hint={<>{AGENT_SCOPE[connection.scope].label} · <time dateTime={expires}>{connection.expires > now ? `Expires ${absoluteTime(expires)}` : `Expired ${relativeTime(expires, now)}`}</time></>}>
          <Button size="sm" variant="ghost" onClick={() => setRevoking(connection)}>Revoke</Button>
        </Row>;
      })}
      {connections?.length === 0 ? <SettingsEmpty>No agents connected.</SettingsEmpty> : null}
      <ConfirmDialog
        open={!!revoking}
        title="Revoke this agent’s access?"
        description={`${revoking?.label ?? 'The agent'} loses access immediately and has to ask for approval again.`}
        confirmLabel="Revoke"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await accountApi.revokeConnection(revoking.id);
          toasts.add({ title: 'Agent access revoked', description: revoking.label });
          await load();
        }}
      />
    </>
  );
}
