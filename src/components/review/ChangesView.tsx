import { agentByline } from '../mission/identity';
import { useEffect, useState } from 'react';
import { Button, Collapsible, Select, Tabs } from '@cloudflare/kumo';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { Agent, FileChange, Mission } from '../../../shared/types';
import { groupFiles, type MissionFile } from '../../lib/derive';
import { basename, dirname, isEditableTarget, isModifierKey, joinNames, possessive } from '../../lib/format';
import { useFileChanges, type ChangeResult } from '../../lib/resources';
import { navigate, paths } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { EmptyPanel } from '../ui/States';
import { AgentName, Stats } from '../ui/Status';
import { CheckList } from '../mission/AgentCards';
import { CodeError, CodeLoading, DeletedFile, DiffView, FileView } from '../code';
import { DecisionPanel } from './DecisionPanel';
import { DisclosureTrigger } from '../ui/Disclosure';

const WHO: Record<MissionFile['disposition'], (file: MissionFile) => string> = {
  unresolved: (file) => file.versions.map((v) => v.agent.name).join(' vs '),
  selected: (file) => `${possessive(file.shipping?.agent.name ?? '')} version`,
  agreement: (file) => `Same in ${joinNames(file.versions.map((v) => v.agent.name))}`,
  independent: () => '',
};

