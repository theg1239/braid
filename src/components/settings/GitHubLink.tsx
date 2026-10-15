import { useCallback, useState } from 'react';
import { Banner, Button, Radio, useKumoToastManager } from '@cloudflare/kumo';
import { LinkBreakIcon, LinkIcon } from '@phosphor-icons/react';
import type { GitHubLinkStatus } from '../../../shared/types';
import type { GitHubRepositorySelection } from '../../../shared/github';
import { changes, errorMessage } from '../../lib/api';
import { queueInterval } from '../../lib/lists';
import { refreshLive, setLive, useLive } from '../../lib/live';
import { canWrite, useSnapshot } from '../../store/workspace';
import { useAccount } from '../../account/AccountProvider';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { GitHubPicker } from '../repo/GitHubPicker';
import { GitHubSummary } from './GitHubSummary';
import { Row, Section, SettingsEmpty } from './Section';

/**
 * Links this repository to one on GitHub. With pull requests, every landing goes through a
 * pull request there, so GitHub's checks, review apps and branch protection apply; with
 * mirror, main is pushed there after it lands here. Linking needs a signed-in owner.
 */
export function GitHubLinkSection() {
  const snapshot = useSnapshot();
  const { accounts, account } = useAccount();
  const toasts = useKumoToastManager();
  const live = snapshot.capabilities.mode === 'live';
  const writable = canWrite(snapshot);
  const available = live && accounts && !!account?.user;
  const link = useLive(available ? 'github:link' : null, changes.githubLink, 30_000);
  const queue = useLive('queue', changes.queue, queueInterval);
  const status: GitHubLinkStatus | null = link.data ?? queue.data?.github ?? null;
  const [selection, setSelection] = useState<GitHubRepositorySelection | null>(null);
  const [mode, setMode] = useState<GitHubLinkStatus['mode']>('pull-requests');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const select = useCallback((next: GitHubRepositorySelection | null) => {
    setSelection(next);
    setError(null);
  }, []);

  const submit = async () => {
    if (!selection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const linked = await changes.linkGitHub(selection, mode);
      setLive('github:link', linked);
      refreshLive('queue');
      toasts.add({ title: 'Repository linked', description: linked.fullName, variant: 'success' });
      setSelection(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (available && !status && (link.loading || queue.loading)) return <Section id="github" title="GitHub repository" rows><SettingsEmpty>Loading GitHub repository…</SettingsEmpty></Section>;

  return (
    <Section id="github" title="GitHub repository" rows={!!status || !(available && writable)}>
      {status ? (
        <>
          <GitHubSummary link={status} recorded={!live} />
          {available && writable ? (
            <Row label="Unlink" hint="Nothing on GitHub is deleted">
              <Button variant="secondary-destructive" size="sm" icon={LinkBreakIcon} onClick={() => setUnlinking(true)}>
                Unlink
              </Button>
            </Row>
          ) : null}
          <ConfirmDialog
            open={unlinking}
            title={`Unlink ${status.fullName}?`}
            description="Merges stop going through GitHub."
            confirmLabel="Unlink"
            onConfirm={async () => {
              await changes.unlinkGitHub();
              setLive('github:link', null);
              refreshLive('queue');
              toasts.add({ title: 'Repository unlinked' });
            }}
            onClose={() => setUnlinking(false)}
          />
        </>
      ) : available && writable ? (
        <div className="settings-form settings-form--wide">
          <Radio.Group legend="How merges reach GitHub" value={mode} onValueChange={(value) => setMode(value as GitHubLinkStatus['mode'])} appearance="card" className="link-modes">
            <Radio.Item value="pull-requests" label="Pull requests" description="GitHub’s checks and reviews apply" />
            <Radio.Item value="mirror" label="Mirror" description="Main is pushed after each merge" />
          </Radio.Group>
          <GitHubPicker onSelect={select} disabled={busy} />
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
          <div className="settings-form__actions">
            <Button variant="primary" icon={LinkIcon} loading={busy} disabled={!selection} onClick={() => void submit()}>
              Link repository
            </Button>
          </div>
        </div>
      ) : (
        <Row label="Repository" hint={link.error && link.errorStatus !== 404 ? link.error : undefined}>
          <span className="srow__value">Not linked</span>
        </Row>
      )}
    </Section>
  );
}
