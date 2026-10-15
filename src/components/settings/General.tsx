import { useState } from 'react';
import { Banner, Button, Dialog, useKumoToastManager } from '@cloudflare/kumo';
import { ArrowCounterClockwiseIcon, DownloadSimpleIcon } from '@phosphor-icons/react';
import type { Visibility } from '../../../shared/account';
import { useAccount } from '../../account/AccountProvider';
import { AddressEditor } from '../../account/AddressEditor';
import { accountApi } from '../../account/api';
import { useRepository } from '../../account/RepositoryGate';
import { api, errorMessage } from '../../lib/api';
import { shortHash } from '../../lib/format';
import { downloadBlob } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { addressPath, navigate, paths } from '../../lib/router';
import { canWrite, useSnapshot, useWorkspace } from '../../store/workspace';
import { RepositoryForm } from '../repo/RepositorySetup';
import { CopyValue } from './CopyValue';
import { InlineEdit } from './InlineEdit';
import { Row, Section, SettingsEmpty, SettingsError } from './Section';
import { VisibilityControl } from './Visibility';

/** The repository's name, address, default branch and backup, then its danger zone. */
export function General() {
  const snapshot = useSnapshot();
  const toasts = useKumoToastManager();
  const [exporting, setExporting] = useState(false);
  const project = snapshot.project;
  const writable = canWrite(snapshot);
  const live = snapshot.capabilities.mode === 'live';

  if (!project.id) {
    return (
      <Section id="repository" title="Repository">
        {writable ? <RepositoryForm /> : <SettingsEmpty>No repository yet.</SettingsEmpty>}
      </Section>
    );
  }

  const backup = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.exportWorkspace();
      downloadBlob(filename ?? `braid-${project.name.replace(/[^a-z0-9-]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.json`, blob);
    } catch (err) {
      toasts.add({ title: 'Backup failed', description: errorMessage(err), variant: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Section id="repository" title="Repository" rows>
        <RepositoryName />
        <AddressRows />
        <Row compact label="Default branch">
          <span className="srow__value mono">
            {project.branch} <span className="quiet">{shortHash(project.head)}</span>
          </span>
        </Row>
        {live ? (
          <Row compact label="Backup">
            <Button variant="secondary" size="sm" icon={DownloadSimpleIcon} loading={exporting} disabled={!writable} title={writable ? undefined : 'A repository owner can download a backup.'} onClick={() => void backup()}>
              Download
            </Button>
          </Row>
        ) : null}
      </Section>
      {snapshot.capabilities.mode === 'demo' ? <DangerZone /> : <RepositoryVisibility />}
    </>
  );
}

function RepositoryName() {
  const snapshot = useSnapshot();
  const { team, workspace, owner } = useRepository();
  const { refresh } = useAccount();
  return <InlineEdit label="Name" value={workspace?.name ?? snapshot.project.name} save={owner && team && workspace ? async name => {
    await accountApi.updateWorkspace(team.id, workspace.id, { name });
    await refresh();
  } : undefined} />;
}

function AddressRows() {
  const { address, team, workspace, owner } = useRepository();
  const { refresh } = useAccount();
  if (!address) return null;
  const url = `${window.location.origin}${addressPath(address)}`;
  const value = <><span className="srow__value mono">{address.owner}/{address.repo}</span><CopyValue value={url} label="address" /></>;
  return owner && team && workspace ? <AddressEditor label="Address" slug={workspace.slug} display={value} save={async slug => {
    const renamed = await accountApi.updateWorkspace(team.id, workspace.id, { slug });
    await refresh();
    navigate(`${addressPath({ ...address, repo: renamed.slug })}/settings/general`, { replace: true });
  }} /> : <Row label="Address">{value}</Row>;
}

function RepositoryVisibility() {
  const { visibility, team, workspace, owner } = useRepository();
  const { refresh } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!visibility) return null;
  const change = async (next: Visibility) => {
    if (!team || !workspace || busy) return;
    setBusy(true); setError(null);
    try {
      await accountApi.updateWorkspace(team.id, workspace.id, { visibility: next });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally { setBusy(false); }
  };
  return <Section id="visibility" title="Danger zone" danger rows>
    <Row label="Change visibility" hint={error ? <SettingsError>{error}</SettingsError> : undefined}>
      {owner && team && workspace ? <VisibilityControl value={visibility} busy={busy} change={change} /> : <span className="srow__value">{visibility === 'public' ? 'Public' : 'Private'}</span>}
    </Row>
  </Section>;
}

/** GitHub's danger zone: in the recorded example, the one destructive action is resetting it. */
function DangerZone() {
  const { refresh } = useWorkspace();
  const toasts = useKumoToastManager();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetDemo();
      setOpen(false);
      toasts.add({ title: 'Example reset' });
      refreshLive('changes');
      refreshLive('queue');
      await refresh();
      navigate(paths.home());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="example" title="Danger zone" danger rows>
      <Row label="Reset the recorded example">
        <Button variant="secondary-destructive" icon={ArrowCounterClockwiseIcon} onClick={() => setOpen(true)}>
          Reset
        </Button>
      </Row>
      <Dialog.Root role="alertdialog" open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <Dialog size="base" className="dialog">
          <div className="dialog__head">
            <Dialog.Title className="dialog__title">Reset the example?</Dialog.Title>
          </div>
          <Dialog.Description className="dialog__text">Your answers and the tasks you started are removed.</Dialog.Description>
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
          <div className="dialog__actions">
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" disabled={busy}>Cancel</Button>} />
            <Button variant="destructive" loading={busy} onClick={() => void reset()}>
              Reset
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </Section>
  );
}
