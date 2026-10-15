import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, LinkButton, LinkProvider, Toasty, TooltipProvider } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { api } from './lib/api';
import { clockTime, isEditableTarget, isModifierKey } from './lib/format';
import { useDocumentTitle } from './lib/title';
import { lazyComponent } from './lib/lazy';
import { onOpenPalette, openPalette, type PaletteScope } from './lib/palette';
import { canPrefetch, prefetchLikelyScreens } from './lib/prefetch';
import { isExample, navigate, paths, useRoute, type Route, type Screen } from './lib/router';
import { RouterLink } from './components/ui/Link';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { PageState, ErrorPanel } from './components/ui/States';
import { LoadingShell } from './components/ui/LoadingShell';
import { LoadingContent } from './components/ui/LoadingContent';
import { WorkspaceProvider, newMissionBlocker, useWorkspace } from './store/workspace';
import { AccountProvider, useAccount } from './account/AccountProvider';
import { AccountGate, SignIn } from './account/AccountGate';
import { RepositoryGate } from './account/RepositoryGate';
import { isMirrorFailure, MIRROR_NOT_FOUND, useMirror } from './account/mirrors';
import { MirrorError } from './components/repo/MirrorError';
import { TopBar } from './components/shell/TopBar';
import { ExampleBanner } from './components/shell/ExampleBanner';
import { NotFound, SitePage } from './components/shell/SiteBar';
import type { MissionDraft } from './components/mission/NextStep';
import { AgentsScreen, BranchesScreen, CodeScreen, CommitScreen, CommitsScreen, SearchScreen, CompareScreen, DashboardScreen, ExploreScreen, LandingScreen, NewRepositoryScreen, NewOrganizationScreen, OwnerScreen, PullScreen, PullsScreen, QueueScreen, SettingsScreen, TaskScreen } from './screens';

// Opened on demand, so neither the command palette nor the task form is part of the first paint.
const commandMenu = lazyComponent(() => import('./components/shell/CommandMenu'), (m) => m.CommandMenu);
const newTaskDialog = lazyComponent(() => import('./components/shell/NewTaskDialog'), (m) => m.NewTaskDialog);
const CommandMenu = commandMenu.Component;
const NewTaskDialog = newTaskDialog.Component;
const MirrorAgentsScreen = lazyComponent(() => import('./screens/MirrorAgentsScreen'), m => m.MirrorAgentsScreen).Component;
const OAuthConsent = lazyComponent(() => import('./account/OAuthConsent'), m => m.OAuthConsent).Component;
const loadCommandMenu = () => { if (canPrefetch()) return commandMenu.prefetch(); };

export function App() {
  // The last resort: a crash outside any screen, in the header itself, still leaves a page with Reload.
  return (
    <ErrorBoundary root>
      <Toasty>
        <TooltipProvider delay={350}>
          <LinkProvider component={RouterLink}>
            <AccountProvider>
              <AccountGate>
                <Router />
              </AccountGate>
            </AccountProvider>
          </LinkProvider>
        </TooltipProvider>
      </Toasty>
    </ErrorBoundary>
  );
}

/** Sends the browser elsewhere while showing the page's skeleton. */
function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <LoadingShell />;
}

/**
 * The URL decides the page. On a deployment with accounts `/` is the landing page, or the dashboard
 * once signed in, and Explore and sign-in stand beside it; everything else is a repository, found
 * by its address. The single-owner deployment has one repository and no site around it.
 */
function Router() {
  const route = useRoute();
  const { account, accounts } = useAccount();
  const user = account?.user ?? null;
  if (accounts) {
    if (route.screen === 'home') {
      return user ? (
        <SitePage>
          <Suspense fallback={<LoadingShell />}>
            <DashboardScreen />
          </Suspense>
        </SitePage>
      ) : (
        <Suspense fallback={<LoadingShell />}>
          <LandingScreen />
        </Suspense>
      );
    }
    const Page = route.screen === 'explore' ? ExploreScreen : route.screen === 'global-search' ? SearchScreen : null;
    if (Page) {
      return (
        <SitePage>
          <Suspense fallback={<LoadingShell />}>
            <Page />
          </Suspense>
        </SitePage>
      );
    }
    if (route.screen === 'owner' || route.screen === 'organization') {
      return (
        <SitePage>
          <Suspense fallback={<LoadingShell />}>
            <OwnerScreen />
          </Suspense>
        </SitePage>
      );
    }
    if (route.screen === 'new-organization') {
      if (!user) return <Redirect to={paths.signin(route.href)} />;
      return <SitePage><Suspense fallback={<LoadingShell />}><NewOrganizationScreen /></Suspense></SitePage>;
    }
    if (route.screen === 'new') {
      if (!user) return <Redirect to={paths.signin(route.href)} />;
      return (
        <SitePage>
          <Suspense fallback={<LoadingShell />}>
            <NewRepositoryScreen />
          </Suspense>
        </SitePage>
      );
    }
    if (route.screen === 'signin') {
      const next = route.query.get('next');
      if (user) return <Redirect to={next?.startsWith('/') && !next.startsWith('//') ? next : paths.site()} />;
      return (
        <Suspense fallback={<LoadingShell />}>
          <SignIn next={next} />
        </Suspense>
      );
    }
    if (route.screen === 'authorize') {
      if (!user) return <Redirect to={paths.signin(route.href)} />;
      return <Suspense fallback={<LoadingShell />}><OAuthConsent query={route.query} /></Suspense>;
    }
    if (route.screen === 'not-found' && !route.repo) return <NotFound kind="page" />;
  } else if (route.screen === 'explore' || route.screen === 'signin' || route.screen === 'new' || route.screen === 'owner' || route.screen === 'organization' || route.screen === 'new-organization') {
    return <Redirect to={paths.site()} />;
  }
  return <RepositoryGate route={route}>{(screen) => <Shell screen={screen} />}</RepositoryGate>;
}

