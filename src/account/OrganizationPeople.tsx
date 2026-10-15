import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Collapsible, Dialog, DropdownMenu, Input, Select, useKumoToastManager } from '@cloudflare/kumo';
import { DotsThreeIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import type { Organization, OrganizationInvite, OrganizationRole } from '../../shared/account';
import { errorMessage } from '../lib/api';
import { absoluteTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { SkeletonRows } from '../components/ui/Skeleton';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Row, Section, SettingsEmpty, SettingsError } from '../components/settings/Section';
import { CopyValue } from '../components/settings/CopyValue';
import { useAccount } from './AccountProvider';
import { accountApi, type AuditEntry, type CreatedInvite, type OrganizationRoster } from './api';
import { RelativeTime } from '../components/ui/Time';
import { DisclosureTrigger } from '../components/ui/Disclosure';
import '../styles/account.css';

const ROLE_LABEL: Record<OrganizationRole, string> = { owner: 'Owner', member: 'Member' };
type Removal = { kind: 'member' | 'invite'; id: string; label: string };
const inviteLink = (token: string) => `${window.location.origin}/?invite=${encodeURIComponent(token)}`;

export function OrganizationPeople({ team }: { team: Organization }) {
  const { refresh: refreshAccount } = useAccount();
  const toasts = useKumoToastManager();
  const owner = team.role === 'owner';
  const [roster, setRoster] = useState<OrganizationRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [inviting, setInviting] = useState(false);
  const [replacement, setReplacement] = useState<OrganizationInvite | null>(null);
  // Tokens only exist in this page's memory; the API stores their digests, never retrievable links.
  const [links, setLinks] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try { setRoster(await accountApi.roster(team.id)); setError(null); }
    catch (err) { setError(errorMessage(err)); }
  }, [team.id]);
  useEffect(() => { void load(); }, [load]);
  const created = (invite: CreatedInvite) => {
    setLinks(previous => ({ ...previous, [invite.id]: inviteLink(invite.token) }));
    void load();
  };
  const revoking = removal?.kind === 'invite';
  return <>
    <Section id="members" title="Members" rows aside={owner ? <Button size="sm" variant="primary" onClick={() => setInviting(true)}>Invite</Button> : undefined}>
      {error ? <Row label="Could not load members" hint={<SettingsError>{error}</SettingsError>}><Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></Row> : null}
      {!roster && !error ? <SkeletonRows rows={4} detail height={64} label="Loading people" /> : null}
      {roster?.members.length === 0 ? <SettingsEmpty>No members.</SettingsEmpty> : null}
      {roster?.members.map(member => {
        const self = member.self;
        return <Row compact key={member.id} label={<>{member.name}{self ? <span className="quiet"> (you)</span> : null}</>}>
          {owner ? <Select aria-label={`Role for ${member.name}`} value={member.role} items={[{ value: 'member', label: 'Member' }, { value: 'owner', label: 'Owner' }]} onValueChange={async role => {
            try { await accountApi.updateMember(team.id, member.id, role as OrganizationRole); await Promise.all([load(), refreshAccount()]); }
            catch (err) { setError(errorMessage(err)); }
          }} /> : <span className="srow__value">{ROLE_LABEL[member.role]}</span>}
          {owner && !self ? <DropdownMenu>
            <DropdownMenu.Trigger><Button size="sm" variant="ghost" shape="square" icon={DotsThreeIcon} aria-label={`Actions for ${member.name}`} /></DropdownMenu.Trigger>
            <DropdownMenu.Content align="end"><DropdownMenu.Item icon={TrashIcon} onClick={() => setRemoval({ kind: 'member', id: member.id, label: member.name })}>Remove</DropdownMenu.Item></DropdownMenu.Content>
          </DropdownMenu> : null}
        </Row>;
      })}
    </Section>
    {owner && roster ? <Section id="invites" title="Pending invitations" rows>
      {roster.invites.length ? roster.invites.map(invite => <Row key={invite.id} label={`Invitation ${invite.id.slice(0, 8)}`} hint={`Expires ${absoluteTime(invite.expiresAt)}`}>
        <span className="srow__value">{ROLE_LABEL[invite.role]}</span>
        {links[invite.id] ? <CopyValue value={links[invite.id]} label="invitation link" text /> : <Button size="sm" variant="secondary" onClick={() => setReplacement(invite)}>Replace link</Button>}
        <Button size="sm" variant="ghost" onClick={() => setRemoval({ kind: 'invite', id: invite.id, label: `invitation ${invite.id.slice(0, 8)}` })}>Revoke</Button>
      </Row>) : <SettingsEmpty>No pending invitations.</SettingsEmpty>}
    </Section> : null}
    {owner ? <AuditLog team={team} roster={roster} /> : null}
    <InviteDialog key={inviting ? 'open' : 'closed'} open={inviting} team={team} onClose={() => setInviting(false)} onCreated={created} />
    <ConfirmDialog open={!!replacement} title="Replace invitation link?" description="The previous invitation link will stop working." confirmLabel="Replace link" onClose={() => setReplacement(null)} onConfirm={async () => {
      if (replacement) created(await accountApi.replaceInvite(team.id, replacement.id));
    }} />
    <ConfirmDialog open={!!removal} title={revoking ? 'Revoke this invitation?' : 'Remove this member?'} description={revoking ? `The invitation link for ${removal.label} will stop working.` : `${removal?.label ?? 'This member'} will lose access to every repository in ${team.name}.`} confirmLabel={revoking ? 'Revoke' : 'Remove'} onClose={() => setRemoval(null)} onConfirm={async () => {
      if (!removal) return;
      if (revoking) await accountApi.revokeInvite(team.id, removal.id);
      else await accountApi.removeMember(team.id, removal.id);
      setLinks(previous => { const next = { ...previous }; delete next[removal.id]; return next; });
      toasts.add({ title: revoking ? 'Invitation revoked' : 'Member removed' });
      await Promise.all([load(), refreshAccount()]);
    }} />
  </>;
}

