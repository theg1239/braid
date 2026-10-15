import { agentByline } from './identity';
import type { Mission } from '../../../shared/types';
import type { MissionFile } from '../../lib/derive';
import { useFileChanges, type ChangeResult } from '../../lib/resources';
import { CodeError, CodeLoading, DiffView } from '../code';

/** Loaded only when comparison is opened; proposal content uses the existing revision-aware cache. */
export function VersionCompare({ mission, file }: { mission: Mission; file: MissionFile }) {
  const { results, retry } = useFileChanges(mission.id, file.versions.map(({ agent, change }) => ({ agentId: agent.id, change })));
  const failed = results.find((result): result is Extract<ChangeResult, { status: 'error' }> => result.status === 'error');
  if (failed) return <CodeError result={failed} onRetry={retry} />;
  if (!results.every((result) => result.status === 'ready')) return <CodeLoading label="Loading versions" />;
  const loaded = results.map((result) => (result as Extract<ChangeResult, { status: 'ready' }>).change);
  if (mission.withheld || loaded.some((change) => change.withheld)) return <p className="quiet">Content withheld because this revision contains a secret.</p>;
  return (
    <div className="version-compare">
      {file.versions.slice(1).map(({ agent }, index) => <section key={agent.id} aria-label={`${file.versions[0].agent.name} compared with ${agent.name}`}>
        <div className="version-compare__legend"><span>− {agentByline(file.versions[0].agent)}</span><span>+ {agentByline(agent)}</span></div>
        <DiffView path={file.path} before={loaded[0].deleted ? null : loaded[0].after} after={loaded[index + 1].deleted ? null : loaded[index + 1].after} id={`${mission.id}:${file.path}:${loaded[0].contentRef ?? loaded[0].afterHash}:${loaded[index + 1].contentRef ?? loaded[index + 1].afterHash}`} names={{ before: file.versions[0].agent.name, after: agent.name }} />
      </section>)}
    </div>
  );
}