function Shell({ screen }: { screen: Screen }) {
  return (
    <WorkspaceProvider>
      <RepositoryShell screen={screen} />
    </WorkspaceProvider>
  );
}

function RepositoryShell({ screen }: { screen: Screen }) {
  const route = useRoute();
  const { snapshot, loading, error, errorStatus, errorCode, lastUpdated, refreshing, refresh } = useWorkspace();
  const account = useAccount();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMounted, setPaletteMounted] = useState(false);
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all');
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskMounted, setTaskMounted] = useState(false);
  const [draft, setDraft] = useState<MissionDraft | null>(null);
  // GitHub's two-key sequences: `g` then `c`, `p`, `a` or `s`.
  const chord = useRef<number>(0);

  // Screens open the menu through the palette module, as the toolbar's Go to file does.
  useEffect(
    () =>
      onOpenPalette((scope) => {
        setPaletteScope(scope);
        setPaletteMounted(true);
        setPaletteOpen(true);
      }),
    [],
  );

  const setPaletteOpenChange = useCallback((next: boolean) => {
    setPaletteOpen(next);
    if (!next) setPaletteScope('all');
  }, []);

  /** Uses the Agents page's composer, or opens New task with an earlier brief when a task starts again. */
  const openTask = useCallback(
    (next?: MissionDraft) => {
      if (newMissionBlocker(snapshot)) return;
      if (!next && screen === 'agents') {
        // Let the command menu close before moving focus out of it. The example focuses Replay.
        requestAnimationFrame(() => document.querySelector<HTMLElement>('#main .task-composer textarea, #main .task-composer button[type="submit"]')?.focus());
        return;
      }
      setDraft(next ?? null);
      setTaskMounted(true);
      setTaskOpen(true);
    },
    [snapshot, screen],
  );

  // An ended session or a repository this person lost access to is the account layer's question.
  const { accounts, refresh: refreshAccount } = account;
  useEffect(() => {
    if (accounts && (errorStatus === 401 || errorStatus === 403 || errorStatus === 404)) void refreshAccount();
  }, [accounts, errorStatus, refreshAccount]);

  useEffect(() => {
    if (!route.hash) window.scrollTo({ top: 0 });
  }, [screen, route.id, route.sub, route.path, route.hash]);

  // The repository tabs warm after the current page; links and dialogs wait for intent.
  const ready = !!snapshot;
  useEffect(() => {
    if (!ready) return;
    let cancel: (() => void) | undefined;
    const id = window.setTimeout(() => { cancel = prefetchLikelyScreens(screen); }, 2_500);
    return () => { window.clearTimeout(id); cancel?.(); };
  }, [ready, screen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isModifierKey(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // Opening goes through the palette module, which keeps the element to return focus to; the open menu closes itself.
        if (!paletteOpen) openPalette();
        return;
      }
      const overlayOpen = paletteOpen || taskOpen || !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
      if (isModifierKey(event) || event.altKey || overlayOpen || isEditableTarget(event.target)) return;
      const key = event.key;
      if (chord.current && Date.now() - chord.current < 1500) {
        chord.current = 0;
        const to = key === 'c' ? paths.home() : key === 'p' ? paths.pulls() : key === 'a' ? paths.agents() : key === 's' ? paths.settings() : null;
        if (to) {
          event.preventDefault();
          navigate(to);
          return;
        }
      }
      if (key === 'g') chord.current = Date.now();
      else if (key === 'n') {
        event.preventDefault();
        openTask();
      } else if (key === 't') {
        event.preventDefault();
        openPalette('files');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTask, paletteOpen, taskOpen]);

  const retry = useCallback(() => void refresh(), [refresh]);
  // A mirror that cannot be copied shows its reason alone, also when an import snapshot is kept.
  if ((!snapshot || !snapshot.project.id) && !loading && error && route.repo && isMirrorFailure(errorCode)) return <SitePage><MirrorError message={error} code={errorCode} signIn={errorCode === MIRROR_NOT_FOUND && !account.account?.user} address={route.repo} /></SitePage>;
  // A repository that stopped answering for this viewer is gone for them: private now, or deleted.
  if (accounts && !snapshot && !loading && errorStatus === 404) return <NotFound kind="repository" />;

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopBar snapshot={snapshot} screen={screen} onSearch={() => openPalette()} onSearchIntent={loadCommandMenu} />
      {snapshot?.capabilities.mode === 'demo' || route.repo && isExample(route.repo) ? <ExampleBanner limited={snapshot?.capabilities.mode === 'demo' && !snapshot.capabilities.canWrite} /> : null}
      {error && snapshot ? (
        <section className="app-notice" aria-label="Repository updates">
          <Banner
            variant="alert"
            size="sm"
            icon={<WarningCircleIcon weight="fill" />}
            description={`Updates paused${lastUpdated ? ` since ${clockTime(lastUpdated)}` : ''}. ${error}`}
            action={
              <Button size="sm" variant="secondary" icon={ArrowClockwiseIcon} disabled={refreshing} onClick={retry}>
                Try again
              </Button>
            }
          />
        </section>
      ) : null}
      <LoadingContent value={true}><main id="main" className="main" tabIndex={-1}>
        {loading && !snapshot ? (
          <LoadingShell screen={screen} />
        ) : !snapshot ? (
          <div className="page">
            <ErrorPanel page title="Unable to load repository" message={error ?? 'Try again in a moment.'} onRetry={retry} retrying={refreshing} />
            {!accounts && errorStatus === 401 ? <EndedSession onCleared={retry} /> : null}
          </div>
        ) : (
          // A screen that crashes keeps the header; the next page renders again.
          <ErrorBoundary resetKey={route.href}>
            <Suspense fallback={<LoadingShell screen={screen} />}>
              <div className="screen-enter" key={transitionKey(route, screen)}>
                <ScreenSwitch route={route} screen={screen} onNewTask={openTask} />
              </div>
            </Suspense>
          </ErrorBoundary>
        )}
      </main></LoadingContent>
      {paletteMounted ? (
        <Suspense fallback={null}>
          <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpenChange} snapshot={snapshot} onNewTask={() => openTask()} scope={paletteScope} onScopeChange={setPaletteScope} />
        </Suspense>
      ) : null}
      {taskMounted ? (
        <Suspense fallback={null}>
          <NewTaskDialog open={taskOpen} onOpenChange={setTaskOpen} draft={draft} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * An expired owner key session makes every request answer 401. Clearing the cookie returns this
 * browser to the recorded example, where Settings can open the live repository again.
 */
function EndedSession({ onCleared }: { onCleared: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="ended-session">
      <Button
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.lock();
          } finally {
            setBusy(false);
            onCleared();
          }
        }}
      >
        Continue with the recorded example
      </Button>
    </div>
  );
}

