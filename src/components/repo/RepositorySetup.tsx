import { useState, type FormEvent } from 'react';
import { Banner, Button, Input, LinkButton, Tabs, useKumoToastManager } from '@cloudflare/kumo';
import { FolderSimpleDashedIcon, GithubLogoIcon, LinkSimpleIcon, PlayCircleIcon, TerminalWindowIcon, UserPlusIcon } from '@phosphor-icons/react';
import { api, errorMessage, type CreateProjectInput } from '../../lib/api';
import { useIdempotencyKey, useNow } from '../../lib/hooks';
import { navigate, paths } from '../../lib/router';
import { useDocumentTitle } from '../../lib/title';
import { canWrite, useSnapshot, useWorkspace } from '../../store/workspace';
import { EmptyPanel } from '../ui/States';
import { repositoryUrlError } from '../../../shared/repository-url';
import type { GitHubRepository, GitHubRepositorySelection } from '../../../shared/github';
import type { ProjectImport } from '../../../shared/types';
import { useAccount } from '../../account/AccountProvider';
import { useRepository } from '../../account/RepositoryGate';
import { GitHubPicker } from './GitHubPicker';
import { repositoryName } from './name';
import '../../styles/new.css';

/** The server's rule for Artifacts repository names. */
const NAME = /^[a-z][a-z0-9-]{1,47}$/;
const NAME_CHARACTERS = /^[a-z][a-z0-9-]*$/;

type RepositorySource = 'github' | 'sample' | 'import';

/**
 * Creates the repository's code: imported, or the sample. Code that is ready at once opens; an
 * import still copying is followed on Code, which shows it until the repository opens. Retrying
 * after a dropped connection reuses the request key.
 */
function useCreateProject() {
  const { refresh } = useWorkspace();
  const { refresh: refreshAccount } = useAccount();
  const toasts = useKumoToastManager();
  const attempt = useIdempotencyKey();
  return async (input: CreateProjectInput, source: RepositorySource) => {
    try {
      const created = await api.createProject(input, attempt.key(input));
      attempt.settle();
      if (!('importing' in created)) toasts.add({ title: source === 'sample' ? 'Sample added' : 'Repository imported', description: created.name, variant: 'success' });
      await Promise.all([refresh(), refreshAccount()]);
      navigate(paths.home());
    } catch (err) {
      attempt.settle(err);
      throw err;
    }
  };
}

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/** An import still copying, where its source cannot be shown meanwhile: where from and for how long, until the repository opens. */
function ImportProgress({ importing, canRetry, canInvite, onChoose }: { importing: ProjectImport; canRetry: boolean; canInvite: boolean; onChoose: () => void }) {
  const { refresh } = useWorkspace();
  const now = useNow(1000);
  const attempt = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromGitHub = !importing.source.includes('://');

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retryImport(attempt.key({ retry: importing.startedAt }));
      attempt.settle();
      await refresh();
    } catch (err) {
      attempt.settle(err);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="add-code" aria-labelledby="import-title" aria-live="polite">
        <div className="importing">
          <div className="importing__head">
            {fromGitHub ? <GithubLogoIcon size={18} aria-hidden="true" /> : <LinkSimpleIcon size={18} aria-hidden="true" />}
            <h1 id="import-title">
              {importing.error ? 'Import stopped' : 'Importing'} <span className="importing__source">{importing.source}</span>
            </h1>
            {importing.error ? null : <span className="importing__time">{elapsed(now - Date.parse(importing.startedAt))}</span>}
          </div>
          {importing.error ? <p className="importing__line">{importing.error}</p> : <div className="importing__bar" role="progressbar" aria-label="Importing" />}
          {importing.error && canRetry ? (
            <div className="importing__actions">
              <Button variant="primary" loading={busy} onClick={() => void retry()}>
                Try again
              </Button>
              <Button variant="secondary" disabled={busy} onClick={onChoose}>
                Choose another
              </Button>
            </div>
          ) : canRetry ? (
            <div className="importing__actions">
              <LinkButton variant="secondary" size="sm" icon={TerminalWindowIcon} href={paths.settings('agents')}>
                Connect an agent
              </LinkButton>
              {canInvite ? (
                <LinkButton variant="secondary" size="sm" icon={UserPlusIcon} href={paths.settings('collaborators')}>
                  Invite collaborators
                </LinkButton>
              ) : null}
            </div>
          ) : null}
          {error ? <Banner variant="error" size="sm" description={error} /> : null}
        </div>
      </section>
    </div>
  );
}

/**
 * Settings' form for the single-owner deployment, where a repository has no address to take its
 * name from: the name, then where the code comes from.
 */
