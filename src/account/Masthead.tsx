import { Button, DropdownMenu, LinkButton, useKumoToastManager } from '@cloudflare/kumo';
import { BuildingsIcon, CaretDownIcon, GearSixIcon, PlusIcon, SignOutIcon, TrayIcon, UserCircleIcon } from '@phosphor-icons/react';
import { errorMessage } from '../lib/api';
import { paths, useRoute } from '../lib/router';
import { useInbox } from '../dashboard/inbox';
import { CREATE_LINKS } from '../components/shell/HeaderLinks';
import { SiteSearch } from '../components/shell/SiteSearch';
import { Avatar } from '../components/ui/Avatar';
import { useAccount } from './AccountProvider';
import '../styles/header.css';

function CreateItems() {
  return CREATE_LINKS.map(item => <DropdownMenu.LinkItem key={item.label} href={item.href()} icon={item.icon}>{item.label}</DropdownMenu.LinkItem>);
}

/** The dashboard and this badge subscribe to the same inbox, including its in-flight read. */
export function AccountControls() {
  const { account } = useAccount();
  const { needsYou } = useInbox(account);
  const route = useRoute();
  if (!account?.user) return null;
  const label = needsYou ? `Inbox: ${needsYou} pull request${needsYou === 1 ? ' needs' : 's need'} you` : 'Inbox';
  return <>
    <div className="global-head__desktop">
      <DropdownMenu>
        <DropdownMenu.Trigger><Button variant="secondary" className="global-head__create" aria-label="Create"><PlusIcon size={18} aria-hidden="true" /><CaretDownIcon size={12} aria-hidden="true" /></Button></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end"><CreateItems /></DropdownMenu.Content>
      </DropdownMenu>
    </div>
    <LinkButton variant="secondary" href={paths.site()} className="global-head__inbox" aria-label={label} title={label}><TrayIcon size={18} aria-hidden="true" />{needsYou > 0 ? <span className="global-head__count">{needsYou}</span> : null}</LinkButton>
    <AccountMenu needsYou={needsYou} />
    {!route.repo ? <SiteSearch key={route.href} /> : null}
  </>;
}

/** A GitHub avatar or a neutral person; identity and account links live in the menu. */
export function AccountMenu({ needsYou = 0 }: { needsYou?: number }) {
  const { account, signOut } = useAccount();
  const toasts = useKumoToastManager();
  const user = account?.user;
  if (!user) return null;
  // Older email accounts used their email as their display name; never put it in the masthead.
  const name = user.name === user.email ? '' : user.name;
  const identity = user.username ? `@${user.username}` : name || 'Your account';
  return <DropdownMenu>
    <DropdownMenu.Trigger>
      <button type="button" className="header-account-button" aria-label={`Account: ${identity}`}>
        <Avatar src={user.avatarUrl} size={28} fallback={<UserCircleIcon size={28} aria-hidden="true" />} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" className="header-account-menu">
      <DropdownMenu.Group>
        <DropdownMenu.Label>
          <span className="header-account-menu__identity">{identity}</span>
          {user.username && name ? <span className="header-account-menu__name">{name}</span> : null}
        </DropdownMenu.Label>
        {user.username ? <DropdownMenu.LinkItem href={paths.owner(user.username)} icon={UserCircleIcon}>Your profile</DropdownMenu.LinkItem> : <DropdownMenu.LinkItem href={paths.pickUsername()} icon={UserCircleIcon}>Pick a username</DropdownMenu.LinkItem>}
        <DropdownMenu.LinkItem href={paths.organizations()} icon={BuildingsIcon}>Your organizations</DropdownMenu.LinkItem>
        <DropdownMenu.LinkItem href={paths.accountSettings()} icon={GearSixIcon}>Settings</DropdownMenu.LinkItem>
      </DropdownMenu.Group>
      <DropdownMenu.Group className="global-head__mobile">
        <DropdownMenu.Separator />
        <DropdownMenu.LinkItem href={paths.site()} icon={TrayIcon}>Inbox{needsYou > 0 ? <span className="global-head__count">{needsYou}</span> : null}</DropdownMenu.LinkItem>
        <CreateItems />
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={SignOutIcon} onClick={async () => {
        try { await signOut(); }
        catch (err) { toasts.add({ title: 'Sign out failed', description: errorMessage(err), variant: 'error' }); }
      }}>Sign out</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>;
}
