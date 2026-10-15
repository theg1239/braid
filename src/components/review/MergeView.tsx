import { useState } from 'react';
import { Badge, Banner, Button, Collapsible, Dialog, InlineCopyText, LayerCard, useKumoToastManager } from '@cloudflare/kumo';
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CopyIcon,
  DiamondIcon,
  DownloadSimpleIcon,
  FileIcon,
  GitMergeIcon,
  MinusCircleIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { AgentCheck, IntegrationFile, IntegrationPreview, Mission } from '../../../shared/types';
import { ApiError, api, errorMessage } from '../../lib/api';
import type { GateState } from '../../lib/derive';
import { basename, dirname, plural, shortHash } from '../../lib/format';
import { downloadText, useCopy, useIdempotencyKey } from '../../lib/hooks';
import { paths } from '../../lib/router';
import { useFileChange, useIntegrationPreview } from '../../lib/resources';
import { canWrite, readOnlyReason, useSnapshot, useWorkspace } from '../../store/workspace';
import { KIND_LABEL, KindIcon } from '../ui/Kind';
import { RouterLink } from '../ui/Link';
import { EmptyPanel, ErrorPanel } from '../ui/States';
import { Stats } from '../ui/Status';
import { agentByline, recordLabel } from '../mission/identity';
import { CodeError, CodeLoading, DiffView } from '../code';
import { SkeletonLine } from '../ui/Skeleton';
import { DisclosureTrigger } from '../ui/Disclosure';

