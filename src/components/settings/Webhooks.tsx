import { useState, type FormEvent } from 'react';
import { Banner, Button, Input, SensitiveInput, useKumoToastManager } from '@cloudflare/kumo';
import { TrashIcon } from '@phosphor-icons/react';
import { changes, errorMessage, type Webhook } from '../../lib/api';
import { shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { setLive, useLive } from '../../lib/live';
import { liveBlocker, useSnapshot } from '../../store/workspace';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorPanel } from '../ui/States';
import { Row, Section, SettingsEmpty, SettingsSkeleton } from './Section';
import { RelativeTime } from '../ui/Time';

/**
 * GitHub's Webhooks page, for the repository's own CI: Braid sends it a signed `merge_group` for
 * each merge group and it answers with commit statuses. Owners add, replace and remove the one
 * webhook; its secret never comes back.
 */
export function Webhooks() {
  const hook = useLive('hooks', changes.hook, 15_000);
  if (!hook.data && hook.error) {
    if (hook.errorStatus === 403) return <SettingsEmpty>{hook.error}</SettingsEmpty>;
    return <ErrorPanel title="Couldn’t load the webhook" message={hook.error} onRetry={() => void hook.refresh()} retrying={hook.refreshing} />;
  }
  if (hook.loading) return <SettingsSkeleton label="Loading the webhook" />;
  return hook.data ? <WebhookCard hook={hook.data} /> : <AddWebhook />;
}

/** The webhook as GitHub shows one, and its recent deliveries with the CI's response code. */
function WebhookCard({ hook }: { hook: Webhook }) {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const now = useNow();
  const blocker = liveBlocker(snapshot);
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Section
        id="webhook"
        rows
        foot={
          <span title={blocker ?? undefined}>
            <Button variant="secondary-destructive" size="sm" icon={TrashIcon} disabled={!!blocker} onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </span>
        }
      >
        <Row label="Payload URL">
          <span className="srow__value mono settings-remote">{hook.url}</span>
        </Row>
        <Row label="Content type">
          <span className="srow__value mono">application/json</span>
        </Row>
        <Row label="Events">
          <span className="srow__value mono">merge_group</span>
        </Row>
        <Row label="Added">
          <span className="srow__value">
            {hook.by}{' '}
            <RelativeTime at={hook.createdAt} now={now} />
          </span>
        </Row>
      </Section>
      <Section id="deliveries" title="Recent deliveries">
        {hook.deliveries.length ? (
          <div className="table-scroll">
            <table className="rules deliveries">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Response</th>
                  <th>Commit</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {hook.deliveries.map((delivery) => {
                  const ok = typeof delivery.status === 'number' && delivery.status >= 200 && delivery.status < 300;
                  return (
                    <tr key={delivery.id}>
                      <td className="mono">{delivery.event}</td>
                      <td className="deliveries__code" data-tone={ok ? 'ok' : 'fail'}>
                        {delivery.status === 'unreachable' ? 'Unreachable' : delivery.status}
                      </td>
                      <td className="mono">{shortHash(delivery.sha)}</td>
                      <td>
                        <RelativeTime at={delivery.at} now={now} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <SettingsEmpty>No deliveries yet.</SettingsEmpty>
        )}
      </Section>
      <ConfirmDialog
        open={removing}
        title="Remove this webhook?"
        description="Your CI stops receiving merge groups."
        confirmLabel="Remove"
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await changes.deleteHook();
          setLive('hooks', null);
          toasts.add({ title: 'Webhook removed' });
        }}
      />
    </>
  );
}

/** GitHub's add-webhook form, reduced to what Braid needs: the URL and the secret it signs with. */
function AddWebhook() {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const blocker = liveBlocker(snapshot);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!url.trim() && !!secret;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy || blocker) return;
    setBusy(true);
    setError(null);
    try {
      setLive('hooks', await changes.setHook(url.trim(), secret));
      toasts.add({ title: 'Webhook added', variant: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} title={blocker ?? undefined}>
      <Section
        id="webhook"
        rows
        foot={
          <>
            {error ? <Banner variant="error" size="sm" description={error} /> : null}
            <Button type="submit" variant="primary" loading={busy} disabled={!!blocker || !ready}>
              Add webhook
            </Button>
          </>
        }
      >
        <Row label="Payload URL">
          <Input aria-label="Payload URL" type="url" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} maxLength={500} disabled={!!blocker} passwordManagerIgnore className="srow__input" />
        </Row>
        <Row label="Secret">
          <SensitiveInput aria-label="Secret" value={secret} onValueChange={setSecret} autoComplete="new-password" disabled={!!blocker} className="srow__input" />
        </Row>
        <Row label="Content type">
          <span className="srow__value mono">application/json</span>
        </Row>
        <Row label="Events">
          <span className="srow__value mono">merge_group</span>
        </Row>
      </Section>
    </form>
  );
}
