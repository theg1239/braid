import './composer.css';
import { useRef, useState, type FormEvent } from 'react';
import { Banner, Button, InputArea, Select } from '@cloudflare/kumo';
import { GitBranchIcon, PlayIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import type { AgentCount, HostedRunner } from '../../lib/api';
import { useHostedRunners } from './hostedRunners';
import type { ChangePage } from '../../../shared/types';
import { peekLive } from '../../lib/live';
import { LATEST_KEY } from '../../lib/needs';
import { trees } from '../../lib/reads';
import { useSnapshot } from '../../store/workspace';
import { ConnectAgentPopover } from './ConnectAgent';
import { useTaskConnections } from './ConnectedAgents';
import { useNewTask } from '../mission/newTask';
import type { MissionDraft } from '../mission/NextStep';
import { taskSuggestions } from '../mission/taskSuggestions';

const CONNECT = 'connect';
const COUNTS = ['One agent', 'Two agents', 'Three agents'];
/** Braid's agents are chosen by how many run, `cloud:1` to `cloud:3`; a connected agent by its id. */
const hosted = (count: number) => `cloud:${count}`;
const hostedCount = (value: string | undefined) => (value?.startsWith('cloud:') ? Number(value.slice(6)) : 0);

/** The agents a task started again had, while they are still here. */
function draftAgents(draft: MissionDraft): string[] | null {
  if (draft.execution === 'cloud') return [hosted(draft.agentCount ?? 1)];
  return draft.connectionIds?.length ? draft.connectionIds : null;
}

/**
 * GitHub's agents composer, on the Agents tab and in the New task dialog: the brief, then one row with the branch,
 * the agents and Start. A task runs on up to three of the person's connected agents or one to three of Braid's, so
 * choosing one kind clears the other; the picker starts on what can run and ends with connecting another agent.
 * Replay never accepts a brief for live work.
 */
export function TaskComposer({ draft = null, autoFocus = false, onStarted }: { draft?: MissionDraft | null; autoFocus?: boolean; onStarted?: () => void }) {
  const snapshot = useSnapshot();
  const { project } = snapshot;
  const { blocker, writable, demo, sample, localReady, cloudReady, busy, error, start } = useNewTask();
  const picking = !demo && localReady && writable;
  const connections = useTaskConnections(picking);
  const [intent, setIntent] = useState(draft?.intent ?? '');
  // Keep these fixed while composing: late reads must not move the controls or replace a draft.
  const [suggestions] = useState(() => taskSuggestions(snapshot, trees.values.values(), peekLive<ChangePage>(LATEST_KEY)?.items[0]));
  const form = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<string[] | null>(draft ? draftAgents(draft) : null);
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const mine = connections.data ?? [];
  const items = [...mine.map((connection) => ({ value: connection.id, label: connection.label })), ...(cloudReady ? COUNTS.map((label, index) => ({ value: hosted(index + 1), label })) : [])];
  const kept = (picked ?? []).filter((value) => items.some((item) => item.value === value));
  const chosen = kept.length ? kept : mine.length ? [mine[0].id] : cloudReady ? [hosted(1)] : [];
  const count = hostedCount(chosen[0]) || chosen.length;
  const loading = picking && !connections.data && !connections.error;
  const ready = demo || (!loading && count > 0);
  const unavailable = blocker ?? (ready || picking ? null : 'Hosted agents are not available here.');
  const brief = demo ? sample?.intent ?? '' : intent;
  // Braid's agents run on Workers AI, or on a provider a signed-in person connected with their own key.
  const runners = useHostedRunners(picking && cloudReady, draft?.provider);

  const choose = (values: string[]) => {
    if (values.includes(CONNECT)) {
      setChoosing(false);
      setConnecting(true);
      return;
    }
    const added = values.find((value) => !chosen.includes(value));
    setPicked(added && hostedCount(added) ? [added] : values.filter((value) => !hostedCount(value)).slice(0, 3));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (unavailable || !ready || !brief.trim() || busy) return;
    const cloud = demo || hostedCount(chosen[0]) > 0;
    const started = await start({
      intent: brief,
      // A task started again keeps its title while its brief is unchanged.
      title: demo ? sample?.title : draft && intent === draft.intent ? draft.title : undefined,
      execution: cloud ? 'cloud' : 'local',
      agentCount: count as AgentCount,
      connectionIds: cloud ? [] : chosen,
      ...(cloud && !demo ? { provider: runners.runner } : {}),
      ...(cloud && draft?.timeBudgetMinutes ? { timeBudgetMinutes: draft.timeBudgetMinutes } : {}),
    });
    if (!started) return;
    setIntent('');
    onStarted?.();
  };

  return (
    <form ref={form} className="task-composer" onSubmit={submit} aria-label={demo ? 'Replay recorded task' : 'New task'}>
      {demo ? (
        <div className="task-composer__sample">
          <strong>{sample?.title ?? 'Recorded task'}</strong>
        </div>
      ) : (
        <InputArea className="task-composer__input" aria-label="Task" value={intent} onValueChange={setIntent} placeholder="What should the agents change?" minRows={2} maxRows={8} maxLength={4000} autoResize autoFocus={autoFocus} disabled={!!blocker || busy} />
      )}
      {!demo && suggestions.length ? <div className="task-composer__suggestions" role="group" aria-label="Task suggestions">
        {suggestions.map(suggestion => <Button key={suggestion} type="button" variant="secondary" size="sm" disabled={!!blocker || busy || !!intent.trim()} title={suggestion} onClick={() => {
          setIntent(suggestion);
          form.current?.querySelector('textarea')?.focus();
        }}><span>{suggestion}</span></Button>)}
      </div> : null}
      <div className="task-composer__footer">
        <span className="task-composer__context">
          <span className="task-composer__branch" title={project.branch}><GitBranchIcon size={14} aria-hidden="true" /><span>{project.branch}</span></span>
          {draft?.timeBudgetMinutes ? <span className="task-composer__limit">{draft.timeBudgetMinutes} minute limit</span> : null}
        </span>
        <span className="task-composer__controls">
          {unavailable ? <span className="task-composer__note">{unavailable}</span> : !demo && writable ? (
            <span ref={anchor} className="task-composer__agent">
              {items.length || loading ? (
                <Select<string, true> multiple size="sm" aria-label="Agents" open={choosing} onOpenChange={setChoosing} value={chosen} items={items} disabled={busy || loading} renderValue={(values) => agentsLabel(values, items)} onValueChange={choose}>
                  {mine.length ? (
                    <Select.Group>
                      <Select.GroupLabel>Your agents (up to 3)</Select.GroupLabel>
                      {mine.map((connection) => <Select.Option key={connection.id} value={connection.id} disabled={!chosen.includes(connection.id) && !hostedCount(chosen[0]) && chosen.length === 3}>{connection.label}</Select.Option>)}
                    </Select.Group>
                  ) : null}
                  {cloudReady ? (
                    <Select.Group>
                      <Select.GroupLabel>Braid’s agents</Select.GroupLabel>
                      {COUNTS.map((label, index) => <Select.Option key={label} value={hosted(index + 1)}>{label}</Select.Option>)}
                    </Select.Group>
                  ) : null}
                  {picking ? <><Select.Separator /><Select.Option value={CONNECT}>Connect an agent…</Select.Option></> : null}
                </Select>
              ) : (
                <Button size="sm" variant="secondary" icon={PlugsConnectedIcon} onClick={() => setConnecting(true)}>Connect an agent</Button>
              )}
            </span>
          ) : null}
          {!demo && !unavailable && writable && hostedCount(chosen[0]) && runners.items.length > 1 ? (
            <span className="task-composer__runner">
              <Select<string> size="sm" aria-label="Runs on" value={runners.runner} items={runners.items} disabled={busy} onValueChange={(value) => { if (value) runners.pick(value as HostedRunner); }}>
                {runners.items.map((item) => <Select.Option key={item.value} value={item.value}>{item.label}</Select.Option>)}
              </Select>
            </span>
          ) : null}
          {connections.error ? <span className="task-composer__note" role="alert">Couldn’t load your agents.<Button size="sm" variant="ghost" onClick={() => void connections.refresh()} disabled={connections.refreshing}>Retry</Button></span> : null}
          <span className="task-composer__submit" title={!ready && !loading && !unavailable ? 'Connect an agent to start a task.' : undefined}>
            <Button type="submit" variant="primary" size="sm" icon={demo ? PlayIcon : undefined} disabled={busy || !!unavailable || !ready || !brief.trim()}>{demo ? 'Replay' : count > 1 ? `Start ${count} agents` : 'Start task'}</Button>
          </span>
        </span>
      </div>
      {error ? <div className="task-composer__error"><Banner variant="error" size="sm" description={error} /></div> : null}
      {picking ? <ConnectAgentPopover open={connecting} onOpenChange={setConnecting} anchor={anchor} /> : null}
    </form>
  );
}

/** What the picker shows closed: the agent, the first agent and how many more, or how many of Braid's. */
function agentsLabel(values: string[], items: { value: string; label: string }[]): string {
  const braid = hostedCount(values[0]);
  if (braid) return braid === 1 ? 'Braid’s agent' : `${braid} of Braid’s agents`;
  const first = items.find((item) => item.value === values[0])?.label ?? '';
  return values.length > 1 ? `${first} +${values.length - 1}` : first;
}
