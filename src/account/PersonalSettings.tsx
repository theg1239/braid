import { LinkButton } from '@cloudflare/kumo';
import { BuildingsIcon } from '@phosphor-icons/react';
import { SitePage } from '../components/shell/SiteBar';
import { RouterLink } from '../components/ui/Link';
import { Row, Section, SettingsEmpty } from '../components/settings/Section';
import { Notifications } from '../components/settings/Notifications';
import { paths } from '../lib/router';
import { useDocumentTitle } from '../lib/title';
import { AccountIdentity, Passkeys } from './AccountSettings';
import { useAccount } from './AccountProvider';
import '../styles/settings.css';
import '../styles/account.css';

export function PersonalSettings({ organizations = false }: { organizations?: boolean }) {
  const { account } = useAccount();
  const title = organizations ? 'Organizations' : 'Account';
  useDocumentTitle(`${title} · Settings · Braid`);
  return <SitePage><div className="page personal-settings">
    <header className="personal-settings__head"><h1>Settings</h1></header>
    <nav className="personal-settings__nav" aria-label="Account settings"><RouterLink href={paths.accountSettings()} aria-current={!organizations ? 'page' : undefined}>Account</RouterLink><RouterLink href={paths.organizations()} aria-current={organizations ? 'page' : undefined}>Organizations</RouterLink></nav>
    <div className="personal-settings__body">{organizations ? <Section id="organizations" title="Organizations" rows aside={account?.signupEnabled ? <LinkButton variant="primary" size="sm" href={paths.newOrganization()}>New organization</LinkButton> : undefined}>
      {account?.organizations.length ? account.organizations.map(org => <Row key={org.id} label={<RouterLink href={paths.owner(org.slug)}><BuildingsIcon size={18} aria-hidden="true" /> {org.name}</RouterLink>} hint={org.slug}><span className="srow__value">{org.role === 'owner' ? 'Owner' : 'Member'}</span></Row>) : <SettingsEmpty>No organizations.</SettingsEmpty>}
    </Section> : <>
      <Section id="account" title="Account" rows><AccountIdentity /></Section>
      {account?.methods.passkeys ? <Section id="passkeys" title="Passkeys" rows><Passkeys /></Section> : null}
      <Notifications userId={account!.user!.id} />
    </>}</div>
  </div></SitePage>;
}