/** A task keeps one key across its views, so its header stays mounted; so does a pull request across its tabs. */
function transitionKey(route: Route, screen: Screen): string {
  if (screen === 'review' || screen === 'task') return `task:${route.id ?? ''}`;
  if (screen === 'pull') return `pull:${route.id}`;
  if (screen === 'settings') return 'settings';
  return screen;
}

function ScreenSwitch({ route, screen, onNewTask }: { route: Route; screen: Screen; onNewTask: (draft?: MissionDraft) => void }) {
  const mirror = useMirror();
  if (mirror && screen === 'agents') return <MirrorAgentsScreen />;
  if (mirror && ['task', 'review', 'settings'].includes(screen)) return <div className="page"><p>Claim this repository to {screen === 'settings' ? 'change settings' : 'start a task'}.</p></div>;
  switch (screen) {
    case 'code':
      return <CodeScreen />;
    case 'commits':
      return <CommitsScreen />;
    case 'commit':
      return <CommitScreen />;
    case 'global-search':
    case 'search':
      return <SearchScreen />;
    case 'branches':
      return <BranchesScreen />;
    case 'compare':
      return <CompareScreen />;
    case 'pulls':
      return <PullsScreen />;
    case 'pull':
      return <PullScreen />;
    case 'queue':
      return <QueueScreen />;
    case 'agents':
      return <AgentsScreen />;
    case 'task':
      return <TaskScreen view="task" onNewTask={onNewTask} />;
    case 'review':
      return <TaskScreen view={route.query.get('view') === 'merge' ? 'merge' : 'review'} onNewTask={onNewTask} />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return <MissingPage />;
  }
}

/** A path under a repository that is not one of its screens. */
function MissingPage() {
  useDocumentTitle('Page not found · Braid');
  return (
    <div className="page">
      <PageState title="Page not found">
        <LinkButton variant="secondary" href={paths.home()}>
          Back to repository
        </LinkButton>
      </PageState>
    </div>
  );
}
