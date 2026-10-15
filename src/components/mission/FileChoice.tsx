import { ChangesSkeleton } from '../ui/ScreenSkeleton';
import { agentByline } from './identity';
import { Suspense, useState } from 'react';
import { Button, useKumoToastManager } from '@cloudflare/kumo';
import type { Mission } from '../../../shared/types';
import { api, errorMessage } from '../../lib/api';
import type { MissionFile } from '../../lib/derive';
import { basename, possessive } from '../../lib/format';
import { lazyComponent } from '../../lib/lazy';
import { paths } from '../../lib/router';
import { readOnlyReason, useSnapshot, useWorkspace } from '../../store/workspace';
import { RouterLink } from '../ui/Link';
import { Stats } from '../ui/Status';
import { CheckList } from './AgentCards';
import { expectOutcome, useOutcomeFocus } from './outcome';

const comparison = lazyComponent(() => import('./VersionCompare'), (m) => m.VersionCompare);
const VersionCompare = comparison.Component;

export function FileChoice({ mission, file, writable }: { mission: Mission; file: MissionFile; writable: boolean }) {
  const snapshot = useSnapshot();
  const { applyMission, refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The next question takes focus when a choice settles this one.
  const section = useOutcomeFocus<HTMLElement>('choice');
  const choose = async (agentId: string) => {
    if (!file.collision || busy) return;
    setBusy(agentId);
    setError(null);
    try {
      const updated = await api.resolveCollision(mission.id, { collisionId: file.collision.id, agentId });
      expectOutcome('choice');
      applyMission(updated);
      const { agent } = file.versions.find((version) => version.agent.id === agentId)!;
      toasts.add({ title: `${possessive(agent.name)} version chosen`, description: basename(file.path), variant: 'success' });
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section ref={section} tabIndex={-1} className="question question--task" data-kind="choice" aria-label={`Choose a version of ${file.path}`}>
      <div className="version-choice__heading"><h2 className="question__heading">Choose a version</h2><span className="quiet">{file.versions.length} versions</span></div>
      <RouterLink className="text-link mono version-choice__path" href={paths.review(mission.id, { file: file.path })}>{file.path}</RouterLink>
      <div className="choices" role="group" aria-label="Versions">
        {file.versions.map(({ agent, change }) => (
          <article key={agent.id} className="choice">
            <div className="choice__head"><h3 className="choice__name">{agentByline(agent)}</h3><Stats additions={change.additions} deletions={change.deletions} className="choice__stats" /></div>
            <p className="choice__summary">{agent.summary || agent.task}</p>
            <details className="choice__details"><summary>Reasoning and checks</summary>{agent.rationale ? <p>{agent.rationale}</p> : null}{agent.checks.length ? <CheckList checks={agent.checks} mission={mission} /> : <p className="quiet">No checks reported</p>}</details>
            <span className="choice__action" title={writable ? undefined : readOnlyReason(snapshot, 'choose a version')}><Button variant="secondary" size="sm" data-task-write disabled={!writable || !!busy} aria-busy={busy === agent.id} aria-label={`Use this version: ${possessive(agent.name)} ${file.path}`} onClick={() => void choose(agent.id)}>Use this version</Button></span>
          </article>
        ))}
      </div>
      {error && writable ? <p className="question__error" role="alert">{error}</p> : null}
      <Button size="sm" variant="ghost" className="version-choice__compare" aria-expanded={comparing} onClick={() => setComparing(!comparing)} onPointerEnter={() => void comparison.prefetch()} onFocus={() => void comparison.prefetch()}>{comparing ? 'Hide comparison' : 'Compare versions'}</Button>
      {comparing ? <Suspense fallback={<ChangesSkeleton />}><VersionCompare mission={mission} file={file} /></Suspense> : null}
    </section>
  );
}
