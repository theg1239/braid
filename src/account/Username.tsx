import { useState, type FormEvent } from 'react';
import { Banner, Button, Input } from '@cloudflare/kumo';
import { RESERVED_OWNERS, SLUG, usernameSuggestion } from '../../shared/routes';
import { RouterLink } from '../components/ui/Link';
import { InlineEdit } from '../components/settings/InlineEdit';
import { errorMessage, resetWorkspaceCaches } from '../lib/api';
import { EXAMPLE_ADDRESS, navigate, paths } from '../lib/router';
import { useAccount } from './AccountProvider';
import { resetAddresses } from './addresses';
import { accountApi } from './api';
import { GateLayout } from './GateLayout';
import '../styles/settings.css';

export function usernameError(value: string): string | null {
  const username = value.toLowerCase();
  return !SLUG.test(username) ? 'Use 1–39 letters, digits and single hyphens, with no hyphen at either end.'
    : RESERVED_OWNERS.has(username) ? 'This username is reserved.' : null;
}

export function PickUsername({ next = paths.newRepository() }: { next?: string }) {
  const { account, refresh } = useAccount();
  const [username, setUsername] = useState(account?.usernameSuggestion ?? usernameSuggestion(account!.user!.email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = usernameError(username);
    if (invalid) { setError(invalid); return; }
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await accountApi.username(username);
      resetAddresses();
      await refresh();
      navigate(next, { replace: true });
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return <GateLayout title="Pick a username" footer={<RouterLink href={paths.repo(EXAMPLE_ADDRESS)}>Explore the example</RouterLink>}>
    <form className="gate__form" onSubmit={submit}>
      <Input label="Username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus maxLength={39} value={username} onChange={event => { setUsername(event.target.value); setError(null); }} disabled={busy} description="Letters, numbers and single hyphens." />
      {username && !usernameError(username) ? <p className="username-preview">braid / <b>{username.toLowerCase()}</b></p> : null}
      {error ? <Banner variant="error" size="sm" description={error} /> : null}
      <Button type="submit" variant="primary" className="gate__wide" loading={busy} disabled={!username}>Continue</Button>
    </form>
  </GateLayout>;
}

/** A rename keeps Directory aliases; cached repository addresses must resolve afresh. */
export function UsernameSetting() {
  const { account, refresh } = useAccount();
  const username = account?.user?.username;
  return <InlineEdit label="Username" value={username ?? ''} display={username ? <span className="srow__value">@{username}</span> : <RouterLink href={paths.pickUsername()}>Pick a username</RouterLink>} maxLength={39} validate={usernameError} save={username ? async value => {
    await accountApi.username(value);
    resetAddresses(); resetWorkspaceCaches();
    await refresh();
  } : undefined} />;
}
