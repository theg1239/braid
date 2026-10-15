import { Badge } from '@cloudflare/kumo';
import { Suspense } from 'react';
import { CodeIcon, GearSixIcon, GitPullRequestIcon, RobotIcon, type Icon } from '@phosphor-icons/react';
import type { Visibility } from '../../../shared/account';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { addressPath, type Address, type Screen } from '../../lib/router';
import { RouterLink } from '../ui/Link';
import { GlobalHeader } from './GlobalHeader';
import type { RepositoryMirror } from '../../account/mirrors';
import { lazyComponent } from '../../lib/lazy';

const ClaimOwner = lazyComponent(() => import('../../account/ClaimOwner'), m => m.ClaimOwner).Component;
const MirrorSource = lazyComponent(() => import('../repo/MirrorSource'), m => m.MirrorSource).Component;

/** The repository's tabs, in GitHub's order and words. A pull request and the merge queue sit under Pull requests; a task sits under Agents. */
const NAV: { value: string; label: string; icon: Icon; suffix: string; screens: Screen[] }[] = [
  { value: 'code', label: 'Code', icon: CodeIcon, suffix: '', screens: ['code', 'branches', 'compare', 'commits', 'commit', 'search'] },
  { value: 'pulls', label: 'Pull requests', icon: GitPullRequestIcon, suffix: '/pulls', screens: ['pulls', 'pull', 'queue'] },
  { value: 'agents', label: 'Agents', icon: RobotIcon, suffix: '/agents', screens: ['agents', 'task', 'review'] },
  { value: 'settings', label: 'Settings', icon: GearSixIcon, suffix: '/settings', screens: ['settings'] },
];

export type HeaderProps = { snapshot: WorkspaceSnapshot | null; screen: Screen; onSearch?: () => void; onSearchIntent?: () => unknown };

/** The address and navigation do not depend on an account or workspace read. */
export function RepositoryHeader({ snapshot, screen, onSearch, onSearchIntent, address, visibility = null, counts = { open: null, tasks: null }, mirror, onClaimed }: HeaderProps & { address: Address | null; visibility?: Visibility | null; counts?: { open: number | null; tasks: number | null }; mirror?: RepositoryMirror | null; onClaimed?: () => Promise<unknown> }) {
  const project = snapshot?.project;
  const base = address ? addressPath(address) : '';
  const current = NAV.find((item) => item.screens.includes(screen))?.value ?? '';
  return (
    <GlobalHeader address={address} repoName={project?.id ? project.name : undefined} onSearch={onSearch} onSearchIntent={onSearchIntent} contextDetail={mirror && address ? <Suspense fallback={null}><MirrorSource mirror={mirror} address={address} snapshot={snapshot} /></Suspense> : null} details={visibility ? <Badge variant="outline">{visibility === 'public' ? 'Public' : 'Private'}{mirror ? ' mirror' : ''}</Badge> : null}>
      <nav className="repo-head__tabs" aria-label="Repository">
        <div className="repo-tabs__list">{NAV.filter(item => !mirror || item.value === 'code' || item.value === 'agents').map(item => {
          const TabIcon = item.icon;
          // undefined: the tab has no count. null: not known yet, so its place is held. A known zero shows nothing.
          const count = mirror ? undefined : item.value === 'pulls' ? counts.open : item.value === 'agents' ? counts.tasks : undefined;
          const to = `${base}${item.suffix}` || '/';
          return <RouterLink key={item.value} href={to} className="repo-tab" aria-current={current === item.value ? 'page' : undefined}>
            <span className="repo-tab__label"><TabIcon size={16} aria-hidden="true" className="repo-tab__icon" />{item.label}
              {count === null ? <span className="repo-tab__count" aria-hidden="true" style={{ visibility: 'hidden' }}>0</span> : count ? <span className="repo-tab__count">{count}</span> : null}
            </span>
          </RouterLink>;
        })}{mirror && address ? <span className="repo-tabs__claim"><Suspense fallback={null}><ClaimOwner slug={address.owner} claimable={mirror.claimable} onClaimed={onClaimed} /></Suspense></span> : null}</div>
      </nav>
    </GlobalHeader>
  );
}