export function ChangesView({ mission, files, selectedPath }: { mission: Mission; files: MissionFile[]; selectedPath: string | null }) {
  const groups = groupFiles(files);
  const ordered = groups.flatMap((group) => group.files);
  const selected = ordered.find((file) => file.path === selectedPath) ?? ordered[0] ?? null;
  const index = selected ? ordered.indexOf(selected) : -1;
  const go = (offset: number) => {
    const next = ordered[index + offset];
    if (next) navigate(paths.review(mission.id, { file: next.path }), { replace: true });
  };

  // j and k step through files, like most code review tools.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isModifierKey(event) || event.altKey || isEditableTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'j') go(1);
      if (event.key === 'k') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (mission.withheld) return <EmptyPanel title="Content withheld because this revision contains a secret." />;
  if (!files.length) {
    return (
      <EmptyPanel
        title={mission.status === 'running' ? 'No changes yet' : 'No file changes'}
      />
    );
  }

  return (
    <div className="changes">
      <aside className="changes__files" aria-label="Changed files">
        {groups.map((group) => (
          <section key={group.disposition} className="file-group" aria-labelledby={`files-${group.disposition}`}>
            <h2 className="group-label" id={`files-${group.disposition}`}>
              {group.label}
            </h2>
            <ul className="file-list">
              {group.files.map((file) => (
                <li key={file.path}>
                  <RouterLink
                    href={paths.review(mission.id, { file: file.path })}
                    replace
                    className="file-row"
                    data-disposition={file.disposition}
                    data-deleted={file.shipping?.change.deleted || undefined}
                    aria-current={file.path === selected?.path ? 'true' : undefined}
                  >
                    <span className="file-row__path">
                      <span className="file-row__dir">{dirname(file.path)}</span>
                      <span className="file-row__base">{basename(file.path)}</span>
                      {file.shipping?.change.deleted ? <span className="sr-only"> (deleted)</span> : null}
                    </span>
                    {file.shipping ? (
                      <Stats additions={file.shipping.change.additions} deletions={file.shipping.change.deletions} className="file-row__stats" />
                    ) : (
                      <span className="file-row__versions">{file.versions.length} versions</span>
                    )}
                  </RouterLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>

      <div className="changes__picker">
        <Select
          aria-label="File"
          className="changes__select"
          value={selected?.path ?? ''}
          onValueChange={(value) => value && navigate(paths.review(mission.id, { file: String(value) }), { replace: true })}
          items={ordered.map((file) => ({ value: file.path, label: file.path }))}
        />
      </div>

      {selected ? (
        <FilePane
          key={selected.path}
          mission={mission}
          file={selected}
          position={`${index + 1} of ${ordered.length}`}
          onPrevious={index > 0 ? () => go(-1) : undefined}
          onNext={index < ordered.length - 1 ? () => go(1) : undefined}
        />
      ) : null}
    </div>
  );
}

type Mode = 'diff' | 'file';

/** What the snapshot says about a version before its text is read. */
function changeNote(change: FileChange): string | null {
  if (change.deleted) return 'Deleted';
  if (change.mode === '100755') return 'Executable';
  return null;
}

function FilePane({ mission, file, position, onPrevious, onNext }: { mission: Mission; file: MissionFile; position: string; onPrevious?: () => void; onNext?: () => void }) {
  const competing = file.disposition === 'unresolved' || file.disposition === 'selected';
  const [version, setVersion] = useState<string>(file.shipping?.agent.id ?? file.versions[0].agent.id);
  const [mode, setMode] = useState<Mode>('diff');
  const comparing = competing && version === 'compare' && file.versions.length === 2;
  const current = file.versions.find((v) => v.agent.id === version) ?? file.shipping ?? file.versions[0];
  const who = WHO[file.disposition](file);
  // Only what is on screen is read: the version being viewed, or exactly the two being compared.
  const wanted = comparing ? file.versions.slice(0, 2) : [current];
  const { results, retry } = useFileChanges(
    mission.id,
    wanted.map((v) => ({ agentId: v.agent.id, change: v.change })),
  );
  const failed = results.find((r): r is Extract<ChangeResult, { status: 'error' }> => r.status === 'error');
  const loaded = results.every((r) => r.status === 'ready') ? results.map((r) => (r as Extract<ChangeResult, { status: 'ready' }>).change) : null;
  const note = comparing ? null : changeNote(current.change);

  return (
    <section className="file-pane" aria-label={file.path}>
      <header className="file-head">
        <div className="file-head__text">
          <h2 className="file-head__path">
            <span className="file-head__dir">{dirname(file.path)}</span>
            {basename(file.path)}
          </h2>
          <p className="file-head__who" data-disposition={file.disposition}>
            {file.disposition === 'independent' ? <AgentName agent={file.versions[0].agent} role /> : who}
          </p>
        </div>
        <div className="file-head__nav">
          <span className="file-head__position">{position}</span>
          <Button size="sm" variant="ghost" shape="square" icon={CaretLeftIcon} aria-label="Previous file (k)" title="Previous file (k)" disabled={!onPrevious} onClick={onPrevious} />
          <Button size="sm" variant="ghost" shape="square" icon={CaretRightIcon} aria-label="Next file (j)" title="Next file (j)" disabled={!onNext} onClick={onNext} />
        </div>
      </header>

      {competing ? <DecisionPanel mission={mission} file={file} onPreview={setVersion} /> : null}

      <div className="viewer">
        <div className="viewer__bar">
          {competing ? (
            <Tabs
              size="sm"
              variant="segmented"
              value={version}
              onValueChange={setVersion}
              tabs={[
                ...file.versions.map((v) => ({ value: v.agent.id, label: v.agent.name })),
                ...(file.versions.length === 2 ? [{ value: 'compare', label: 'Compare' }] : []),
              ]}
            />
          ) : null}
          {!comparing ? (
            <Tabs
              size="sm"
              variant="segmented"
              className="viewer__mode"
              value={mode}
              onValueChange={(value) => setMode(value as Mode)}
              tabs={[
                { value: 'diff', label: 'Diff' },
                { value: 'file', label: 'File' },
              ]}
            />
          ) : (
            <span className="viewer__legend">
              <span className="viewer__legend-del">− {agentByline(file.versions[0].agent)}</span>
              <span className="viewer__legend-add">+ {agentByline(file.versions[1].agent)}</span>
            </span>
          )}
          {note ? <span className="viewer__note">{note}</span> : null}
          {!comparing ? <Stats additions={current.change.additions} deletions={current.change.deletions} className="viewer__stats" /> : null}
        </div>

        {failed ? (
          <CodeError result={failed} onRetry={retry} />
        ) : !loaded ? (
          <CodeLoading label={comparing ? 'Loading both versions' : 'Loading changes'} />
        ) : comparing ? (
          <DiffView
            key="compare"
            path={file.path}
            before={loaded[0].after}
            after={loaded[1].after}
            id={`${mission.id}:compare:${file.path}:${loaded[0].contentRef ?? loaded[0].afterHash ?? ''}:${loaded[1].contentRef ?? loaded[1].afterHash ?? ''}`}
            label={`${possessive(file.versions[0].agent.name)} version compared with ${possessive(file.versions[1].agent.name)}`}
            names={{ before: file.versions[0].agent.name, after: file.versions[1].agent.name }}
          />
        ) : mode === 'diff' ? (
          <DiffView key={current.agent.id} path={file.path} before={loaded[0].before} after={loaded[0].deleted ? null : loaded[0].after} id={`${mission.id}:${current.agent.id}:${file.path}:${loaded[0].contentRef ?? loaded[0].afterHash ?? ''}`} />
        ) : loaded[0].deleted ? (
          <DeletedFile path={file.path} />
        ) : (
          <FileView key={`${current.agent.id}-file`} content={loaded[0].after} path={file.path} id={`${mission.id}:${current.agent.id}:${file.path}:${loaded[0].contentRef ?? loaded[0].afterHash ?? ''}:file`} />
        )}
      </div>

      {!comparing ? <AgentNotes mission={mission} agent={current.agent} /> : null}
    </section>
  );
}

function AgentNotes({ mission, agent }: { mission: Mission; agent: Agent }) {
  if (!agent.rationale && !agent.checks.length) return null;
  return (
    <Collapsible.Root className="notes">
      <DisclosureTrigger>{possessive(agent.name)} reasoning</DisclosureTrigger>
      <Collapsible.Panel className="disclosure__panel">
        {agent.summary ? <p className="notes__summary">{agent.summary}</p> : null}
        {agent.rationale ? <p className="notes__rationale">{agent.rationale}</p> : null}
        {agent.checks.length ? <CheckList checks={agent.checks} mission={mission} /> : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
