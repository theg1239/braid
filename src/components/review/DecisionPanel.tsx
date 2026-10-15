import { agentByline } from '../mission/identity';
import { useMemo, useState, type FormEvent } from 'react';
import { Banner, Button, InputArea, Radio, useKumoToastManager } from '@cloudflare/kumo';
import { CheckCircleIcon } from '@phosphor-icons/react';
import type { Mission } from '../../../shared/types';
import { changeIdentity } from '../../../shared/tasks';
import { api, errorMessage } from '../../lib/api';
import { agentById, type MissionFile } from '../../lib/derive';
import { distinctLines } from '../../lib/distinct';
import { isLargeText, textSize } from '../../lib/diff';
import { basename, possessive } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { prefetchPreview, useFileChanges, type ChangeResult } from '../../lib/resources';
import { canWrite, useWorkspace } from '../../store/workspace';
import { SkeletonLine } from '../ui/Skeleton';
import { Stats } from '../ui/Status';
import { RelativeTime } from '../ui/Time';

export function DecisionPanel({ mission, file, onPreview }: { mission: Mission; file: MissionFile; onPreview?: (agentId: string) => void }) {
  const collision = file.collision;
  const { snapshot, applyMission, refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const now = useNow();
  const resolution = collision?.resolution;
  const winner = resolution ? agentById(mission, resolution.agentId) : undefined;
  const writable = canWrite(snapshot);
  const editable = mission.status === 'review' && writable;
  const [editing, setEditing] = useState(!resolution);
  const [choice, setChoice] = useState<string>(resolution?.agentId ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The distinguishing lines need every version's text, which loads behind the summaries and stats.
  const { results } = useFileChanges(
    mission.id,
    file.versions.map((v) => ({ agentId: v.agent.id, change: v.change })),
  );
  const loaded = results.every((r): r is Extract<ChangeResult, { status: 'ready' }> => r.status === 'ready') ? results.map((r) => r.change) : null;
  const failed = results.some((r) => r.status === 'error');
  const signature = loaded ? loaded.map(changeIdentity).join('\n') : '';
  const differences = useMemo(
    () => {
      if (!loaded) return null;
      // The snippets come from a whole-file diff, which a large version is never split into.
      if (loaded.some((change) => isLargeText(textSize(change.after)))) return null;
      return distinctLines(file.versions.map((v, index) => ({ agentId: v.agent.id, after: loaded[index].after })));
    },
    // Recomputes only when the set of loaded versions changes; the texts behind a signature are immutable.
    [signature],
  );

  if (!collision) return null;
  const chosen = file.versions.find((v) => v.agent.id === choice)?.agent;

  if (resolution && winner && (!editing || !editable)) {
    const others = file.versions.filter((v) => v.agent.id !== winner.id).map((v) => v.agent.name);
    return (
      <section className="decision decision--made" aria-label={`Decision for ${file.path}`}>
        <CheckCircleIcon size={18} weight="fill" className="decision__icon" aria-hidden="true" />
        <div className="decision__made">
          <p className="decision__verdict">
            {possessive(winner.name)} version merges
            {others.length ? <span className="decision__over"> over {others.join(', ')}</span> : null}
          </p>
          {resolution.reason ? <p className="decision__reason">“{resolution.reason}”</p> : null}
        </div>
        <RelativeTime at={resolution.resolvedAt} now={now} className="decision__time" />
        {editable ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(true);
              setChoice(resolution.agentId);
              setReason(resolution.reason ?? '');
            }}
          >
            Change
          </Button>
        ) : null}
      </section>
    );
  }

  if (!editable) {
    // Not editable while in review means the viewer cannot write.
    return mission.status === 'review' ? (
      <p className="decision decision--readonly">Waiting for an owner to choose.</p>
    ) : null;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.resolveCollision(mission.id, { collisionId: collision.id, agentId: chosen.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      applyMission(updated);
      if (snapshot) prefetchPreview(updated, snapshot.project.head);
      toasts.add({ title: `${possessive(chosen.name)} version chosen`, description: basename(file.path), variant: 'success' });
      setEditing(false);
      setReason('');
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="decision" onSubmit={submit} aria-label={`Decide ${file.path}`}>
      <p className="decision__legend" aria-hidden="true">
        Which version merges?
      </p>
      <Radio.Group
        appearance="card"
        value={choice}
        onValueChange={(value) => {
          setChoice(String(value));
          onPreview?.(String(value));
        }}
        className="decision__choices"
      >
        <Radio.Legend className="sr-only">Which version merges?</Radio.Legend>
        {file.versions.map(({ agent, change }) => {
          const unique = differences?.get(agent.id);
          return (
            <Radio.Item
              key={agent.id}
              value={agent.id}
              className="decision__choice"
              label={
                <span className="choice-label">
                  <span className="choice-label__name">{agentByline(agent)}</span>
                  <span className="choice-label__role">{agent.role}</span>
                  <Stats additions={change.additions} deletions={change.deletions} className="choice-label__stats" />
                </span>
              }
              description={
                <span className="choice-body">
                  {agent.summary ? <span className="choice-body__summary">{agent.summary}</span> : null}
                  <Excerpt
                    name={agent.name}
                    unique={unique}
                    pending={!loaded && !failed}
                    note={failed ? 'Couldn’t load this version' : loaded && !differences ? 'Too large for a line preview' : unique && !unique.lines.length ? 'No lines only in this version' : null}
                  />
                </span>
              }
            />
          );
        })}
      </Radio.Group>
      <InputArea label="Reason" required={false} placeholder={`Why is this version right for ${collision.path}?`} value={reason} onValueChange={setReason} autoResize minRows={2} maxRows={6} maxLength={2000} />
      {error ? <Banner variant="error" size="sm" description={error} /> : null}
      <div className="decision__actions">
        {resolution ? (
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={busy} disabled={!chosen}>
          {chosen ? `Use ${possessive(chosen.name)} version` : 'Use this version'}
        </Button>
      </div>
    </form>
  );
}

/** Three one-line slots and a count, the same box while the versions load: the reason and the controls below never move. */
function Excerpt({ name, unique, pending, note }: { name: string; unique?: { lines: string[]; more: number }; pending: boolean; note: string | null }) {
  return (
    <span className="choice-body__lines" aria-label={`Lines only in ${possessive(name)} version`} aria-busy={pending || undefined}>
      {[0, 1, 2].map((index) => {
        const line = note ? undefined : unique?.lines[index];
        return (
          <code key={index} className="choice-body__line" title={line}>
            {pending ? <SkeletonLine width={`${[64, 48, 36][index]}%`} /> : index === 0 && note ? <span className="choice-body__note">{note}</span> : line}
          </code>
        );
      })}
      <span className="choice-body__more">{!note && unique?.more ? `+${unique.more} more lines` : null}</span>
    </span>
  );
}
