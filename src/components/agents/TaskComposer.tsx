import './composer.css';
import { useRef, useState, type FormEvent } from 'react';
import { Banner, Button, InputArea, Select } from '@cloudflare/kumo';
import { GitBranchIcon, PlayIcon } from '@phosphor-icons/react';
import type { AgentCount, HostedRunner } from '../../lib/api';
import { useHostedRunners } from './hostedRunners';
import type { ChangePage } from '../../../shared/types';
import { peekLive } from '../../lib/live';
import { LATEST_KEY } from '../../lib/needs';
import { trees } from '../../lib/reads';
import { useSnapshot } from '../../store/workspace';
import { useNewTask } from '../mission/newTask';
import type { MissionDraft } from '../mission/NextStep';
import { taskSuggestions } from '../mission/taskSuggestions';

const LOCAL = 'local';
const COUNTS = ['One agent', 'Two agents', 'Three agents'];
/** Braid's agents are chosen by how many run, `cloud:1` to `cloud:3`; Local is whichever of the person's agents takes the task. */
const hosted = (count: number) => `cloud:${count}`;
const hostedCount = (value: string | undefined) => (value?.startsWith('cloud:') ? Number(value.slice(6)) : 0);

/** The agents a task started again had. */
const draftAgents = (draft: MissionDraft) => (draft.execution === 'cloud' ? hosted(draft.agentCount ?? 1) : LOCAL);

/**
 * GitHub's agents composer, on the Agents tab and in the New task dialog: the brief, then one row with the branch,
 * the agents and Start. A task runs locally, taken by whichever of the person's agents they hand it to, or on one to
 * three of Braid's. Replay never accepts a brief for live work.
 */
export function TaskComposer({ draft = null, autoFocus = false, onStarted }: { draft?: MissionDraft | null; autoFocus?: boolean; onStarted?: () => void }) {
  const snapshot = useSnapshot();
  const { project } = snapshot;
  const { blocker, writable, demo, sample, localReady, cloudReady, busy, error, start } = useNewTask();
  const [intent, setIntent] = useState(draft?.intent ?? '');
  // Keep these fixed while composing: late reads must not move the controls or replace a draft.
  const [suggestions] = useState(() => taskSuggestions(snapshot, trees.values.values(), peekLive<ChangePage>(LATEST_KEY)?.items[0]));
  const form = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<string | null>(draft ? draftAgents(draft) : null);
  const items = [...(localReady ? [{ value: LOCAL, label: 'Local' }] : []), ...(cloudReady ? COUNTS.map((label, index) => ({ value: hosted(index + 1), label })) : [])];
  const chosen = items.find((item) => item.value === picked)?.value ?? items[0]?.value;
  const count = hostedCount(chosen) || 1;
  const ready = demo || !!chosen;
  const unavailable = blocker ?? (ready ? null : 'Hosted agents are not available here.');
  const brief = demo ? sample?.intent ?? '' : intent;
  // Braid's agents run on Workers AI, or on a provider a signed-in person connected with their own key.
  const runners = useHostedRunners(!demo && writable && cloudReady, draft?.provider);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (unavailable || !ready || !brief.trim() || busy) return;
    const cloud = demo || hostedCount(chosen) > 0;
    const started = await start({
      intent: brief,
      // A task started again keeps its title while its brief is unchanged.
      title: demo ? sample?.title : draft && intent === draft.intent ? draft.title : undefined,
      execution: cloud ? 'cloud' : 'local',
      agentCount: count as AgentCount,
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
            <span className="task-composer__agent">
              <Select<string> size="sm" aria-label="Agents" value={chosen} items={items} disabled={busy} renderValue={agentsLabel} onValueChange={(value) => { if (value) setPicked(value); }}>
                {localReady ? <Select.Option value={LOCAL}>Local</Select.Option> : null}
                {cloudReady ? (
                  <Select.Group>
                    <Select.GroupLabel>Braid’s agents</Select.GroupLabel>
                    {COUNTS.map((label, index) => <Select.Option key={label} value={hosted(index + 1)}>{label}</Select.Option>)}
                  </Select.Group>
                ) : null}
              </Select>
            </span>
          ) : null}
          {!demo && !unavailable && writable && hostedCount(chosen) && runners.items.length > 1 ? (
            <span className="task-composer__runner">
              <Select<string> size="sm" aria-label="Runs on" value={runners.runner} items={runners.items} disabled={busy} onValueChange={(value) => { if (value) runners.pick(value as HostedRunner); }}>
                {runners.items.map((item) => <Select.Option key={item.value} value={item.value}>{item.label}</Select.Option>)}
              </Select>
            </span>
          ) : null}
          <span className="task-composer__submit">
            <Button type="submit" variant="primary" size="sm" icon={demo ? PlayIcon : undefined} disabled={busy || !!unavailable || !ready || !brief.trim()}>{demo ? 'Replay' : count > 1 ? `Start ${count} agents` : 'Start task'}</Button>
          </span>
        </span>
      </div>
      {error ? <div className="task-composer__error"><Banner variant="error" size="sm" description={error} /></div> : null}
    </form>
  );
}

/** What the picker shows closed: Local, or how many of Braid's agents run. */
function agentsLabel(value: string): string {
  const braid = hostedCount(value);
  return !braid ? 'Local' : braid === 1 ? 'Braid’s agent' : `${braid} of Braid’s agents`;
}
