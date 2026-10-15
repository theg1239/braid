import { SkeletonRows } from '../ui/Skeleton';
import { useState } from 'react';
import { Badge, Banner, Button, Input, Select, useKumoToastManager } from '@cloudflare/kumo';
import { PlayIcon, StopIcon } from '@phosphor-icons/react';
import type { SwarmRun, SwarmScenario } from '../../../shared/types';
import { changes, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { refreshLive, setLive, useLive } from '../../lib/live';
import { BADGE } from '../ui/Status';
import { RelativeTime } from '../ui/Time';

const SCENARIOS: { value: SwarmScenario; label: string }[] = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'hotspot', label: 'Hotspot' },
  { value: 'disjoint', label: 'Disjoint' },
];

const RUN_STATUS: Record<SwarmRun['status'], { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  preparing: { label: 'Preparing', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  finished: { label: 'Finished', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

const isActive = (run: SwarmRun | null) => !!run && (run.status === 'preparing' || run.status === 'running');

/**
 * Simulated agents, for watching landing under load. Their edits are synthetic; review, rules,
 * merging and landing are the real system, and every simulated change is labelled. The merge
 * queue shows them to people who can change a live repository.
 */
export function Simulation() {
  const toasts = useKumoToastManager();
  const now = useNow();
  const live = useLive('swarm', changes.swarm, (run) => (isActive(run) ? 2_000 : 15_000));
  const run = live.data;
  const active = isActive(run);
  const [agents, setAgents] = useState('50');
  const [scenario, setScenario] = useState<SwarmScenario>('mixed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = Number(agents);
  const valid = Number.isInteger(count) && count >= 1 && count <= 2000;

  const start = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await changes.startSwarm(count, scenario);
      setLive('swarm', started);
      toasts.add({ title: 'Simulated agents started', description: `${plural(started.agents, 'agent')}, ${started.scenario} scenario` });
      refreshLive('changes');
      refreshLive('queue');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const stopped = await changes.stopSwarm();
      if (stopped) setLive('swarm', stopped);
      else void live.refresh();
      toasts.add({ title: 'Simulated agents stopped' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section sim" aria-labelledby="sim-title">
      <h2 className="section__title" id="sim-title">
        Simulated agents
      </h2>
      <div className="sim__form">
        <Input label="Agents" type="number" min={1} max={2000} value={agents} onChange={(event) => setAgents(event.target.value)} disabled={active} passwordManagerIgnore className="sim__agents" />
        <Select label="Scenario" value={scenario} disabled={active} onValueChange={(value) => value && setScenario(value as SwarmScenario)} items={SCENARIOS} />
        <div className="sim__actions">
          {active ? (
            <Button variant="secondary-destructive" icon={StopIcon} loading={busy} onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button variant="secondary" icon={PlayIcon} loading={busy} disabled={!valid} onClick={() => void start()}>
              Start
            </Button>
          )}
        </div>
      </div>
      {error ? <Banner variant="error" size="sm" description={error} /> : null}
      {run ? <RunProgress run={run} now={now} /> : live.loading ? <SkeletonRows rows={2} label="Loading simulated agents" /> : <p className="quiet">No simulated agents have run here.</p>}
    </section>
  );
}

function RunProgress({ run, now }: { run: SwarmRun; now: number }) {
  const status = RUN_STATUS[run.status];
  const total = run.agents || 1;
  const landedShare = Math.min(100, Math.round((run.counts.landed / total) * 100));
  return (
    <div className="run" data-status={run.status}>
      <p className="run__line">
        <Badge variant={BADGE[status.tone]}>{status.label}</Badge>
        <span>
          {plural(run.agents, 'simulated agent')}, {run.scenario} scenario
        </span>
        <span className="run__who">
          started by {run.startedBy}{' '}
          <RelativeTime at={run.startedAt} now={now} />
        </span>
      </p>
      <div className="run__bar" role="img" aria-label={`${run.launched} of ${run.agents} launched, ${run.counts.landed} landed`}>
        <span className="run__fill" style={{ width: `${landedShare}%` }} />
      </div>
      <dl className="run__counts">
        <div>
          <dt>Launched</dt>
          <dd>
            {run.launched} / {run.agents}
          </dd>
        </div>
        <div>
          <dt>Landed</dt>
          <dd>{run.counts.landed}</dd>
        </div>
        <div>
          <dt>Waiting to land</dt>
          <dd>{run.counts.queued + run.counts.landing}</dd>
        </div>
        <div>
          <dt>Reviewing</dt>
          <dd>{run.counts.open}</dd>
        </div>
        <div>
          <dt>With the author</dt>
          <dd>{run.counts.revise}</dd>
        </div>
        <div>
          <dt>Need a person</dt>
          <dd>{run.counts.attention}</dd>
        </div>
        {run.failures ? (
          <div>
            <dt>Failures</dt>
            <dd>{run.failures}</dd>
          </div>
        ) : null}
      </dl>
      {run.note ? <p className="run__note">{run.note}</p> : null}
    </div>
  );
}