export function RepositoryForm() {
  const { account } = useAccount();
  const create = useCreateProject();
  const hasGitHub = account?.provider === 'github';
  const [source, setSource] = useState<RepositorySource>(hasGitHub ? 'github' : 'import');
  const [github, setGitHub] = useState<GitHubRepositorySelection | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = name && !NAME_CHARACTERS.test(name) ? 'Start with a letter, then use lowercase letters, digits and hyphens.' : undefined;
  const urlError = url.trim() ? repositoryUrlError(url.trim()) : undefined;
  const ready = NAME.test(name) && (source === 'sample' || (source === 'github' ? !!github : !!url.trim() && !urlError));
  // The picker sends null when the account changes, which clears the choice.
  const select = (selection: GitHubRepositorySelection | null, repo?: GitHubRepository) => {
    setGitHub(selection);
    if (!repo) return;
    setName(repositoryName(repo.name));
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create({ name, sourceUrl: source === 'import' ? url.trim() : undefined, github: source === 'github' ? github! : undefined }, source);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <Tabs
        variant="segmented"
        value={source}
        onValueChange={(value) => {
          if (!busy) {
            setSource(value as RepositorySource);
            setError(null);
          }
        }}
        tabs={[...(hasGitHub ? [{ value: 'github', label: 'GitHub' }] : []), { value: 'import', label: 'URL' }, { value: 'sample', label: 'Sample' }]}
      />
      {source === 'github' ? <GitHubPicker onSelect={select} picked={github?.repositoryId ?? null} disabled={busy} /> : null}
      {source === 'import' ? (
        <Input label="Git URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" error={urlError} variant={urlError ? 'error' : 'default'} maxLength={500} passwordManagerIgnore />
      ) : null}
      <Input label="Name" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="webhook-relay" maxLength={48} error={nameError} variant={nameError ? 'error' : 'default'} passwordManagerIgnore />
      {error ? <Banner variant="error" size="sm" description={error} /> : null}
      <div className="settings-form__actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
          {source === 'sample' ? 'Use the sample' : 'Import repository'}
        </Button>
      </div>
    </form>
  );
}

/**
 * An empty repository's first page, for its owners: bring the code in. A GitHub repository
 * imports in one click; a public URL or the sample in one more. The repository's name and who
 * can see it were chosen when it was created, so nothing here asks again; a private GitHub
 * repository keeps it private. Everyone else sees that it is empty.
 */
export function RepositorySetup() {
  const snapshot = useSnapshot();
  const { account } = useAccount();
  const repository = useRepository();
  const create = useCreateProject();
  const writable = canWrite(snapshot);
  const hasGitHub = account?.provider === 'github';
  const title = repository.workspace?.name ?? repository.address?.repo ?? 'this repository';
  const fixedName = repository.workspace ? repositoryName(repository.workspace.slug) : null;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<'url' | 'sample' | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A stopped import can give way to another source: the server releases it when Artifacts kept nothing.
  const [choosing, setChoosing] = useState(false);
  const projectName = fixedName ?? name;
  const nameReady = NAME.test(projectName);
  const urlError = url.trim() ? repositoryUrlError(url.trim()) : undefined;

  useDocumentTitle(`${snapshot.importing ? 'Importing' : 'Add code'} · ${title}`);

  if (snapshot.importing && !(snapshot.importing.error && choosing))
    return <ImportProgress importing={snapshot.importing} canRetry={writable} canInvite={!!repository.team && repository.owner} onChoose={() => setChoosing(true)} />;
  if (!writable) {
    return (
      <div className="page">
        <EmptyPanel size="base" icon={<FolderSimpleDashedIcon size={36} />} title="This repository is empty" />
      </div>
    );
  }

  const run = async (key: 'url' | 'sample' | number, input: Omit<CreateProjectInput, 'name'>, source: RepositorySource, fallbackName?: string) => {
    const chosen = fixedName ?? (name || (fallbackName ? repositoryName(fallbackName) : ''));
    if (!NAME.test(chosen) || pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await create({ name: chosen, ...input }, source);
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  };
  const busy = pending !== null;

  return (
    <div className="page">
      <section className="add-code" aria-labelledby="add-code-title">
        <header className="add-code__head">
          <h1 id="add-code-title">Add code to {title}</h1>
        </header>
        {fixedName ? null : (
          <Input label="Name" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="webhook-relay" maxLength={48} passwordManagerIgnore />
        )}
        {error ? <Banner variant="error" size="sm" description={error} /> : null}
        {hasGitHub ? (
          <section className="add-code__card" aria-labelledby="add-code-github">
            <h2 id="add-code-github">
              <GithubLogoIcon size={16} aria-hidden="true" />
              Import from GitHub
            </h2>
            <GitHubPicker
              action="Import"
              pending={typeof pending === 'number' ? pending : null}
              disabled={busy}
              onPick={(selection, repo) => void run(selection.repositoryId, { github: selection }, 'github', repo.name)}
            />
          </section>
        ) : null}
        <section className="add-code__card" aria-labelledby="add-code-url">
          <h2 id="add-code-url">
            <LinkSimpleIcon size={16} aria-hidden="true" />
            Import from a URL
          </h2>
          <form
            className="add-code__inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim() && !urlError) void run('url', { sourceUrl: url.trim() }, 'import', url.trim().split('/').filter(Boolean).pop()?.replace(/\.git$/, ''));
            }}
          >
            <Input aria-label="Git URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" error={urlError} variant={urlError ? 'error' : 'default'} maxLength={500} passwordManagerIgnore disabled={busy} />
            <Button type="submit" variant="secondary" loading={pending === 'url'} disabled={busy || !url.trim() || !!urlError}>
              Import
            </Button>
          </form>
        </section>
        <section className="add-code__card add-code__card--row" aria-labelledby="add-code-sample">
          <h2 id="add-code-sample">
            <PlayCircleIcon size={16} aria-hidden="true" />
            Start from the sample
          </h2>
          <Button variant="secondary" loading={pending === 'sample'} disabled={busy || (!fixedName && !nameReady)} onClick={() => void run('sample', {}, 'sample')}>
            Use the sample
          </Button>
        </section>
      </section>
    </div>
  );
}

/** For pages that need a repository: points owners to Code, where the code comes in. */
export function NoRepositoryPanel() {
  const snapshot = useSnapshot();
  return (
    <EmptyPanel
      size="base"
      icon={<FolderSimpleDashedIcon size={36} />}
      title="This repository is empty"
      action={
        canWrite(snapshot) ? (
          <LinkButton variant="primary" href={paths.home()}>
            Add code
          </LinkButton>
        ) : undefined
      }
    />
  );
}