function InviteDialog({ open, team, onClose, onCreated }: { open: boolean; team: Organization; onClose: () => void; onCreated: (invite: CreatedInvite) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!email.trim() || busy) return;
    setBusy(true); setError(null);
    try { const result = await accountApi.invite(team.id, email.trim(), role); setCreated(result); onCreated(result); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <Dialog size="base" className="dialog">
      <form onSubmit={submit} className="dialog__form">
        <div className="dialog__head"><Dialog.Title className="dialog__title">{created ? 'Invitation link' : 'Invite a member'}</Dialog.Title><Dialog.Close render={props => <Button {...props} variant="ghost" size="sm" shape="square" icon={XIcon} aria-label="Close" disabled={busy} />} /></div>
        {created ? <>
          <div className="settings-invite-link"><code>{inviteLink(created.token)}</code><CopyValue value={inviteLink(created.token)} label="invitation link" text /></div>
          <p className="quiet">For {email} · Single use · Expires {absoluteTime(created.expiresAt)}</p>
          <div className="dialog__actions"><Button variant="secondary" onClick={onClose}>Done</Button></div>
        </> : <>
          <Dialog.Description className="dialog__text">Access to every repository in {team.name}.</Dialog.Description>
          <Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} required autoFocus passwordManagerIgnore />
          <Select label="Role" value={role} onValueChange={value => { if (value === 'owner' || value === 'member') setRole(value); }} items={[{ value: 'member', label: 'Member' }, { value: 'owner', label: 'Owner' }]} />
          {error ? <SettingsError>{error}</SettingsError> : null}
          <div className="dialog__actions"><Button variant="ghost" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={busy} disabled={!email.trim()}>Create invite link</Button></div>
        </>}
      </form>
    </Dialog>
  </Dialog.Root>;
}

const ACTIONS: Record<string, string> = {
  'team.created': 'created the organization',
  'team.renamed': 'changed the organization address',
  'team.name-changed': 'changed the organization name',
  'repository.made-private': 'made the repository private',
  'agent.secret-revoked': 'revoked a leaked agent connection',
  'repository.created': 'added a repository',
  'invite.created': 'created an invitation',
  'invite.accepted': 'accepted an invitation',
  'invite.replaced': 'replaced an invitation link',
  'organization-team.created': 'created a team',
  'organization-team.updated': 'updated a team',
  'organization-team.deleted': 'deleted a team',
  'organization-team.member-set': 'updated team membership',
  'organization-team.member-removed': 'removed a team member',
  'organization-team.repository-read': 'granted team read access',
  'organization-team.repository-write': 'granted team write access',
  'organization-team.repository-revoked': 'revoked team repository access',
  'invite.revoked': 'revoked an invitation',
  'member.removed': 'removed a member',
  'member.role-changed': 'changed a member’s role',
  'organization.created': 'created the organization',
  'organization.renamed': 'changed the organization address',
  'organization.name-changed': 'changed the organization name',
};

/** The organization’s own record of membership changes, loaded when an owner opens it. */
function AuditLog({ team, roster }: { team: Organization; roster: OrganizationRoster | null }) {
  const now = useNow();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const what = (entry: AuditEntry) => {
    if (entry.action === 'repository.created') {
      const workspace = team.workspaces.find((w) => w.id === entry.target);
      return workspace ? `added ${workspace.name}` : ACTIONS[entry.action];
    }
    if (entry.action === 'member.removed') {
      const member = roster?.members.find((m) => m.name === entry.target);
      return member ? `removed ${member.name}` : ACTIONS[entry.action];
    }
    return ACTIONS[entry.action] ?? entry.action;
  };

  const load = async () => {
    try {
      setEntries(await accountApi.audit(team.id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Collapsible.Root className="notes" onOpenChange={(open) => open && entries === null && void load()}>
      <DisclosureTrigger>Membership history</DisclosureTrigger>
      <Collapsible.Panel className="disclosure__panel">
        {error ? <SettingsError>{error}</SettingsError> : null}
        {entries === null && !error ? <SkeletonRows rows={4} label="Loading history" /> : null}
        {entries?.length === 0 ? <p className="quiet">No changes recorded yet.</p> : null}
        {entries?.length ? (
          <ol className="audit">
            {entries.map((entry) => (
              <li key={entry.id} className="audit__row">
                <span className="audit__text">
                  <span className="audit__who">{entry.actor}</span> {what(entry)}
                </span>
                <RelativeTime at={entry.createdAt} now={now} className="audit__time" />
              </li>
            ))}
          </ol>
        ) : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
