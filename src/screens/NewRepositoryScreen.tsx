import { useState, type FormEvent } from 'react';
import { Banner, Button, Input, LinkButton, Select, useKumoToastManager } from '@cloudflare/kumo';
import { accountOwners, type Visibility } from '../../shared/account';
import { slugOf } from '../../shared/routes';
import { useAccount } from '../account/AccountProvider';
import { accountApi } from '../account/api';
import { VisibilityChoice } from '../account/VisibilityChoice';
import { errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/title';
import { navigate, paths, useRoute } from '../lib/router';
import '../styles/new.css';

/**
 * A new repository, as GitHub asks for one: the owner and the name, then who can see it. The code
 * comes in on the repository's own first page, imported from GitHub or a URL, or the sample.
 */
export function NewRepositoryScreen() {
  const { account, refresh } = useAccount();
  const route = useRoute();
  const importing = route.query.get('import') === '1';
  const toasts = useKumoToastManager();
  const teams = accountOwners(account).filter((team) => team.role === 'owner');
  const wanted = route.query.get('org') ?? route.query.get('team');
  const [teamId, setTeamId] = useState(() => (teams.find((team) => team.slug === wanted) ?? teams[0])?.id ?? '');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = teams.find((item) => item.id === teamId) ?? teams[0];
  const slug = slugOf(name);
  const taken = !!team && team.workspaces.some((workspace) => workspace.slug === slug);

  useDocumentTitle(`${importing ? 'Import repository' : 'New repository'} · Braid`);

  if (!team) return <div className="page new-repo"><LinkButton variant="primary" href={paths.pickUsername()}>Pick a username</LinkButton></div>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || taken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await accountApi.createWorkspace(team.id, name.trim(), visibility);
      toasts.add({ title: 'Repository created', description: `${team.slug}/${workspace.slug}`, variant: 'success' });
      await refresh();
      navigate(paths.repo({ owner: team.slug, repo: workspace.slug }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="page new-repo">
      <header className="new-repo__head">
        <h1>{importing ? 'Import repository' : 'New repository'}</h1>
      </header>
      <form className="new-repo__card" onSubmit={submit}>
        <div className="new-repo__address">
          <div className="new-repo__owner">
            <span className="new-repo__label" id="new-repo-owner">
              Owner
            </span>
            {teams.length > 1 ? (
              <Select aria-labelledby="new-repo-owner" value={team.id} disabled={busy} onValueChange={(value) => value && setTeamId(String(value))} items={teams.map((item) => ({ value: item.id, label: item.kind === 'user' ? `@${item.slug} (you)` : item.slug }))} />
            ) : (
              <span className="new-repo__team">{team.kind === 'user' ? `@${team.slug} (you)` : team.slug}</span>
            )}
          </div>
          <span className="new-repo__slash" aria-hidden="true">
            /
          </span>
          <Input
            label="Repository name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            autoFocus
            passwordManagerIgnore
            disabled={busy}
            error={taken ? `${team.name} already has ${slug}.` : undefined}
            variant={taken ? 'error' : 'default'}
          />
        </div>
        {slug && !taken ? (
          <p className="new-repo__preview">
            {window.location.host}/{team.slug}/<b>{slug}</b>
          </p>
        ) : null}
        <VisibilityChoice personal={team.kind === 'user'} value={visibility} onChange={setVisibility} disabled={busy} />
        {error ? <Banner variant="error" size="sm" description={error} /> : null}
        <div className="new-repo__actions">
          <Button variant="ghost" disabled={busy} onClick={() => (window.history.length > 1 ? window.history.back() : navigate(paths.site()))}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || taken}>
            Create repository
          </Button>
        </div>
      </form>
    </div>
  );
}
