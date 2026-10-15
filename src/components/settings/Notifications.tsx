import { useState } from 'react';
import { Button, Switch } from '@cloudflare/kumo';
import type { NotificationKind, NotificationPreferences } from '../../../shared/account';
import { errorMessage, request } from '../../lib/api';
import { setLive, useLive } from '../../lib/live';
import { SkeletonLine } from '../ui/Skeleton';
import { Row, Section, SettingsError } from './Section';

const LABELS: Record<NotificationKind, string> = {
  attention: 'Email me when a pull request needs me',
  returned: 'Email me when my agents’ pull requests are sent back',
};
const read = () => request<NotificationPreferences>('/api/notifications');

export function Notifications({ userId }: { userId: string }) {
  const key = `notifications:${userId}`;
  const preferences = useLive(key, read, 60_000);
  const [pending, setPending] = useState<NotificationKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: NotificationKind, enabled: boolean) => {
    setPending(kind); setError(null);
    try {
      setLive(key, await request<NotificationPreferences>('/api/notifications', { method: 'PATCH', body: JSON.stringify({ [kind]: enabled }) }));
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(null); }
  };
  return <Section id="notifications" title="Email notifications" rows foot={error ? <SettingsError>{error}</SettingsError> : undefined}>
    {preferences.data || !preferences.error ? <div role={!preferences.data ? 'status' : undefined} aria-label={!preferences.data ? 'Loading notifications' : undefined} aria-busy={!preferences.data || undefined}>
      {(Object.keys(LABELS) as NotificationKind[]).map(kind => <Row compact key={kind} label={<span id={`notify-${kind}`}>{LABELS[kind]}</span>}>
        {preferences.data ? <Switch aria-labelledby={`notify-${kind}`} checked={preferences.data[kind]} disabled={pending !== null} aria-busy={pending === kind} onCheckedChange={enabled => void change(kind, enabled)} /> : <SkeletonLine width={36} height={18} />}
      </Row>)}
    </div> : <Row label={<SettingsError>{preferences.error}</SettingsError>}>
      <Button variant="secondary" size="sm" disabled={preferences.refreshing} onClick={() => void preferences.refresh()}>Try again</Button>
    </Row>}
  </Section>;
}