export function MergeView({ mission, head }: { mission: Mission; head: string }) {
  const waiting = mission.status === 'running' || mission.status === 'draft';
  const { preview, error, changed, reload, acknowledge } = useIntegrationPreview(mission, head, !waiting);
  const [rejected, setRejected] = useState(false);

  if (waiting) return <EmptyPanel title="Agents are still working" />;
  if (!preview && error) return <ErrorPanel title="Couldn’t load the merge preview" message={error} onRetry={() => void reload()} />;
  if (!preview) return <MergeSkeleton rows={new Set(mission.agents.flatMap((a) => a.changes.map((c) => c.path))).size} />;

  return (
    <div className="merge">
      {rejected ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Not merged: this changed after your review"
          action={<Banner.Action variant="ghost" icon={<XIcon />} aria-label="Dismiss" onClick={() => setRejected(false)} />}
        />
      ) : changed ? (
        <Banner
          variant="secondary"
          icon={<WarningCircleIcon weight="fill" />}
          description="This preview has changed since you opened it."
          action={<Banner.Action variant="ghost" icon={<XIcon />} aria-label="Dismiss" onClick={acknowledge} />}
        />
      ) : null}

      <Summary
        mission={mission}
        preview={preview}
        onConflict={() => {
          setRejected(true);
          acknowledge();
          void reload();
        }}
      />

      <section className="section" aria-labelledby="result-title">
        <h2 className="section__title" id="result-title">
          Files
        </h2>
        <ul className="result-list">
          {[...preview.files].sort((a, b) => Number(b.disposition === 'unresolved') - Number(a.disposition === 'unresolved')).map((file) => (
            <ResultRow key={file.path} file={file} mission={mission} />
          ))}
        </ul>
      </section>

      <ChecksCard preview={preview} />
      <Collapsible.Root className="merge-details">
        <DisclosureTrigger>Details</DisclosureTrigger>
        <Collapsible.Panel className="disclosure__panel">
          <dl className="merge-details__commits"><dt>Starting commit</dt><dd className="mono">{shortHash(preview.baseCommit)}</dd><dt>Current main</dt><dd className="mono">{shortHash(preview.headCommit)}</dd></dl>
          <div className="merge__grid"><ChecksCard preview={preview} details /><RecordCard preview={preview} mission={mission} /></div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

function MergeSkeleton({ rows }: { rows: number }) {
  return (
    <div className="merge" aria-busy="true" aria-label="Composing the merge">
      <div className="merge-card merge-card--skeleton">
        <SkeletonLine className="skeleton-title" />
        <SkeletonLine className="skeleton-line skeleton-line--short" />
      </div>
      <section className="section">
        <h2 className="section__title">Files</h2>
        <div className="result-list result-list--skeleton">
          {Array.from({ length: Math.max(rows, 1) }, (_, i) => (
            <div key={i} className="result-row__head">
              <SkeletonLine className="skeleton-line" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------- Summary and merge ---------- */

function Summary({ mission, preview, onConflict }: { mission: Mission; preview: IntegrationPreview; onConflict: () => void }) {
  const { snapshot, refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  const writable = canWrite(snapshot);
  // The fingerprint the person confirmed. Captured when the dialog opens, never refetched at click time.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merged = mission.status === 'merged';
  const merging = mission.status === 'merging';
  const contributors = new Set(preview.files.flatMap((f) => f.versions.filter((v) => v.selected).map((v) => v.agentId))).size;
  const fingerprint = preview.fingerprint;
  // If the composition changes while the dialog is open, close it before it paints; the page shows what changed.
  if (confirmed && !busy && confirmed !== fingerprint) setConfirmed(null);

  const merge = async () => {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      // One key per reviewed composition: a resend after a dropped connection cannot merge twice.
      await api.mergeMission(mission.id, confirmed, attempt.key([mission.id, confirmed]));
      attempt.settle();
      setConfirmed(null);
      toasts.add({ title: 'Merging into main', description: mission.title });
      void refresh();
    } catch (err) {
      attempt.settle(err);
      if (err instanceof ApiError && err.status === 409) {
        setConfirmed(null);
        onConflict();
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <LayerCard className="merge-card" data-state={merged ? 'merged' : preview.ready ? 'ready' : 'blocked'}>
      <LayerCard.Primary className="merge-card__body">
        <div className="merge-card__text">
          <p className="merge-card__title">
            {merged ? (
              <>
                <GitMergeIcon size={18} weight="bold" className="merge-card__icon" aria-hidden="true" />
                Merged into main as{' '}
                <InlineCopyText value={preview.mergeCommit ?? ''} labels={{ copyAction: 'Copy merge commit', copied: 'Copied' }}>
                  {shortHash(preview.mergeCommit)}
                </InlineCopyText>
              </>
            ) : merging ? (
              'Merging into main'
            ) : (
              `Merge ${plural(preview.totals.files, 'file')} into main`
            )}
          </p>
          <p className="merge-card__meta">
            <Stats additions={preview.totals.additions} deletions={preview.totals.deletions} />
            <span>{plural(contributors, 'agent')}</span>
          </p>
          {!merged && !merging && (preview.blocker || !writable) ? <p className="merge-card__blocker">{!writable ? readOnlyReason(snapshot, 'merge') : mergeReason(preview)}</p> : null}
        </div>
        {merged ? null : (
          <Button
            variant="primary"
            icon={GitMergeIcon}
            disabled={!preview.ready || merging || !writable}
            title={writable ? undefined : readOnlyReason(snapshot, 'merge')}
            loading={merging}
            onClick={() => {
              setError(null);
              setConfirmed(fingerprint);
            }}
          >
            Merge into main
          </Button>
        )}
      </LayerCard.Primary>

      <Dialog.Root open={!!confirmed} onOpenChange={(open) => !busy && !open && setConfirmed(null)}>
        <Dialog size="base" className="dialog">
          <div className="dialog__head">
            <Dialog.Title className="dialog__title">Merge into main?</Dialog.Title>
          </div>
          <Dialog.Description className="dialog__text">
            These {plural(preview.totals.files, 'file')} merge exactly as reviewed, with the task record.
          </Dialog.Description>
          <Collapsible.Root><DisclosureTrigger>Details</DisclosureTrigger><Collapsible.Panel className="disclosure__panel"><p className="dialog__mono mono">{confirmed}</p></Collapsible.Panel></Collapsible.Root>
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
          <div className="dialog__actions">
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" disabled={busy}>Cancel</Button>} />
            <Button variant="primary" icon={GitMergeIcon} loading={busy} onClick={() => void merge()}>
              Merge
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </LayerCard>
  );
}

/* ---------- Files ---------- */

function ResultRow({ file, mission }: { file: IntegrationFile; mission: Mission }) {
  const [open, setOpen] = useState(false);
  const kept = file.versions.filter((v) => v.selected);
  const others = file.versions.filter((v) => !v.selected);
  const byline = (version: IntegrationFile['versions'][number]) => agentByline(mission.agents.find(agent => agent.id === version.agentId)!);
  const source = kept.length ? kept.map(byline).join(' + ') : file.versions.map(byline).join(' or ');
  const commit = kept.length === 1 && kept[0].commit ? shortHash(kept[0].commit) : null;

  const summary = (
    <>
      <span className="result-row__path">
        <span className="result-row__dir">{dirname(file.path)}</span>
        {basename(file.path)}
      </span>
      <span className="result-row__source">
        {file.disposition === 'unresolved' ? <Badge variant="warning">To choose</Badge> : null}
        {file.disposition === 'agreement' ? <Badge variant="outline">Identical</Badge> : null}
        <span className="result-row__agents">
          {source}
          {commit ? <span className="mono result-row__commit">{commit}</span> : null}
        </span>
        {file.disposition === 'selected' && others.length ? <span className="result-row__over">over {others.map((v) => v.agentName).join(', ')}</span> : null}
      </span>
      {file.change ? (
        <Stats additions={file.change.additions} deletions={file.change.deletions} className="result-row__stats" />
      ) : (
        <RouterLink href={paths.review(mission.id, { file: file.path })} className="text-link result-row__stats">
          Choose
        </RouterLink>
      )}
    </>
  );

  if (!file.change) {
    return (
      <li className="result-row" data-disposition={file.disposition}>
        <div className="result-row__head">
          <span className="result-row__caret" aria-hidden="true" />
          {summary}
        </div>
      </li>
    );
  }

  return (
    <li className="result-row" data-disposition={file.disposition} data-deleted={file.change.deleted || undefined}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="result-row__head">
          <CaretRightIcon size={12} weight="bold" className="result-row__caret" aria-hidden="true" />
          {summary}
        </Collapsible.Trigger>
        <Collapsible.Panel className="result-row__panel">
          {file.reason ? <p className="result-row__reason">“{file.reason}”</p> : null}
          {open ? <RowDiff mission={mission} file={file} change={file.change} /> : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

/** The reviewed version's text, read when its row opens. The preview itself carries only metadata. */
function RowDiff({ mission, file, change }: { mission: Mission; file: IntegrationFile; change: NonNullable<IntegrationFile['change']> }) {
  // The text belongs to the agent whose proposal the preview chose; identical versions share one reference.
  const owner = (file.versions.find((v) => v.selected) ?? file.versions[0]).agentId;
  const result = useFileChange(mission.id, owner, change);
  if (result.status === 'error') return <CodeError result={result} onRetry={result.retry} />;
  if (result.status === 'loading') return <CodeLoading label="Loading changes" />;
  if (result.change.withheld) return <div className="code code--empty">Content withheld because this revision contains a secret.</div>;
  return <DiffView path={file.path} before={result.change.before} after={result.change.deleted ? null : result.change.after} id={`${mission.id}:${owner}:${file.path}:${change.contentRef ?? change.afterHash ?? ''}`} />;
}

/* ---------- Checks ---------- */

function GateIcon({ state }: { state: GateState }) {
  const props = { size: 16, weight: 'fill' as const, className: 'gate-icon', 'data-state': state, 'aria-hidden': true };
  if (state === 'pass') return <CheckCircleIcon {...props} />;
  if (state === 'fail') return <XCircleIcon {...props} />;
  if (state === 'todo') return <DiamondIcon {...props} />;
  if (state === 'wait') return <CircleDashedIcon {...props} weight="bold" />;
  return <MinusCircleIcon {...props} />;
}

/** Server checks in plain words; the server's own sentence is one hover away. */
const CHECK_LABEL: Partial<Record<NonNullable<AgentCheck['kind']>, string>> = {
  proposals: 'Agents finished',
  decisions: 'Versions chosen',
  base: 'Main unchanged',
  patch: 'File validation',
  runtime: 'Tests',
};

function checkState(check: AgentCheck): GateState {
  if (check.status === 'passed') return 'pass';
  if (check.status === 'failed') return check.kind === 'decisions' ? 'todo' : 'fail';
  return 'note';
}

function checkValue(check: AgentCheck, preview: IntegrationPreview): string {
  if (check.kind === 'proposals') return check.status === 'passed' ? '' : 'Not yet';
  if (check.kind === 'decisions') return preview.totals.unresolved ? `${preview.totals.unresolved} open` : '';
  if (check.kind === 'base') return check.status === 'passed' ? '' : 'Moved';
  if (check.kind === 'runtime' && check.status === 'warning') return 'Not run';
  if (check.status === 'failed') return 'Failed';
  if (check.status === 'warning') return preview.source === 'demo' ? 'Not run' : 'Pending';
  if (check.kind === 'patch') return 'Format only';
  return '';
}

/** How the merge was put together, shown under Details rather than beside the checks. */
const INTERNAL_CHECKS = new Set<AgentCheck['kind']>(['proposals', 'decisions', 'base', 'patch']);
function mergeReason(preview: IntegrationPreview): string {
  if (preview.totals.unresolved) return `Choose a version for ${plural(preview.totals.unresolved, 'file')}.`;
  if (preview.checks.some(check => check.kind === 'base' && check.status === 'failed')) return 'Main changed. Update the task before merging.';
  if (preview.checks.some(check => check.status === 'failed')) return 'Review the failed checks before merging.';
  return 'This task is not ready to merge. See Details.';
}

function ChecksCard({ preview, details = false }: { preview: IntegrationPreview; details?: boolean }) {
  return (
    <LayerCard className="side-card">
      <LayerCard.Secondary className="side-card__head">{details ? 'Merge details' : 'Checks'}</LayerCard.Secondary>
      <LayerCard.Primary className="side-card__body">
        <ul className="gate-list">
          {preview.checks.filter(check => INTERNAL_CHECKS.has(check.kind) === details).map((check) => (
            <li key={check.label} className="gate-row" data-state={checkState(check)} title={details ? check.detail : undefined}>
              <GateIcon state={checkState(check)} />
              <span className="gate-row__label">{check.kind === 'base' && preview.status === 'merged' ? 'Merged version' : (check.kind && CHECK_LABEL[check.kind]) ?? check.label}</span>
              <span className="gate-row__value">{checkValue(check, preview)}</span>
              {details ? <span className="gate-row__detail">{check.detail}</span> : null}
            </li>
          ))}
        </ul>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/* ---------- Task record ---------- */

function RecordCard({ preview, mission }: { preview: IntegrationPreview; mission: Mission }) {
  const snapshot = useSnapshot();
  const [copied, copy] = useCopy();
  const merged = mission.status === 'merged';
  const dir = `.braid/missions/${mission.id}`;
  // Historical merges predate handoff.md; only link records that were actually stored.
  const records = ['decision.json', 'handoff.md', ...mission.agents.map((agent) => `${agent.id}.md`)]
    .filter((file) => !merged || Object.hasOwn(snapshot.files, `${dir}/${file}`));
  const counts = new Map<keyof typeof KIND_LABEL, number>();
  for (const item of preview.constraints) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const context = !preview.contextAvailable
    ? 'Not recorded'
    : counts.size
      ? [...counts].map(([kind, count]) => plural(count, KIND_LABEL[kind].toLowerCase())).join(', ')
      : 'None';

  return (
    <LayerCard className="side-card">
      <LayerCard.Secondary className="side-card__head">
        <span>Task record</span>
        <span className="side-card__actions">
          <Button size="sm" variant="ghost" icon={CopyIcon} onClick={() => void copy(preview.handoff, 'handoff', true)}>
            {copied === 'handoff' ? 'Copied' : 'Copy handoff'}
          </Button>
          <Button size="sm" variant="ghost" icon={DownloadSimpleIcon} onClick={() => downloadText(`braid-handoff-${preview.missionId}.md`, preview.handoff)}>
            Download
          </Button>
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="side-card__body">
        <p className="record__dir mono">{dir}/</p>
        <ul className="record-list">
          {records.map((file) => (
            <li key={file} className="record-row">
              <FileIcon size={14} className="record-row__icon" aria-hidden="true" />
              {merged ? (
                <RouterLink href={paths.code(`${dir}/${file}`, { kind: 'file' })} className="record-row__file mono">
                  {recordLabel(mission, file)}
                </RouterLink>
              ) : (
                <span className="record-row__file mono">{recordLabel(mission, file)}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="record__context">
          <span className="record__context-label">Context</span>
          <span>{context}</span>
        </p>
        {preview.contextAvailable && preview.constraints.length ? (
          <ul className="launch-context__list">
            {preview.constraints.map((item) => (
              <li key={item.id} className="launch-context__item" title={item.body}>
                <KindIcon kind={item.kind} size={14} />
                <span className="launch-context__title">{item.title}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <Collapsible.Root className="notes">
          <DisclosureTrigger>handoff.md</DisclosureTrigger>
          <Collapsible.Panel className="disclosure__panel">
            <pre className="handoff">{preview.handoff}</pre>
          </Collapsible.Panel>
        </Collapsible.Root>
      </LayerCard.Primary>
    </LayerCard>
  );
}
