import { useEffect, useRef, useState } from 'react';
import { Banner, Button, Input, Select } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, CheckIcon, GithubLogoIcon, LockSimpleIcon } from '@phosphor-icons/react';
import type { GitHubConnection, GitHubInstallation, GitHubRepository, GitHubRepositorySelection } from '../../../shared/github';
import { api, errorMessage } from '../../lib/api';

/**
 * The person's GitHub repositories, as Vercel lists them for import: the account, a search box,
 * and one row per repository with its action. `picked` marks a chosen row and `pending` one that
 * is being imported; changing the account clears the choice through `onSelect(null)`.
 */
export function GitHubPicker({ onPick, onSelect, action = 'Select', picked, pending = null, disabled }: {
  onPick?: (selection: GitHubRepositorySelection, repository: GitHubRepository) => void;
  /** A form that keeps its own choice: called with the pick, and with null when the account changes. */
  onSelect?: (selection: GitHubRepositorySelection | null, repository?: GitHubRepository) => void;
  action?: string;
  picked?: number | null;
  pending?: number | null;
  disabled: boolean;
}) {
  const [own, setOwn] = useState<number | null>(null);
  const chosenId = picked === undefined ? own : picked;
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [installation, setInstallation] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [query, setQuery] = useState('');
  const [nextAccounts, setNextAccounts] = useState<number | null>(null);
  const [nextRepositories, setNextRepositories] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const repositoryGeneration = useRef(0);
  const reset = useRef<() => void>(() => {});
  reset.current = () => {
    setOwn(null);
    onSelect?.(null);
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      // Both at once: the accounts usually come back with the connection, saving a round trip. A failed early read is asked again below, where its error shows.
      const [connected, accounts] = await Promise.all([api.githubConnection(), api.githubInstallations().catch(() => null)]);
      if (!alive) return;
      setConnection(connected);
      if (!connected.connected) return;
      const listed = accounts ?? (await api.githubInstallations());
      if (!alive) return;
      setInstallations(listed.items);
      setNextAccounts(listed.nextPage);
      setInstallation((current) => (current && listed.items.some((item) => item.id === current) ? current : (listed.items[0]?.id ?? null)));
    })()
      .catch((err) => alive && setError(errorMessage(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [generation]);

  useEffect(() => {
    const current = ++repositoryGeneration.current;
    setRepositories([]);
    setNextRepositories(null);
    setQuery('');
    reset.current();
    if (!installation) return;
    setBusy(true);
    setError(null);
    void api
      .githubRepositories(installation)
      .then((result) => {
        if (current !== repositoryGeneration.current) return;
        setRepositories(result.items);
        setNextRepositories(result.nextPage);
      })
      .catch((err) => current === repositoryGeneration.current && setError(errorMessage(err)))
      .finally(() => current === repositoryGeneration.current && setBusy(false));
    return () => {
      repositoryGeneration.current++;
    };
  }, [installation, generation]);

  async function authorize(install = false) {
    setBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const result = await (install ? api.installGitHub(returnTo) : api.connectGitHub(returnTo));
      window.location.assign(result.url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function loadMore(accounts: boolean) {
    const current = repositoryGeneration.current;
    setBusy(true);
    setError(null);
    try {
      if (accounts && nextAccounts) {
        const result = await api.githubInstallations(nextAccounts);
        setInstallations((previous) => [...previous, ...result.items]);
        setNextAccounts(result.nextPage);
      } else if (!accounts && installation && nextRepositories) {
        const result = await api.githubRepositories(installation, nextRepositories);
        if (current !== repositoryGeneration.current) return;
        setRepositories((previous) => [...previous, ...result.items]);
        setNextRepositories(result.nextPage);
      }
    } catch (err) {
      if (current === repositoryGeneration.current) setError(errorMessage(err));
    } finally {
      if (current === repositoryGeneration.current) setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectGitHub();
      setConnection({ configured: true, connected: false });
      setInstallations([]);
      setInstallation(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const callback = new URLSearchParams(window.location.search).get('github');
  const notice =
    callback === 'pending' ? (
      <Banner variant="default" size="sm" description="A GitHub organization owner needs to approve the installation. Refresh after they do." />
    ) : callback === 'declined' ? (
      <Banner variant="default" size="sm" description="GitHub authorization was cancelled." />
    ) : null;
  const failure = error ? (
    <div className="gh-picker__error">
      <Banner variant="error" size="sm" description={error} />
      <Button type="button" variant="secondary" size="sm" disabled={busy || disabled} onClick={() => setGeneration((value) => value + 1)}>
        Retry
      </Button>
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="gh-picker">
        <div className="gh-picker__list" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div key={row} className="gh-picker__row gh-picker__row--skeleton">
              <span className="skeleton-line" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!connection?.connected) {
    return (
      <div className="gh-picker">
        {notice}
        <div className="gh-picker__connect">
          {connection?.configured ? (
            <Button type="button" variant="primary" icon={GithubLogoIcon} loading={busy} disabled={disabled} onClick={() => void authorize()}>
              Connect GitHub
            </Button>
          ) : (
            <>
              <GithubLogoIcon size={22} aria-hidden="true" />
              <p>GitHub import is not set up.</p>
            </>
          )}
        </div>
        {failure}
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const visible = repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  const account = installations.find((item) => item.id === installation);

  return (
    <div className="gh-picker">
      {notice}
      {installations.length ? (
        <>
          <div className="gh-picker__bar">
            <Select
              aria-label="GitHub account"
              className="gh-picker__account"
              value={installation ? String(installation) : null}
              disabled={busy || disabled}
              onValueChange={(value) => value && setInstallation(Number(value))}
              renderValue={() => (
                <span className="gh-picker__account-label">
                  <GithubLogoIcon size={15} aria-hidden="true" />
                  {account?.account ?? 'GitHub account'}
                </span>
              )}
              items={installations.map((item) => ({ value: String(item.id), label: item.account }))}
            />
            <Input aria-label="Search repositories" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repositories" passwordManagerIgnore disabled={disabled} />
          </div>
          {nextAccounts ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy || disabled} onClick={() => void loadMore(true)}>
              More accounts
            </Button>
          ) : null}
          <ul className="gh-picker__list" aria-label="GitHub repositories" aria-busy={busy}>
            {visible.map((repo) => {
              const chosen = repo.id === chosenId;
              const importing = repo.id === pending;
              return (
                <li key={repo.id} className="gh-picker__row" data-picked={chosen || undefined}>
                  {repo.private ? <LockSimpleIcon size={16} className="gh-picker__mark" aria-label="Private" /> : <GithubLogoIcon size={16} className="gh-picker__mark" aria-hidden="true" />}
                  <span className="gh-picker__name">
                    <span className="gh-picker__owner">{repo.fullName.slice(0, repo.fullName.length - repo.name.length)}</span>
                    {repo.name}
                  </span>
                  {repo.private ? <span className="gh-picker__private">Private</span> : null}
                  <Button
                    type="button"
                    size="sm"
                    variant={chosen ? 'ghost' : 'secondary'}
                    icon={chosen ? CheckIcon : undefined}
                    loading={importing}
                    aria-pressed={chosen}
                    disabled={busy || disabled || (pending !== null && !importing)}
                    onClick={() => {
                      if (!installation) return;
                      const selection = { installationId: installation, repositoryId: repo.id };
                      setOwn(repo.id);
                      onPick?.(selection, repo);
                      onSelect?.(selection, repo);
                    }}
                  >
                    {chosen ? 'Selected' : action}
                  </Button>
                </li>
              );
            })}
            {!visible.length ? (
              <li className="gh-picker__row gh-picker__row--empty" role="status">
                {busy ? 'Loading repositories…' : needle ? `No repository matches “${query.trim()}”.` : 'No repositories are shared with Braid yet.'}
              </li>
            ) : null}
            {nextRepositories ? (
              <li className="gh-picker__more">
                <Button type="button" variant="ghost" size="sm" loading={busy} disabled={disabled} onClick={() => void loadMore(false)}>
                  Load more
                </Button>
              </li>
            ) : null}
          </ul>
        </>
      ) : (
        <div className="gh-picker__connect">
          <Button type="button" variant="primary" icon={GithubLogoIcon} disabled={busy || disabled} onClick={() => void authorize(true)}>
            Install on GitHub
          </Button>
        </div>
      )}
      <div className="gh-picker__foot">
        <span>
          GitHub: {connection.login}
          <button type="button" className="gh-picker__link" disabled={busy || disabled} onClick={() => void disconnect()}>
            Disconnect
          </button>
        </span>
        <span>
          {installations.length ? (
            <button type="button" className="gh-picker__link" disabled={busy || disabled} onClick={() => void authorize(true)}>
              Change access
            </button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" shape="square" icon={ArrowClockwiseIcon} aria-label="Refresh" disabled={busy || disabled} onClick={() => setGeneration((value) => value + 1)} />
        </span>
      </div>
      {failure}
    </div>
  );
}
