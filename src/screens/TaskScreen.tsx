import { Suspense, useEffect, useMemo, useState } from 'react';
import { recordRecent } from '../lib/recent';
import { Banner, Collapsible, LinkButton } from '@cloudflare/kumo';
import { StackIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { Mission, WorkspaceSnapshot } from '../../shared/types';
import { isStopped } from '../lib/task-state';
import { isLocalMission, missionActivity, missionFiles, missionPhase, type MissionFile } from '../lib/derive';
import { useDocumentTitle } from '../lib/title';
import { navigate, paths, useRoute } from '../lib/router';
import { prefetchPreview } from '../lib/resources';
import { lazyComponent } from '../lib/lazy';
import { useSnapshot } from '../store/workspace';
import { TaskInstruction } from '../components/mission/TaskInstruction';
import { HostedRun } from '../components/mission/HostedRun';
import { ActivityList } from '../components/mission/ActivityList';
import { AgentCards } from '../components/mission/AgentCards';
import { LocalTaskActions } from '../components/mission/LocalAgentSetup';
import type { MissionDraft } from '../components/mission/NextStep';
import { TaskHeader, type TaskView } from '../components/mission/TaskHeader';
import { TaskNext } from '../components/mission/TaskNext';
import { TaskStep } from '../components/mission/TaskStep';
import { Topology } from '../components/mission/Topology';
import { EmptyPanel } from '../components/ui/States';
import { ChangesSkeleton } from '../components/ui/ScreenSkeleton';
import { DisclosureTrigger } from '../components/ui/Disclosure';
import '../styles/mission.css';
import '../styles/review.css';

const ChangesView = lazyComponent(() => import('../components/review/ChangesView'), (m) => m.ChangesView).Component;
const MergeView = lazyComponent(() => import('../components/review/MergeView'), (m) => m.MergeView).Component;

/**
 * A task keeps its agent branch graph in view and shows only what it needs next below it.
 * Version choices compare inline; the full file review and combined result have their own chunks.
 */
export function TaskScreen({ view, onNewTask }: { view: TaskView; onNewTask: (draft?: MissionDraft) => void }) {
  const snapshot = useSnapshot();
  const route = useRoute();
  const mission = route.id ? snapshot.missions.find((m) => m.id === route.id) ?? null : null;
  const head = snapshot.project.head;
  const files = useMemo(() => (mission ? missionFiles(mission) : []), [mission]);

  useEffect(() => {
    if (!route.id) navigate(paths.agents(), { replace: true });
  }, [route.id]);

  useDocumentTitle(mission && `${view === 'task' ? '' : view === 'review' ? 'Compare code · ' : 'Combined result · '}${mission.title} · Braid`);

  const project = snapshot.project.id;
  const missionId = mission?.id;
  const missionTitle = mission?.title;
  useEffect(() => {
    if (missionId && missionTitle) recordRecent(project, { kind: 'task', href: paths.task(missionId), title: missionTitle });
  }, [project, missionId, missionTitle]);

  // Warm the combined result while the person is still looking around.
  useEffect(() => {
    if (mission?.status === 'review') prefetchPreview(mission, head);
  }, [mission, head]);

  if (!mission) return route.id ? <MissingTask /> : null;

  return (
    <div className="page task-page">
      <TaskHeader mission={mission} head={head} view={view} action={isLocalMission(mission) ? <LocalTaskActions mission={mission} /> : null} />
      <Suspense fallback={<ChangesSkeleton />}>
        {view === 'review' ? <ChangesView mission={mission} files={files} selectedPath={route.query.get('file')} /> : view === 'merge' ? <MergeView mission={mission} head={head} /> : <TaskBody key={mission.id} mission={mission} snapshot={snapshot} files={files} onNewTask={onNewTask} />}
      </Suspense>
    </div>
  );
}

function MissingTask() {
  useDocumentTitle('Task not found · Braid');
  return (
    <div className="page">
      <EmptyPanel heading="h1" icon={<StackIcon size={32} />} title="Task not found" action={<LinkButton href={paths.agents()}>Agents</LinkButton>} />
    </div>
  );
}

function TaskBody({ mission, snapshot, files, onNewTask }: { mission: Mission; snapshot: WorkspaceSnapshot; files: MissionFile[]; onNewTask: (draft?: MissionDraft) => void }) {
  const route = useRoute();
  const head = snapshot.project.head;
  const phase = missionPhase(mission, head);
  const [selected, setSelected] = useState<string | null>(() => route.query.get('agent'));
  const [agentsOpen, setAgentsOpen] = useState(true);

  return (
    <>
      {mission.error && !mission.agents.some(agent => agent.environment?.failure) ? (
        <div className="notice">
          <Banner variant={isStopped(mission) ? 'secondary' : 'error'} icon={<WarningCircleIcon weight="fill" />} title={isStopped(mission) ? 'Task stopped' : 'Task failed'} description={mission.error} />
        </div>
      ) : null}
      <HostedRun mission={mission} />
      {/* The branch graph stays in view: it is how the task's agents, their overlaps and the merge read at a glance. */}
      <div className="task-graph">
        <Topology
          mission={mission}
          files={files}
          head={head}
          phase={phase}
          selectedAgentId={selected}
          onSelectAgent={(id) => {
            setSelected((current) => (current === id ? null : id));
            setAgentsOpen(true);
          }}
        />
      </div>
      <TaskStep><TaskNext mission={mission} files={files} head={head} onRestart={onNewTask} /></TaskStep>
      <TaskInstruction mission={mission} />
      <div className="task-details">
        <Collapsible.Root open={agentsOpen} onOpenChange={setAgentsOpen}>
          <DisclosureTrigger>Agents <span className="quiet">{mission.agents.length}</span></DisclosureTrigger>
          <Collapsible.Panel className="disclosure__panel task-details__panel">
            <AgentCards mission={mission} files={files} selectedId={selected} />
          </Collapsible.Panel>
        </Collapsible.Root>
        <Collapsible.Root defaultOpen={mission.status === 'running'}>
          <DisclosureTrigger>Activity</DisclosureTrigger>
          <Collapsible.Panel className="disclosure__panel task-details__panel">
            <ActivityList items={missionActivity(snapshot, mission.id)} mission={mission} />
          </Collapsible.Panel>
        </Collapsible.Root>
      </div>
    </>
  );
}
