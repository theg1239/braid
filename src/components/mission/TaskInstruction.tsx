import { useState, type FormEvent } from 'react';
import { Banner, Button, InputArea } from '@cloudflare/kumo';
import type { Mission } from '../../../shared/types';
import { api, errorMessage } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/hooks';
import { canWrite, readOnlyReason, useWorkspace } from '../../store/workspace';

export function TaskInstruction({ mission }: { mission: Mission }) {
  const { snapshot, refresh } = useWorkspace();
  const attempt = useIdempotencyKey();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  if (mission.status !== 'running' || mission.source !== 'live') return null;
  const writable = canWrite(snapshot);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!writable || busy || !message.trim()) return;
    const body = { missionId: mission.id, title: 'Task instruction', body: message.trim(), kind: 'constraint' as const };
    setBusy(true); setError(null); setSent(false);
    try {
      await api.addContext(body, attempt.key(body));
      attempt.settle(); setMessage(''); setSent(true); void refresh();
    } catch (err) { attempt.settle(err); setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <form className="task-instruction" onSubmit={send} aria-label="Send task instruction">
    <InputArea label="Instruction" value={message} onValueChange={value => { setMessage(value); setSent(false); }} placeholder="What should the agents do next?" maxLength={4000} minRows={2} maxRows={5} autoResize disabled={!writable || busy} />
    <div className="task-instruction__footer">
      <span className="quiet" role="status">{sent ? 'Sent. Agents receive this when they next read task context.' : 'Included in the agents’ next task context read.'}</span>
      <Button type="submit" variant="secondary" loading={busy} disabled={!writable || !message.trim()} title={!writable ? readOnlyReason(snapshot, 'send an instruction') : undefined}>Send instruction</Button>
    </div>
    {error ? <Banner variant="error" size="sm" description={error} /> : null}
  </form>;
}
