import { Button } from '@cloudflare/kumo';
import { CodeIcon, FolderIcon, GitBranchIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { accountOwners } from '../../../shared/account';
import { useAccount } from '../../account/AccountProvider';
import { addressPath, isExample, type Route } from '../../lib/router';
import { RouterLink } from './Link';
import { BlameSkeleton, CodeSkeleton as CodeLinesSkeleton } from '../code/CodeSkeleton';
import { LoadingRegion, SkeletonBox, SkeletonLine, SkeletonParagraph, SkeletonRow, SkeletonRows } from './Skeleton';
import { Kbd } from './Kbd';

export function CommitSkeleton() {
  return <LoadingRegion label="Loading latest commit" className="loading-commit">
    <SkeletonLine width="min(160px, 30%)" /><SkeletonLine width="min(320px, 45%)" /><span className="loading-commit__end"><SkeletonLine width={64} /></span>
  </LoadingRegion>;
}

export function ReadmeSkeleton() {
  return <SkeletonBox className="loading-readme"><div className="loading-box-head">README</div><SkeletonParagraph /></SkeletonBox>;
}

export function FileRowsSkeleton() {
  return <SkeletonRows className="loading-files" rows={11} label="Loading files" height={39} />;
}

export function PullRowsSkeleton() {
  return <SkeletonRows rows={6} label="Loading pull requests" detail />;
}

export function ChangesSkeleton({ label = 'Loading changes' }: { label?: string }) {
  return <LoadingRegion label={label} className="loading-changes"><SkeletonBox><div className="loading-box-head"><SkeletonLine width="32%" /></div><SkeletonRows rows={12} height={20} label="Loading code" /></SkeletonBox></LoadingRegion>;
}

export function FilesSkeleton() {
  return <div className="loading-files-layout"><aside><SkeletonRows rows={6} height={32} label="Loading changed files" /></aside><ChangesSkeleton /></div>;
}

/** The Guide's columns before its chunk arrives: before and after, chapters, and the first chapter's code. */
export function GuideSkeleton() {
  return <LoadingRegion label="Loading guide" className="loading-guide">
    <div className="loading-guide-intro"><div><div className="loading-guide-head">Before</div><SkeletonLine width="92%" /><SkeletonLine width="70%" /></div><div><div className="loading-guide-head">After</div><SkeletonLine width="88%" /><SkeletonLine width="76%" /></div></div>
    <div className="loading-guide-layout"><aside>{Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} index={index} icon={false} detail height={48} />)}</aside><ChangesSkeleton /></div>
  </LoadingRegion>;
}

/** The first read has no known count; don't invent a full page above its pagination. */
export function HistorySkeleton() {
  return <div className="loading-history"><div className="loading-history-date"><SkeletonLine width={180} /></div><SkeletonBox><SkeletonRows rows={1} detail height={76} label="Loading commits" /></SkeletonBox></div>;
}

/** The idle queue has one line in each section; retain its headings while the reads arrive. */
function QueueSkeleton() {
  return <LoadingRegion label="Loading merge queue" className="page page--readable loading-screen--queue">
    <header className="page-head"><div><h1 className="page-title">Merge queue</h1><div className="page-subline"><SkeletonLine width={130} /></div></div></header>
    {['Merging now', 'Queued', 'Stacks', 'History'].map(label => <section className="section" key={label}>
      <h2 className="section__title">{label}</h2>
      <div className={label === 'Stacks' ? 'loading-queue-stacks' : 'loading-queue-line'}><SkeletonLine width={label === 'History' ? 240 : 150} /></div>
    </section>)}
  </LoadingRegion>;
}

export function BranchesSkeleton() {
  return <LoadingRegion label="Loading branches" className="loading-branches">{['Default branch', 'Other branches'].map((title, i) => <SkeletonBox key={title}><div className="loading-box-head">{title}</div><SkeletonRows rows={i ? 3 : 1} detail height={98} label="Loading branches" /></SkeletonBox>)}</LoadingRegion>;
}

export function CommitDetailSkeleton() {
  return <LoadingRegion label="Loading commit">
    <SkeletonBox><div className="loading-commit-heading"><SkeletonLine width="50%" height={24} /><div><Button disabled variant="secondary" size="sm">Compare with…</Button><Button disabled variant="secondary" size="sm">Browse files</Button></div></div><div className="loading-commit-meta"><SkeletonLine width={160} /><SkeletonLine width={96} /></div><div className="loading-commit-refs"><SkeletonLine width={84} /><SkeletonLine width={140} /></div></SkeletonBox>
    <section className="loading-commit-changes"><h2>Files changed</h2><ChangesSkeleton /></section>
  </LoadingRegion>;
}

