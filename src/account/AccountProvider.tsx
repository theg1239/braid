import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { accountOwners, type Account, type RepositoryWorkspace, type Organization } from '../../shared/account';
import { errorMessage, request, resetWorkspaceCaches } from '../lib/api';
import { EXAMPLE_ADDRESS, isAppPath, navigate, paths, type Address } from '../lib/router';
import { resetAddresses } from './addresses';
import { loadAccount } from './read';
import { DEMO_SCOPE, readAccountsHint, readSession, writeAccountsHint, writeSession } from './session';

interface AccountValue {
  account: Account | null;
  /** True until the first account read settles. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Account | null>;
  /** People sign in and belong to organizations here. The single-owner deployment has neither. */
  accounts: boolean;
  /** The repository this tab opened last, a repository id or the recorded example, so a link without an address opens it. */
  remembered: string | null;
  remember: (scope: string | null) => void;
  signOut: () => Promise<void>;
  /** An invitation token or agent code waiting for an explicit decision, kept in this tab only. */
  pendingInvite: string | null;
  pendingConnect: string | null;
  settleInvite: () => void;
  settleConnect: () => void;
}

const AccountContext = createContext<AccountValue | null>(null);

function findWorkspace(account: Account | null, id: string | null): { team: Organization; workspace: RepositoryWorkspace } | null {
  if (!account || !id) return null;
  for (const team of accountOwners(account)) {
    const workspace = team.workspaces.find((w) => w.id === id);
    if (workspace) return { team, workspace };
  }
  return null;
}

/** The repository at an address, when the signed-in person belongs to its organization. */
export function findByAddress(account: Account | null, address: Address): { team: Organization; workspace: RepositoryWorkspace } | null {
  const team = accountOwners(account).find((t) => t.slug === address.owner);
  const workspace = team?.workspaces.find((w) => w.slug === address.repo);
  return team && workspace ? { team, workspace } : null;
}

/** A repository's address: the recorded example's, or its organization’s slug and its own. */
export function addressOf(account: Account | null, scope: string | null): Address | null {
  if (scope === DEMO_SCOPE) return EXAMPLE_ADDRESS;
  const found = findWorkspace(account, scope);
  return found ? { owner: found.team.slug, repo: found.workspace.slug } : null;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState(() => readSession('workspace'));
  const [pendingInvite, setPendingInvite] = useState(() => readSession('invite'));
  const [pendingConnect, setPendingConnect] = useState(() => readSession('connect'));
  const reading = useRef<Promise<Account | null> | null>(null);

  const refresh = useCallback(() => reading.current ??= (async () => {
    try {
      const next = await loadAccount();
      setAccount(next);
      setError(null);
      writeAccountsHint(next.provider !== 'owner-key');
      return next;
    } catch (err) {
      setError(errorMessage(err));
      setAccount((previous) => ({
        user: null,
        organizations: [],
        provider: previous?.provider ?? (readAccountsHint() === false ? 'owner-key' : 'github'),
        signupEnabled: false,
        methods: { github: false, email: false, passkeys: false },
      }));
      return null;
    } finally {
      setLoading(false);
      reading.current = null;
    }
  })(), []);

  useEffect(() => {
    let stopped = false;
    // Render as a visitor after the first failure, with one retry in the background.
    void refresh().then((next) => { if (!next && !stopped) void refresh(); });
    return () => { stopped = true; };
  }, [refresh]);

  useEffect(() => {
    if (!error) return;
    const retry = () => { void refresh(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [error, refresh]);

  // Back from signing in on another site: the page the person was on, kept in this tab.
  const user = account?.user ?? null;
  useEffect(() => {
    if (!user) return;
    const next = readSession('next');
    if (!next) return;
    writeSession('next', null);
    if (isAppPath(next)) navigate(next, { replace: true });
  }, [user]);

  const remember = useCallback((next: string | null) => {
    writeSession('workspace', next);
    setRemembered(next);
  }, []);

  const signOut = useCallback(async () => {
    await request('/api/session', { method: 'DELETE' });
    resetWorkspaceCaches();
    resetAddresses();
    remember(null);
    navigate(paths.site());
    await refresh();
  }, [refresh, remember]);

  const settleInvite = useCallback(() => {
    writeSession('invite', null);
    setPendingInvite(null);
  }, []);

  const settleConnect = useCallback(() => {
    writeSession('connect', null);
    setPendingConnect(null);
  }, []);

  // A single-owner deployment has no invitations or agent approvals, so captured links are dropped.
  useEffect(() => {
    if (account?.provider !== 'owner-key') return;
    settleInvite();
    settleConnect();
  }, [account?.provider, settleInvite, settleConnect]);

  const value = useMemo<AccountValue>(
    () => ({
      account,
      loading,
      error,
      refresh,
      accounts: !!account && account.provider !== 'owner-key',
      remembered,
      remember,
      signOut,
      pendingInvite,
      pendingConnect,
      settleInvite,
      settleConnect,
    }),
    [account, loading, error, refresh, remembered, remember, signOut, pendingInvite, pendingConnect, settleInvite, settleConnect],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside AccountProvider.');
  return value;
}
