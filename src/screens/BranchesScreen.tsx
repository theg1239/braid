import { useState } from 'react';
import { Input, LinkButton } from '@cloudflare/kumo';
import { GitBranchIcon, GitPullRequestIcon } from '@phosphor-icons/react';
import type { RepositoryBranch, RepositoryBranches } from '../../shared/compare';
import type { ChangeSummary } from '../../shared/types';
import { api, changes } from '../lib/api';
import { pullState } from '../lib/changes';
import { shortHash } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { paths } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { BranchesSkeleton } from '../components/ui/ScreenSkeleton';
import { AuthorChip } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { EmptyPanel } from '../components/ui/States';
import { RepositoryReadError } from './RepositoryReadError';
import { RelativeTime } from '../components/ui/Time';
import '../styles/branches.css';

/** One paginated, workspace-scoped lookup shared by Branches and Compare. */
export async function branchPullRequests(): Promise<Map<string, ChangeSummary>> {
  const pulls = new Map<string, ChangeSummary>();
  let cursor: string | null = null;
  do {
    const page = await changes.list({ status: 'active', limit: 100, ...(cursor ? { cursor } : {}) });
    for (const change of page.items) {
      if (change.headCommit && pullState(change.status) === 'open' && !pulls.has(change.headCommit)) pulls.set(change.headCommit, change);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return pulls;
}

export function useBranchPullRequests() {
  return useLive('repository:branch-pull-requests', branchPullRequests, 30_000);
}

function BranchRow({ branch, defaultBranch, now, pullRequest }: { branch: RepositoryBranch; defaultBranch: string; now: number; pullRequest?: ChangeSummary }) {
  const { name, tip } = branch;
  return <li className="branches__row">
    <GitBranchIcon size={18} className="quiet" aria-hidden="true" />
    <div className="branches__details">
      <RouterLink className="branches__name mono" href={paths.code('', { ref: name })}>{name}</RouterLink>
      {tip ? <>
        <RouterLink className="branches__title" href={paths.commits(name)}>{tip.title}</RouterLink>
        <div className="branches__meta">
          <AuthorChip author={tip.author} />
          <span>Updated <RelativeTime at={tip.time} now={now} /></span>
          <RouterLink href={paths.code('', { ref: tip.hash })} className="mono">{shortHash(tip.hash)}</RouterLink>
        </div>
      </> : <span className="quiet">No commits</span>}
    </div>
    <div className="branches__actions">
      <div className="branches__pull-slot">
        {pullRequest ? <RouterLink className="branches__pull-request" href={paths.pull(pullRequest.number)} aria-label={`Pull request #${pullRequest.number} · Open: ${pullRequest.title}`} title={pullRequest.title}>
          <GitPullRequestIcon size={16} weight="bold" className="pr-state" data-state="open" aria-hidden="true" />#{pullRequest.number}
        </RouterLink> : null}
      </div>
      <div className="branches__compare-slot">
        {name !== defaultBranch ? <LinkButton href={paths.compare(defaultBranch, name)} variant="outline" size="sm" aria-label={`Compare ${name} with ${defaultBranch}`}>Compare</LinkButton> : null}
      </div>
    </div>
  </li>;
}

export function BranchList({ data, query, now, pullRequests }: { data: RepositoryBranches; query: string; now: number; pullRequests?: Map<string, ChangeSummary> | null }) {
  const shown = data.branches.filter(branch => branch.name.toLowerCase().includes(query.trim().toLowerCase()));
  if (!shown.length) return <EmptyPanel icon={<GitBranchIcon size={28} />} title={data.branches.length ? 'No matching branches' : 'No branches yet'} />;
  const sections = [
    { title: 'Default branch', branches: shown.filter(branch => branch.name === data.defaultBranch) },
    { title: 'Other branches', branches: shown.filter(branch => branch.name !== data.defaultBranch) },
  ];
  return <div className="branches__sections">{sections.filter(section => section.branches.length).map(section => (
    <section className="branches__section" key={section.title} aria-label={section.title}>
      <h2 className="branches__heading">{section.title}</h2>
      <ul>{section.branches.map(branch => <BranchRow key={branch.name} branch={branch} defaultBranch={data.defaultBranch} now={now} pullRequest={branch.tip ? pullRequests?.get(branch.tip.hash) : undefined} />)}</ul>
    </section>
  ))}</div>;
}

export function BranchesScreen() {
  const { project, branchCopy } = useSnapshot();
  const branches = useLive('repository:branches', api.branches, branchCopy ? 5_000 : 30_000);
  const pulls = useBranchPullRequests();
  const [query, setQuery] = useState('');
  const now = useNow();
  useDocumentTitle(`Branches · ${project.name}`);
  return <div className="page branches">
    <header className="page-head">
      <h1 className="page-title">Branches</h1>
      {branches.data && branches.data.branches.length > 8 ? <Input aria-label="Find a branch" placeholder="Find a branch" value={query} onChange={event => setQuery(event.target.value)} passwordManagerIgnore /> : null}
    </header>
    {branchCopy ? <p className="quiet branches__copying">{branchCopy.remaining ? `Copying ${branchCopy.remaining} more branches` : 'Copying branches'}</p> : null}
    <RepositoryReadError state={branches} title="Couldn’t load branches" notFound="Repository not found" />
    {branches.data ? <BranchList data={branches.data} query={query} now={now} pullRequests={pulls.data} /> : !branches.error ? <BranchesSkeleton /> : null}
  </div>;
}
