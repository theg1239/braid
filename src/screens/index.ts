import { lazyComponent } from '../lib/lazy';
import { LoadingShell } from '../components/ui/LoadingShell';
import type { Screen } from '../lib/router';

/*
 * One chunk per screen. The shell (top bar, tabs, routing, the workspace store) ships first;
 * a screen's code arrives when its route is likely: on hover or focus of a link to it, in idle
 * time after the first paint, or at the latest when it is opened. The site's pages, the landing
 * page, the dashboard and Explore, are chunks of their own that a repository never loads.
 */
const chunks = {
  code: lazyComponent(() => import('./CodeScreen'), (m) => m.CodeScreen, LoadingShell),
  commits: lazyComponent(() => import('./CommitsScreen'), (m) => m.CommitsScreen, LoadingShell),
  commit: lazyComponent(() => import('./CommitScreen'), (m) => m.CommitScreen, LoadingShell),
  search: lazyComponent(() => import('./SearchScreens'), (m) => m.SearchScreen, LoadingShell),
  branches: lazyComponent(() => import('./BranchesScreen'), (m) => m.BranchesScreen, LoadingShell),
  compare: lazyComponent(() => import('./CompareScreen'), (m) => m.CompareScreen, LoadingShell),
  owner: lazyComponent(() => import('./OwnerScreen'), (m) => m.OwnerScreen, LoadingShell),
  pulls: lazyComponent(() => import('./PullsScreen'), (m) => m.PullsScreen, LoadingShell),
  pull: lazyComponent(() => import('./PullScreen'), (m) => m.PullScreen, LoadingShell),
  queue: lazyComponent(() => import('./QueueScreen'), (m) => m.QueueScreen, LoadingShell),
  agents: lazyComponent(() => import('./AgentsScreen'), (m) => m.AgentsScreen, LoadingShell),
  task: lazyComponent(() => import('./TaskScreen'), (m) => m.TaskScreen, LoadingShell),
  settings: lazyComponent(() => import('./SettingsScreen'), (m) => m.SettingsScreen, LoadingShell),
  landing: lazyComponent(() => import('./LandingScreen'), (m) => m.LandingScreen, LoadingShell),
  dashboard: lazyComponent(() => import('./DashboardScreen'), (m) => m.DashboardScreen, LoadingShell),
  explore: lazyComponent(() => import('./ExploreScreen'), (m) => m.ExploreScreen, LoadingShell),
  'new-organization': lazyComponent(() => import('./NewOrganizationScreen'), (m) => m.NewOrganizationScreen, LoadingShell),
  new: lazyComponent(() => import('./NewRepositoryScreen'), (m) => m.NewRepositoryScreen, LoadingShell),
};

type Loaded = keyof typeof chunks;

export const CodeScreen = chunks.code.Component;
export const CommitsScreen = chunks.commits.Component;
export const CommitScreen = chunks.commit.Component;
export const SearchScreen = chunks.search.Component;
export const BranchesScreen = chunks.branches.Component;
export const CompareScreen = chunks.compare.Component;
export const OwnerScreen = chunks.owner.Component;
export const PullsScreen = chunks.pulls.Component;
export const PullScreen = chunks.pull.Component;
export const QueueScreen = chunks.queue.Component;
export const AgentsScreen = chunks.agents.Component;
export const TaskScreen = chunks.task.Component;
export const SettingsScreen = chunks.settings.Component;
export const LandingScreen = chunks.landing.Component;
export const DashboardScreen = chunks.dashboard.Component;
export const ExploreScreen = chunks.explore.Component;
export const NewOrganizationScreen = chunks['new-organization'].Component;
export const NewRepositoryScreen = chunks.new.Component;

/** The chunk a screen lives in. The two task views share one; home is the landing page or the dashboard, which the router decides. */
function chunkOf(screen: Screen): Loaded | null {
  if (screen === 'global-search') return 'search';
  if (screen === 'organization') return 'owner';
  if (screen === 'review') return 'task';
  if (screen === 'home' || screen === 'signin' || screen === 'not-found') return null;
  return screen in chunks ? (screen as Loaded) : null;
}

/** Loads a screen's chunk ahead of navigation. Rendering shares its CSS-ready result or its error. */
export function prefetchScreen(screen: Screen) {
  const chunk = chunkOf(screen);
  if (chunk) void chunks[chunk].prefetch();
}

/** The landing page, loaded ahead when `/` may be the site's home rather than a repository. */
export const prefetchLanding = () => void chunks.landing.prefetch();
