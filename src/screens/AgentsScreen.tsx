import { lazy, Suspense, useState } from 'react';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { canWrite, useSnapshot } from '../store/workspace';
import { Fleet, useFleet } from '../components/agents/Fleet';
import { TaskComposer } from '../components/agents/TaskComposer';
import { TaskRow, sortTasks, taskCounts, taskMatches, type TaskFilter } from '../components/agents/TaskRows';
import { NoRepositoryPanel } from '../components/repo/RepositorySetup';
import '../styles/agents.css';

const EMPTY: Record<TaskFilter, string> = { all: 'No tasks yet.', needs: 'Nothing needs you.', running: 'No tasks running.' };
const LocalActivity = lazy(() => import('../components/agents/LocalActivity'));

/**
 * The Agents tab, laid out like Pull requests: the composer, every task as a row with the person's first, then the
 * fleet by model, owner and tool. The recorded example replays its sample task instead of starting a new one.
 */
export function AgentsScreen() {
  const snapshot = useSnapshot();
  const writable = canWrite(snapshot);
  const now = useNow();
  const ready = !!snapshot.project.id;
  const fleet = useFleet(ready);
  const [filter, setFilter] = useState<TaskFilter>('all');

  useDocumentTitle(`Agents · ${snapshot.project.name || 'Braid'}`);

  if (!ready) {
    return (
      <div className="page">
        <NoRepositoryPanel />
      </div>
    );
  }

  const head = snapshot.project.head;
  const tasks = sortTasks(snapshot.missions, head);
  const counts = taskCounts(snapshot.missions, head);
  const shown = tasks.filter((task) => taskMatches(task, head, filter));

  return (
    <div className="page">
      <h1 className="sr-only">Agents</h1>
      <TaskComposer />
      {snapshot.capabilities.mode === 'live' && snapshot.capabilities.identity ? <Suspense fallback={null}><LocalActivity /></Suspense> : null}
      <section className="list tasks" aria-labelledby="tasks-title">
        <header className="list__head">
          <h2 id="tasks-title" className="list__filter" aria-current="page">
            Tasks
            {tasks.length ? <span className="list__count">{tasks.length}</span> : null}
          </h2>
          {tasks.length ? <div className="tasks__filters" role="group" aria-label="Filter tasks">
            {(['all', 'needs', 'running'] as const).map((value) => <button key={value} type="button" className="tasks__filter" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : value === 'needs' ? writable ? 'Needs you' : 'Needs the owner' : 'Running'}<span>{value === 'all' ? tasks.length : counts[value]}</span>
            </button>)}
          </div> : null}
        </header>
        {shown.length ? (
          <ul className="list__rows" aria-label="Agent tasks">
            {shown.map((mission) => (
              <TaskRow key={mission.id} mission={mission} head={head} now={now} writable={writable} />
            ))}
          </ul>
        ) : (
          <p className="agents-empty">{filter === 'needs' && !writable ? 'Nothing needs the owner.' : EMPTY[filter]}</p>
        )}
      </section>
      <Fleet live={fleet} />
    </div>
  );
}
