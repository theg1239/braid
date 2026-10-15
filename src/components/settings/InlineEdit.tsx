import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Input } from '@cloudflare/kumo';
import { errorMessage } from '../../lib/api';
import { Row, SettingsError } from './Section';

/** The same read, edit, save and cancel row for names and addresses. */
export function InlineEdit({ label, value, display, action = 'Rename', maxLength = 60, validate, save }: {
  label: string; value: string; display?: ReactNode; action?: string; maxLength?: number;
  validate?: (value: string) => string | null; save?: (value: string) => Promise<void>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = draft.trim();
  const cancel = () => { setEditing(false); setDraft(value); setError(null); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!save || busy || next === value) return;
    const invalid = !next ? `Enter ${label.toLowerCase()}.` : validate?.(next);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try { await save(next); setEditing(false); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Row label={label}>
    {editing ? <form className="settings-edit" onSubmit={submit} onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancel(); }
    }}>
      <div className="settings-edit__controls">
        <Input aria-label={label} aria-invalid={!!error} aria-describedby={error ? id : undefined} value={draft} onChange={event => { setDraft(event.target.value); setError(null); }} maxLength={maxLength} disabled={busy} autoFocus passwordManagerIgnore />
        <Button size="sm" variant="secondary" type="submit" loading={busy} disabled={!next || next === value}>Save</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
      {error ? <div id={id}><SettingsError>{error}</SettingsError></div> : null}
    </form> : <>
      {display ?? <span className="srow__value">{value}</span>}
      {save ? <Button size="sm" variant="secondary" onClick={() => { setDraft(value); setError(null); setEditing(true); }}>{action}</Button> : null}
    </>}
  </Row>;
}
