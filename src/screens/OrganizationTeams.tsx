import { useState, type FormEvent } from 'react';
import { Button, Dialog, Input, Select } from '@cloudflare/kumo';
import { XIcon } from '@phosphor-icons/react';
import type { Organization, OrganizationTeam, RepositoryPermission, TeamDetail, TeamRole } from '../../shared/account';
import { useAccount } from '../account/AccountProvider';
import { accountApi } from '../account/api';
import { Row, Section, SettingsEmpty, SettingsError } from '../components/settings/Section';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { RouterLink } from '../components/ui/Link';
import { SkeletonRows } from '../components/ui/Skeleton';
import { ErrorPanel } from '../components/ui/States';
import { errorMessage } from '../lib/api';
import { setLive, useLive } from '../lib/live';
import { navigate, paths, useRoute } from '../lib/router';
import { plural } from '../lib/format';

const teamsKey = (orgId: string) => `org-teams:${orgId}`;

export function OrganizationTeams({ organization }: { organization: Organization }) {
  const route = useRoute();
  return route.path ? <TeamPage key={`${organization.id}:${route.path}`} organization={organization} slug={route.path} /> : <TeamsList organization={organization} />;
}

function TeamsList({ organization }: { organization: Organization }) {
  const teams = useLive(teamsKey(organization.id), () => accountApi.teams(organization.id), 30_000);
  const [creating, setCreating] = useState(false);
  if (teams.error) return <ErrorPanel title="Couldn’t load teams" message={teams.error} onRetry={() => void teams.refresh()} />;
  if (!teams.data) return <SkeletonRows rows={4} detail height={72} label="Loading teams" />;
  return <>
    <div className="org-section-head"><h2>Teams <span className="owner__count">{teams.data.length}</span></h2>{organization.role === 'owner' ? <Button variant="primary" className="settings-primary" onClick={() => setCreating(true)}>New team</Button> : null}</div>
    <Section id="teams" rows>
      {teams.data.length ? teams.data.map(team => <Row key={team.id} label={<RouterLink href={paths.organizationTeam(organization.slug, team.slug)}>{team.name}</RouterLink>} hint={team.description || undefined}>
        <span className="srow__value">{plural(team.memberCount, 'member')}</span><span className="srow__value">{plural(team.repositoryCount, 'repository', 'repositories')}</span>
      </Row>) : <SettingsEmpty>No teams yet.</SettingsEmpty>}
    </Section>
    <TeamDialog key={creating ? 'new' : 'closed'} open={creating} organization={organization} onClose={() => setCreating(false)} onSaved={async detail => { await teams.refresh(); navigate(paths.organizationTeam(organization.slug, detail.team.slug)); }} />
  </>;
}

