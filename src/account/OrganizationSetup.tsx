import { useState, type FormEvent } from 'react';
import { Banner, Button, Input, useKumoToastManager } from '@cloudflare/kumo';
import { slugOf } from '../../shared/routes';
import { errorMessage } from '../lib/api';
import { navigate, paths } from '../lib/router';
import { useAccount } from './AccountProvider';
import { accountApi } from './api';

export function CreateOrganizationForm() {
  const { refresh } = useAccount();
  const toasts = useKumoToastManager();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugOf(name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const organization = await accountApi.createOrganization(name.trim());
      await refresh();
      toasts.add({ title: 'Organization created', description: organization.name });
      navigate(paths.owner(organization.slug));
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return <form className="gate__form" onSubmit={submit}>
    <Input label="Organization name" value={name} onChange={event => setName(event.target.value)} maxLength={60} autoFocus disabled={busy} required passwordManagerIgnore />
    {slug ? <p className="new-repo__preview">{window.location.host}/<b>{slug}</b></p> : null}
    {error ? <Banner variant="error" size="sm" description={error} /> : null}
    <Button type="submit" variant="primary" className="gate__wide" loading={busy} disabled={!name.trim()}>Create organization</Button>
  </form>;
}
