import { Suspense, lazy, type ReactNode } from 'react';
import { LoadingShell } from '../components/ui/LoadingShell';
import { paths, useRoute } from '../lib/router';
import type { Account } from '../../shared/account';
import type { Route } from '../lib/router';
import { useAccount } from './AccountProvider';

// Sign-in, invitations, organization setup and agent approval are one chunk that single-owner deployments never load.
export const SignIn = lazy(() => import('./SignIn').then((m) => ({ default: m.SignIn })));
const InviteAccept = lazy(() => import('./InviteAccept').then((m) => ({ default: m.InviteAccept })));
const PickUsername = lazy(() => import('./Username').then(m => ({ default: m.PickUsername })));
const PersonalSettings = lazy(() => import('./PersonalSettings').then(m => ({ default: m.PersonalSettings })));
const ConnectApproval = lazy(() => import('./ConnectApproval').then((m) => ({ default: m.ConnectApproval })));

/** Public pages and the recorded example never wait for account setup. */
export function needsUsername(account: Account | null, route: Route): boolean {
  return !!account?.user && account.user.username === null && ['home', 'signin', 'new', 'new-organization', 'account', 'organizations'].includes(route.screen);
}

/**
 * What this person sees before any page: the first account attempt, or an invitation or agent
 * request waiting for their answer, which takes the whole page until it is settled. Everything else
 * is the router's: the URL decides the page and the repository.
 */
export function AccountGate({ children }: { children: ReactNode }) {
  const { account, loading, accounts, pendingInvite, pendingConnect } = useAccount();
  const route = useRoute();
  if (loading) return <LoadingShell />;
  const gate = accounts ? accountPage(account, route, pendingInvite, !!pendingConnect) : null;
  return gate ? <Suspense fallback={<LoadingShell />}>{gate}</Suspense> : <>{children}</>;
}

/** The page that waits for this person on a deployment with accounts, or null when the route decides. */
function accountPage(account: Account | null, route: Route, invite: string | null, connect: boolean): ReactNode {
  const user = account?.user;
  if (route.screen === 'signin' && route.query.get('confirm') === '1') return <SignIn next={route.query.get('next')} confirm />;
  if (needsUsername(account, route) || route.screen === 'username') return user ? <PickUsername next={['home', 'signin', 'username'].includes(route.screen) ? paths.newRepository() : route.href} /> : <SignIn next={route.href} />;
  if (route.screen === 'account' || route.screen === 'organizations') return user ? <PersonalSettings organizations={route.screen === 'organizations'} /> : <SignIn next={route.href} />;
  if (invite || connect && route.screen !== 'new') return !user ? <SignIn /> : invite ? <InviteAccept /> : <ConnectApproval />;
  return null;
}