function BranchPlaceholder({ name, label }: { name?: string | null; label?: string }) {
  return <Button size="sm" variant="secondary" icon={GitBranchIcon} disabled>{label ? `${label}: ` : ''}{name ?? <SkeletonLine width={35} />}</Button>;
}

function CodeSkeleton({ route }: { route: Route }) {
  const branch = <BranchPlaceholder name={route.ref} />;
  if (route.path) return <div className="loading-file-layout">
    <div className="loading-phone-bar"><Button size="sm" variant="secondary" icon={FolderIcon} disabled>Files</Button>{branch}<Button size="sm" variant="secondary" icon={MagnifyingGlassIcon} disabled>Go to file</Button></div>
    <aside className="loading-file-tree">{branch}<SkeletonRows rows={11} height={31} label="Loading file tree" /></aside>
    <section>
      <div className="loading-file-head"><span className="loading-file-path">{route.repo?.repo} / {route.path}</span>{route.view !== 'tree' ? <span className="loading-file-tabs">Code&nbsp;&nbsp; Blame</span> : null}</div>
      {route.view === 'tree' ? <FileRowsSkeleton /> : route.view === 'blame' ? <BlameSkeleton /> : <CodeLinesSkeleton label="Loading file" />}
    </section>
  </div>;
  return <>
    <div className="loading-toolbar">
      {branch}
      <Button size="sm" variant="secondary" icon={MagnifyingGlassIcon} disabled>Go to file <Kbd>t</Kbd></Button>
      <input className="loading-search" aria-label="Search this repository" placeholder="Search code" disabled />
      <span className="loading-toolbar__end"><Button size="sm" variant="secondary" icon={CodeIcon} disabled>Code</Button></span>
    </div>
    <SkeletonBox><CommitSkeleton /><FileRowsSkeleton /></SkeletonBox>
    <ReadmeSkeleton />
  </>;
}

export function PullSkeleton({ route }: { route: Route }) {
  const base = route.repo ? addressPath(route.repo) : '';
  const tab = route.sub || 'conversation';
  return <LoadingRegion label="Loading pull request" className="page pull">
    <header className="pull-head loading-pull-head">
      <div className="loading-pull-title"><SkeletonLine width="60%" height={26} /><span className="pull-head__num">#{route.id}</span></div>
      <div className="pull-head__meta"><SkeletonLine width={80} height={28} /><SkeletonLine width="35%" /></div>
      <nav className="loading-pull-tabs" aria-label="Pull request">{[['conversation', 'Conversation'], ['guide', 'Guide'], ['checks', 'Checks'], ['files', 'Files changed']].map(([value, label]) => <RouterLink key={value} href={`${base}/pull/${route.id}${value === 'conversation' ? '' : `/${value}`}`} aria-current={tab === value ? 'page' : undefined}>{label}</RouterLink>)}</nav>
    </header>
    {tab === 'files' ? <FilesSkeleton /> : tab === 'guide' ? <GuideSkeleton /> : tab === 'checks' ? <SkeletonBox><SkeletonRows rows={5} height={62} detail label="Loading checks" /></SkeletonBox> : <div className="loading-conversation"><div><SkeletonBox><div className="loading-box-head"><SkeletonLine width="28%" /></div><SkeletonParagraph label="Loading conversation" /></SkeletonBox><SkeletonBox className="loading-readme"><SkeletonRows rows={4} label="Loading merge status" /></SkeletonBox></div><aside><SkeletonRows rows={5} detail label="Loading reviewers" /></aside></div>}
  </LoadingRegion>;
}

/** Unknown inbox groups arrive together, so none can move from a guessed position. */
export function InboxSkeleton() {
  return <LoadingRegion label="Loading inbox" className="loading-inbox">
    <div className="loading-inbox__title"><SkeletonLine width={130} /></div>
    <SkeletonRows rows={6} detail label="Loading pull requests" />
  </LoadingRegion>;
}