function TeamPage({ organization, slug }: { organization: Organization; slug: string }) {
  const route = useRoute();
  const { refresh: refreshAccount } = useAccount();
  const key = `org-team:${organization.id}:${slug}`;
  const sync = () => Promise.all([accountApi.teams(organization.id).then(teams => setLive(teamsKey(organization.id), teams)), refreshAccount()]);
  const result = useLive(key, () => accountApi.team(organization.id, slug), 30_000);
  const people = useLive(`org-roster:${organization.id}`, () => accountApi.roster(organization.id), 30_000);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const repositoriesTab = route.query.get('tab') === 'repositories';
  const change = async (operation: () => Promise<TeamDetail>) => {
    setBusy(true); setError(null);
    try { setLive(key, await operation()); await sync(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  if (result.errorStatus === 404 || result.errorStatus === 403) return <p className="owner__empty">Team not found.</p>;
  if (result.error) return <ErrorPanel title="Couldn’t load team" message={result.error} onRetry={() => void result.refresh()} />;
  if (!result.data) return <SkeletonRows rows={4} detail height={64} label="Loading team" />;
  const detail = result.data, team = detail.team;
  const availablePeople = (people.data?.members ?? []).filter(person => !detail.members.some(member => member.id === person.id));
  const availableRepositories = organization.workspaces.filter(repo => !detail.repositories.some(grant => grant.id === repo.id));
  return <>
    <div className="org-section-head"><div><RouterLink className="owner__address" href={paths.organization(organization.slug, 'teams')}>Teams</RouterLink><h2 className="org-team-name">{team.name}</h2>{team.description ? <p className="owner__description">{team.description}</p> : null}</div>{detail.canManage ? <Button variant="secondary" onClick={() => setEditing(true)}>Edit team</Button> : null}</div>
    <nav className="org-tabs org-tabs--team" aria-label="Team"><RouterLink href={paths.organizationTeam(organization.slug, team.slug)} aria-current={!repositoriesTab ? 'page' : undefined}>Members <span className="owner__count">{detail.members.length}</span></RouterLink><RouterLink href={paths.organizationTeam(organization.slug, team.slug, 'repositories')} aria-current={repositoriesTab ? 'page' : undefined}>Repositories <span className="owner__count">{detail.repositories.length}</span></RouterLink></nav>
    {error ? <p className="org-error"><SettingsError>{error}</SettingsError></p> : null}
    {repositoriesTab ? <Section id="team-repositories" rows aside={detail.canManage ? <Button variant="primary" className="settings-primary" size="sm" disabled={busy || !availableRepositories.length} onClick={() => setAdding(true)}>Add repository</Button> : undefined}>
      {detail.repositories.length ? detail.repositories.map(repo => <Row key={repo.id} label={<RouterLink href={paths.repo({ owner: organization.slug, repo: repo.slug })}>{repo.name}</RouterLink>}>
        {detail.canManage ? <><Select aria-label={`Access to ${repo.name}`} disabled={busy} value={repo.permission} items={[{ value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }]} onValueChange={permission => void change(() => accountApi.setTeamRepository(organization.id, team.id, repo.id, permission as RepositoryPermission))} /><Button variant="ghost" size="sm" disabled={busy} onClick={() => void change(() => accountApi.removeTeamRepository(organization.id, team.id, repo.id))}>Remove</Button></> : <span className="srow__value">{repo.permission === 'write' ? 'Write' : 'Read'}</span>}
      </Row>) : <SettingsEmpty>No repositories.</SettingsEmpty>}
    </Section> : <Section id="team-members" rows aside={detail.canManageMembers ? <Button variant="primary" className="settings-primary" size="sm" disabled={busy || !availablePeople.length} onClick={() => setAdding(true)}>Add member</Button> : undefined}>
      {people.error ? <div className="org-error"><ErrorPanel title="Couldn’t load organization people" message={people.error} onRetry={() => void people.refresh()} /></div> : null}
      {detail.members.length ? detail.members.map(member => <Row key={member.id} label={member.name}>
        {detail.canManageMembers ? <><Select aria-label={`Team role for ${member.name}`} value={member.role} disabled={busy} items={[{ value: 'member', label: 'Member' }, { value: 'maintainer', label: 'Maintainer' }]} onValueChange={role => void change(() => accountApi.setTeamMember(organization.id, team.id, member.id, role as TeamRole))} /><Button variant="ghost" size="sm" disabled={busy} onClick={() => void change(() => accountApi.removeTeamMember(organization.id, team.id, member.id))}>Remove</Button></> : <span className="srow__value">{member.role === 'maintainer' ? 'Maintainer' : 'Member'}</span>}
      </Row>) : <SettingsEmpty>No members.</SettingsEmpty>}
    </Section>}
    {detail.canManage ? <div className="org-team-danger"><Button variant="secondary" onClick={() => setDeleting(true)}>Delete team</Button></div> : null}
    <AddDialog key={`${adding}:${repositoriesTab}`} open={adding} kind={repositoriesTab ? 'repository' : 'member'} options={repositoriesTab ? availableRepositories : availablePeople} onClose={() => setAdding(false)} onAdd={async (id, permission) => {
      const next = repositoriesTab ? await accountApi.setTeamRepository(organization.id, team.id, id, permission as RepositoryPermission) : await accountApi.setTeamMember(organization.id, team.id, id, permission as TeamRole);
      setLive(key, next); setAdding(false); await sync();
    }} />
    <TeamDialog key={`${editing}:${team.id}`} open={editing} organization={organization} team={team} onClose={() => setEditing(false)} onSaved={async detail => { setLive(key, detail); setEditing(false); await sync(); navigate(paths.organizationTeam(organization.slug, detail.team.slug, repositoriesTab ? 'repositories' : undefined), { replace: true }); }} />
    <ConfirmDialog open={deleting} title="Delete team?" description={`Members will lose access granted by ${team.name}.`} confirmLabel="Delete team" onClose={() => setDeleting(false)} onConfirm={async () => {
      await accountApi.deleteTeam(organization.id, team.id); await sync(); navigate(paths.organization(organization.slug, 'teams'));
    }} />
  </>;
}

function AddDialog({ open, kind, options, onClose, onAdd }: { open: boolean; kind: 'member' | 'repository'; options: { id: string; name: string }[]; onClose: () => void; onAdd: (id: string, permission: string) => Promise<void> }) {
  const [id, setId] = useState(options[0]?.id ?? '');
  const [permission, setPermission] = useState(kind === 'repository' ? 'read' : 'member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = kind === 'repository' ? 'Add repository' : 'Add member';
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await onAdd(id, permission); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><Dialog size="base" className="dialog"><form className="dialog__form" onSubmit={submit}>
    <div className="dialog__head"><Dialog.Title className="dialog__title">{label}</Dialog.Title><Button icon={XIcon} shape="square" variant="ghost" aria-label="Close" disabled={busy} onClick={onClose} /></div>
    <Select label={kind === 'repository' ? 'Repository' : 'Organization member'} value={id} disabled={busy} items={options.map(item => ({ value: item.id, label: item.name }))} onValueChange={value => setId(String(value))} />
    <Select label={kind === 'repository' ? 'Permission' : 'Role'} value={permission} disabled={busy} items={kind === 'repository' ? [{ value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }] : [{ value: 'member', label: 'Member' }, { value: 'maintainer', label: 'Maintainer' }]} onValueChange={value => setPermission(String(value))} />
    {error ? <SettingsError>{error}</SettingsError> : null}<div className="dialog__actions"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" className="settings-primary" disabled={!id} loading={busy}>{label}</Button></div>
  </form></Dialog></Dialog.Root>;
}

function TeamDialog({ open, organization, team, onClose, onSaved }: { open: boolean; organization: Organization; team?: OrganizationTeam; onClose: () => void; onSaved: (detail: TeamDetail) => Promise<void> }) {
  const [name, setName] = useState(team?.name ?? '');
  const [slug, setSlug] = useState(team?.slug ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim() || busy) return; setBusy(true); setError(null); try {
    const detail = team ? await accountApi.updateTeam(organization.id, team.id, { name: name.trim(), slug, description }) : await accountApi.createTeam(organization.id, name.trim(), description);
    await onSaved(detail);
  } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><Dialog size="base" className="dialog"><form className="dialog__form" onSubmit={submit}>
    <div className="dialog__head"><Dialog.Title className="dialog__title">{team ? 'Edit team' : 'New team'}</Dialog.Title><Button icon={XIcon} shape="square" variant="ghost" aria-label="Close" disabled={busy} onClick={onClose} /></div>
    <Input label="Team name" value={name} onChange={event => setName(event.target.value)} maxLength={60} required disabled={busy} autoFocus passwordManagerIgnore />
    {team ? <Input label="Team address" value={slug} onChange={event => setSlug(event.target.value)} maxLength={39} required disabled={busy} passwordManagerIgnore /> : null}
    <Input label="Description" value={description} onChange={event => setDescription(event.target.value)} maxLength={500} disabled={busy} passwordManagerIgnore />
    {error ? <SettingsError>{error}</SettingsError> : null}<div className="dialog__actions"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" className="settings-primary" disabled={!name.trim()} loading={busy}>{team ? 'Save changes' : 'Create team'}</Button></div>
  </form></Dialog></Dialog.Root>;
}
