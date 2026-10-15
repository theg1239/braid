import { Fragment, Suspense, createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { RepositoryWorkspace, Organization, Visibility } from '../../shared/account';
import { setPublicPolling } from '../lib/polling';
import { setWorkspaceScope } from '../lib/api';
import { EXAMPLE_ADDRESS, addressPath, isExample, navigate, sameAddress, setRouteBase, type Address, type Route, type Screen } from '../lib/router';
import { NotFound, SitePage } from '../components/shell/SiteBar';
import { ErrorPanel } from '../components/ui/States';
import { LoadingShell } from '../components/ui/LoadingShell';
import { addressOf, findByAddress, useAccount } from './AccountProvider';
import { useRepositoryAddress } from './addresses';
import { DEMO_SCOPE } from './session';
import { isMirrorFailure, MIRROR_NOT_FOUND, MirrorContext } from './mirrors';
import { MirrorError } from '../components/repo/MirrorError';
import { lazyComponent } from '../lib/lazy';

const ClaimOwner = lazyComponent(() => import('./ClaimOwner'), m => m.ClaimOwner).Component;

/** The repository the page is on, for the header, settings and every link in it. */
interface RepositoryValue {
  /** What workspace requests are scoped to: a repository id, the recorded example, or null on the single-owner deployment. */
  scope: string | null;
  /** Where the repository lives; every link in it starts with its path, and null on the single-owner deployment. */
  address: Address | null;
  visibility: Visibility | null;
  /** The repository and its organization, when the signed-in person belongs to it. */
  team: Organization | null;
  workspace: RepositoryWorkspace | null;
  /** Whether this person owns the organization, so they may change the repository's settings. */
  owner: boolean;
}

const RepositoryContext = createContext<RepositoryValue | null>(null);

export function useRepository(): RepositoryValue {
  const value = useContext(RepositoryContext);
  if (!value) throw new Error('useRepository must be used inside RepositoryGate.');
  return value;
}

const FLAT: RepositoryValue = { scope: null, address: null, visibility: null, team: null, workspace: null, owner: false };
const EXAMPLE: RepositoryValue = { scope: DEMO_SCOPE, address: EXAMPLE_ADDRESS, visibility: 'public', team: null, workspace: null, owner: false };

/**
 * The URL decides the repository. An address is the recorded example's, one of the person's own, or
 * one asked of the server; a link without an address opens the repository this tab remembers. The
 * workspace renders with its scope set, so its first request goes to the right repository.
 */
export function RepositoryGate({ route, children }: { route: Route; children: (screen: Screen) => ReactNode }) {
  const { account, accounts } = useAccount();
  const resolved = useRef<string | null>(null);
  const viewer = account?.user?.id ?? null;
  const screen: Screen = route.screen === 'home' ? 'code' : route.screen;
  if (!accounts) {
    // The single-owner deployment has one repository and flat routes; only the example has an address.
    if (screen === 'username' || screen === 'organizations') return <NotFound kind="page" />;
    if (route.repo && !isExample(route.repo)) return <NotFound kind="repository" />;
    return (
      <Repository value={route.repo ? EXAMPLE : FLAT} viewer={null}>
        {children(screen === 'account' ? 'settings' : screen)}
      </Repository>
    );
  }
  if (!route.repo) return <ToAddress route={route} />;
  if (isExample(route.repo)) {
    return (
      <Repository value={EXAMPLE} viewer={viewer}>
        {children(screen)}
      </Repository>
    );
  }
  const known = findByAddress(account, route.repo);
  // Claiming must not replace the mounted repository with another provider tree.
  if (!known || known.workspace.canWrite === false) resolved.current = addressPath(route.repo);
  if (known && known.workspace.canWrite !== false && resolved.current !== addressPath(route.repo)) {
    const value: RepositoryValue = { scope: known.workspace.id, address: route.repo, visibility: known.workspace.visibility, team: known.team, workspace: known.workspace, owner: known.team.role === 'owner' };
    return (
      <Repository value={value} viewer={viewer}>
        {children(screen)}
      </Repository>
    );
  }
  return (
    <Resolved address={route.repo} viewer={viewer} known={known}>
      {children(screen)}
    </Resolved>
  );
}

/** A link without an address, from before repositories had them: it opens in the repository this tab remembers, or the example. */
function ToAddress({ route }: { route: Route }) {
  const { account, remembered } = useAccount();
  const address = addressOf(account, remembered) ?? EXAMPLE_ADDRESS;
  const target = `${addressPath(address)}${route.href === '/' ? '' : route.href}`;
  useEffect(() => {
    navigate(target, { replace: true });
  }, [target]);
  return <LoadingShell />;
}

/** A repository the account does not list: public, or not for this viewer. */
function Resolved({ address, viewer, children, known }: { address: Address; viewer: string | null; children: ReactNode; known: ReturnType<typeof findByAddress> }) {
  const result = useRepositoryAddress(address);
  if (result.status === 'loading') return <LoadingShell />;
  // A Braid organization that holds a GitHub name keeps its GitHub repositories out until its owner links it.
  if (result.status === 'missing') return <NotFound kind="repository">{viewer ? <Suspense fallback={null}><ClaimOwner slug={address.owner} /></Suspense> : null}</NotFound>;
  if (result.status === 'error') {
    if (isMirrorFailure(result.code)) return <SitePage><MirrorError message={result.message} code={result.code} signIn={result.code === MIRROR_NOT_FOUND && !viewer} address={address} /></SitePage>;
    return (
      <SitePage>
        <div className="page">
          <ErrorPanel page title="Unable to load repository" message={result.message} onRetry={result.retry} />
        </div>
      </SitePage>
    );
  }
  const found = result.address;
  const canonical = { owner: found.owner.slug, repo: found.repo.slug };
  const value: RepositoryValue = { scope: found.workspaceId, address: canonical, visibility: found.visibility, team: known?.team ?? null, workspace: known?.workspace ?? null, owner: !found.mirror && known?.team.role === 'owner' };
  return (
    <MirrorContext.Provider value={found.mirror ?? null}><Repository value={value} viewer={viewer}>
      <CanonicalAddress from={address} to={canonical} />
      {children}
    </Repository></MirrorContext.Provider>
  );
}

function CanonicalAddress({ from, to }: { from: Address; to: Address }) {
  useEffect(() => {
    if (!sameAddress(from, to)) {
      const old = addressPath(from), next = addressPath(to);
      navigate(next + window.location.pathname.slice(old.length) + window.location.search + window.location.hash, { replace: true });
    }
  }, [from.owner, from.repo, to.owner, to.repo]);
  return null;
}

/** Another repository or another person gets a fresh workspace tree, so no state crosses from one to the other. */
function Repository({ value, viewer, children }: { value: RepositoryValue; viewer: string | null; children: ReactNode }) {
  const { accounts, remember } = useAccount();
  // Set during render on purpose: the workspace below fetches in its first effect, before any effect here would run.
  if (accounts || value.address) setPublicPolling(accounts ? !value.team : true);
  setWorkspaceScope(value.scope, viewer);
  setRouteBase(value.address ? addressPath(value.address) : '');
  const memo = useMemo(() => value, [value.scope, value.address, value.visibility, value.team, value.workspace, value.owner]);
  const scope = value.scope;
  useEffect(() => {
    if (accounts && scope) remember(scope);
  }, [accounts, scope, remember]);
  return (
    <RepositoryContext.Provider value={memo}>
      <Fragment key={`${scope ?? ''}:${viewer ?? ''}`}>{children}</Fragment>
    </RepositoryContext.Provider>
  );
}
