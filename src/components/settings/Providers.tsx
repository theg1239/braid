import { useState, type FormEvent } from 'react';
import { Banner, Button, Dialog, LinkButton, Select, SensitiveInput, useKumoToastManager } from '@cloudflare/kumo';
import { XIcon } from '@phosphor-icons/react';
import { PROVIDER_IDS, PROVIDERS, type ProviderConnection, type ProviderId, type ProviderLimit } from '../../../shared/providers';
import { modelName } from '../../../shared/models';
import { errorMessage, request } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { setLive, useLive } from '../../lib/live';
import { PROVIDERS_KEY, readProviders } from '../../lib/providers';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonLine } from '../ui/Skeleton';
import { CopyValue } from './CopyValue';
import { Row, Section, SettingsError } from './Section';
import './providers.css';

const LOCAL = 'braid agent run -- codex';

/**
 * Settings → Agents → Providers: the keys Braid's hosted agents run on. A saved key is
 * never shown again; its row says when it last ran and what the provider last reported.
 */
export function Providers() {
  const live = useLive(PROVIDERS_KEY, readProviders, 60_000);
  const now = useNow();
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [removing, setRemoving] = useState<ProviderId | null>(null);
  const [busy, setBusy] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toasts = useKumoToastManager();
  const connected = new Map(live.data?.providers.map(item => [item.provider, item]));
  const update = (connection: ProviderConnection) => setLive(PROVIDERS_KEY, { providers: [...(live.data?.providers ?? []).filter(item => item.provider !== connection.provider), connection] });
  const act = async (provider: ProviderId, run: () => Promise<void>) => {
    setBusy(provider); setError(null);
    try { await run(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };
  const check = (provider: ProviderId) => act(provider, async () => update(await request<ProviderConnection>(`/api/providers/${provider}/check`, { method: 'POST', body: '{}' })));
  const choose = (provider: ProviderId, model: string) => act(provider, async () => update(await request<ProviderConnection>(`/api/providers/${provider}`, { method: 'PATCH', body: JSON.stringify({ model }) })));

  return <Section id="providers" title="Providers" rows foot={error || live.error ? <>
    <SettingsError>{error ?? live.error}</SettingsError>
    {live.error ? <Button size="sm" variant="secondary" disabled={live.refreshing} onClick={() => void live.refresh()}>Try again</Button> : null}
  </> : undefined}>
    <Row label="Workers AI" hint="No key needed"><span className="srow__value">Default</span></Row>
    <div className="provider-rows" aria-busy={!live.data && !live.error}>
    {PROVIDER_IDS.map(provider => {
      const connection = connected.get(provider);
      const name = PROVIDERS[provider].name;
      const hint = <span className="provider-state">{connection ? <ProviderState connection={connection} now={now} />
        : !live.data && !live.error ? <><SkeletonLine width="75%" /><SkeletonLine width="55%" /></> : null}</span>;
      if (!live.data) return <Row key={provider} label={name} hint={hint}>
        {live.error ? <span /> : <SkeletonLine width={220} height={32} />}
      </Row>;
      if (!connection) return <Row key={provider} label={name} hint={hint}>
        <Button size="sm" variant="secondary" onClick={() => setConnecting(provider)}>Connect</Button>
      </Row>;
      const rejected = connection.status === 'rejected';
      return <Row key={provider} label={name} hint={hint}>
        {rejected ? null : <Select<string> size="sm" aria-label={`${name} model`} value={connection.model} disabled={busy === provider}
          items={connection.models.map(model => ({ value: model, label: modelName(model) }))} onValueChange={model => { if (model && model !== connection.model) void choose(provider, model); }}>
          {connection.models.map(model => <Select.Option key={model} value={model}>{modelName(model)}</Select.Option>)}
        </Select>}
        {rejected
          ? <Button size="sm" variant="secondary" onClick={() => setConnecting(provider)}>Reconnect</Button>
          : <Button size="sm" variant="secondary" loading={busy === provider} onClick={() => void check(provider)}>Check</Button>}
        <Button size="sm" variant="ghost" onClick={() => setRemoving(provider)}>Disconnect</Button>
      </Row>;
    })}
    </div>
    <Row label="ChatGPT and Claude plans" hint="Run from your machine with your own login">
      <span className="srow__value mono">{LOCAL}</span><CopyValue value={LOCAL} label="command" />
    </Row>
    <ConnectProvider provider={connecting} onClose={() => setConnecting(null)} onConnected={connection => {
      update(connection);
      toasts.add({ title: `${PROVIDERS[connection.provider].name} connected` });
    }} />
    <ConfirmDialog
      open={!!removing}
      title={`Disconnect ${removing ? PROVIDERS[removing].name : ''}?`}
      description="Braid deletes the key. Tasks running on it stop at their next model call."
      confirmLabel="Disconnect"
      onClose={() => setRemoving(null)}
      onConfirm={async () => {
        if (!removing) return;
        await request(`/api/providers/${removing}`, { method: 'DELETE' });
        setLive(PROVIDERS_KEY, { providers: (live.data?.providers ?? []).filter(item => item.provider !== removing) });
      }}
    />
  </Section>;
}

/** "Connected · last used 2 hours ago", the last failure, and the limits the provider last reported. */
function ProviderState({ connection, now }: { connection: ProviderConnection; now: number }) {
  const used = connection.lastUsedAt ? `last used ${relativeTime(connection.lastUsedAt, now)}` : 'not used yet';
  const limits = connection.limits?.map(limitText).join(' · ');
  return <>
    {connection.error ? <span className={connection.status === 'ready' ? undefined : 'srow__danger'}>{connection.error}</span> : 'Connected'} · {used}
    {limits ? <><br />{limits}</> : null}
  </>;
}
const number = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
const dollars = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
function limitText(limit: ProviderLimit) {
  if (limit.kind === 'credit') return `${dollars.format(limit.remaining)} credit left`;
  return `${number.format(limit.remaining)}${limit.limit ? ` of ${number.format(limit.limit)}` : ''} ${limit.kind} left`;
}

function ConnectProvider({ provider, onClose, onConnected }: { provider: ProviderId | null; onClose: () => void; onConnected: (connection: ProviderConnection) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (busy) return; setKey(''); setError(null); onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!provider || !key.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const connection = await request<ProviderConnection>(`/api/providers/${provider}`, { method: 'PUT', body: JSON.stringify({ key: key.trim() }) });
      setKey('');
      onConnected(connection);
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const name = provider ? PROVIDERS[provider].name : '';
  return <Dialog.Root open={!!provider} onOpenChange={next => { if (!next) close(); }}>
    <Dialog size="base" className="dialog">
      <form onSubmit={submit} className="dialog__form">
        <div className="dialog__head">
          <Dialog.Title className="dialog__title">Connect {name}</Dialog.Title>
          <Dialog.Close render={props => <Button {...props} variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close" />} />
        </div>
        <SensitiveInput label="API key" placeholder={provider ? `${PROVIDERS[provider].prefix}…` : undefined} value={key} onValueChange={setKey} autoComplete="off" autoFocus />
        <Dialog.Description className="dialog__text">Only your hosted tasks use it. Braid encrypts it and never shows it again.</Dialog.Description>
        {error ? <Banner variant="error" size="sm" description={error} /> : null}
        <div className="dialog__actions">
          {provider ? <LinkButton variant="ghost" href={PROVIDERS[provider].keys} external>Get a key</LinkButton> : null}
          <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()}>Connect</Button>
        </div>
      </form>
    </Dialog>
  </Dialog.Root>;
}