function HomeSkeleton() {
  const { account } = useAccount();
  if (!account?.user) return <div className="page" aria-busy="true" aria-label="Loading account" />;
  const teams = accountOwners(account);
  const count = teams.reduce((sum, team) => sum + team.workspaces.length, 0);
  return <LoadingRegion label="Loading dashboard" className={`page loading-dashboard${count ? '' : ' loading-dashboard--first'}`}>
    <header className="loading-dashboard__head"><h1>Dashboard</h1>{count && teams.some(team => team.role === 'owner') ? <Button variant="primary" icon={PlusIcon} disabled>New repository</Button> : null}</header>
    {count ? <>
      <InboxSkeleton />
      <aside><h2>Repositories</h2><SkeletonRows rows={Math.min(count, 6)} detail height={64} label="Loading repositories" /></aside>
    </> : <SkeletonBox><SkeletonParagraph label="Loading repositories" /></SkeletonBox>}
  </LoadingRegion>;
}

export function ScreenSkeleton({ route }: { route: Route }) {
  const screen = route.screen;
  if (screen === 'pull') return <PullSkeleton route={route} />;
  if (screen === 'queue') return <QueueSkeleton />;
  if (screen === 'home' && !route.repo) return <HomeSkeleton />;
  if (screen === 'commits') return <div className="page loading-history-page"><header className="loading-history-header"><h1>Commits</h1><BranchPlaceholder name={route.ref} />{route.path ? <span>{route.path}</span> : null}</header><HistorySkeleton /></div>;
  if (screen === 'commit') return <div className="page"><CommitDetailSkeleton /></div>;
  if (screen === 'branches') return <div className="page"><header className="page-head"><h1 className="page-title">Branches</h1></header><BranchesSkeleton /></div>;
  if (screen === 'compare') {
    const [base, head] = route.id?.split('...') ?? [];
    return <div className="page"><header className="page-head"><h1 className="page-title">Compare changes</h1></header><div className="loading-compare-refs"><BranchPlaceholder name={base} label="base" /><BranchPlaceholder name={head} label="compare" /></div><ChangesSkeleton label="Comparing branches" /></div>;
  }

  const titles: Partial<Record<Route['screen'], string>> = { agents: 'Agents', task: 'Agent task', review: 'Agent task', queue: 'Merge queue', search: 'Search', explore: 'Explore', settings: 'Settings' };
  return <LoadingRegion label={`Loading ${titles[screen]?.toLowerCase() ?? 'repository'}`} className={`page loading-screen loading-screen--${screen}`}>
    {screen === 'code' || screen === 'home' ? <CodeSkeleton route={route} /> : screen === 'pulls' ? <>
      <div className="pulls-bar"><input className="loading-search loading-search--wide" placeholder="Filter pull requests" aria-label="Filter pull requests" disabled /></div>
      <div className="queue-line"><SkeletonLine width={160} /></div>
      <SkeletonBox><div className="list__head"><span className="list__filter">Open</span><span className="list__filter">Closed</span><span className="list__filter list__filter--needs">Needs you</span></div><PullRowsSkeleton /></SkeletonBox>
    </> : <>
      {screen === 'agents' ? null : titles[screen] ? <header className="page-head"><div><h1 className="page-title">{titles[screen]}</h1></div></header> : <div className="loading-title"><SkeletonLine width="50%" height={26} /></div>}
      {screen === 'agents' ? <>
        <SkeletonBox className={`loading-composer${route.repo && isExample(route.repo) ? ' loading-composer--example' : ''}`}><SkeletonLine width="46%" /><div className="loading-composer__footer"><SkeletonLine width={70} /><Button size="sm" variant="primary" disabled>{route.repo && isExample(route.repo) ? 'Replay' : 'Start task'}</Button></div></SkeletonBox>
        <SkeletonBox><div className="list__head">Tasks</div><SkeletonRows rows={1} detail label="Loading tasks" /></SkeletonBox>
        <SkeletonBox className="loading-readme"><div className="list__head">Fleet</div><SkeletonRows rows={4} height={43} label="Loading agents" /></SkeletonBox>
      </> : screen === 'task' || screen === 'review' ? <><SkeletonBox className="loading-graph"><SkeletonParagraph label="Loading task" /></SkeletonBox><ChangesSkeleton /></> : <>
        {screen === 'search' ? <input className="loading-search loading-search--wide" placeholder="Search this repository" aria-label="Search this repository" disabled /> : null}
        <SkeletonBox><SkeletonRows rows={6} detail label={`Loading ${titles[screen]?.toLowerCase() ?? 'page'}`} /></SkeletonBox>
      </>}
    </>}
  </LoadingRegion>;
}
