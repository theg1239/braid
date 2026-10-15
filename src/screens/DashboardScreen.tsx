import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@cloudflare/kumo';
import { GitBranchIcon, GitPullRequestIcon, PlusIcon } from '@phosphor-icons/react';
import { accountOwners, type Organization } from '../../shared/account';
import { authorLine, labelTone, statusLabel } from '../lib/changes';
import { plural } from '../lib/format';
import { EXAMPLE_ADDRESS, addressPath, paths } from '../lib/router';
import { useInbox, type InboxGroups, type InboxItem } from '../dashboard/inbox';
import { setInboxBadge } from '../dashboard/badge';
import { useAccount } from '../account/AccountProvider';
import { ClaimOwner } from '../account/ClaimOwner';
import { Label, PullStateIcon } from '../components/pulls/Bits';
import { RouterLink } from '../components/ui/Link';
import { InboxSkeleton } from '../components/ui/ScreenSkeleton';
import { RelativeTime } from '../components/ui/Time';
import '../styles/site.css';
import '../styles/dashboard.css';

/**
 * Signed in, `/` is the dashboard: what needs the person across their repositories and what their
 * agents merged lately, beside their organizations’ repositories with New repository.
 */
export function DashboardScreen() {
  const { account } = useAccount();
  const teams = accountOwners(account);
  const inbox = useInbox(account);
  const { now, data, groups, needsYou } = inbox;
  const canCreate = teams.some((team) => team.role === 'owner');

  useEffect(() => setInboxBadge(needsYou), [needsYou]);

  if (!teams.some(team => team.workspaces.length)) return <FirstRun canCreate={canCreate} />;

  return (
    <div className="page dash">
      <header className="dash__head">
        <h1 className="dash__title">Dashboard</h1>
        <PersonalClaim />
        {canCreate ? (
          <LinkButton variant="primary" icon={PlusIcon} href={paths.newRepository()}>
            New repository
          </LinkButton>
        ) : null}
      </header>
      <div className="dash__main">
        {data.unavailable.length || inbox.error ? (
          <div className="dash__error" role="alert">
            <p>
              {inbox.error ?? data.retryMessage ?? <>Couldn’t load all pull requests from {data.unavailable.map((repo, index) => <span key={repo.workspace.id}>{index ? ', ' : ''}<RouterLink href={`${addressPath(repo.address)}/pulls`}>{repo.address.owner}/{repo.address.repo}</RouterLink></span>)}.</>}
            </p>
            <Button variant="secondary" size="sm" disabled={inbox.refreshing} onClick={() => void inbox.refresh()}>Try again</Button>
          </div>
        ) : null}
        <InboxSections groups={groups} loading={inbox.loading} now={now} incomplete={!!(data.unavailable.length || inbox.error)} />
      </div>
      <aside className="dash__side">
        <Repositories teams={teams} open={data.open} />
      </aside>
    </div>
  );
}

const SECTIONS = [
  { key: 'review', title: 'Needs your review' },
  { key: 'returned', title: 'Returned to you' },
  { key: 'merging', title: 'Merging' },
  { key: 'merged', title: 'Recently merged' },
] as const;

function InboxSections({ groups, loading, now, incomplete }: { groups: InboxGroups; loading: boolean; now: number; incomplete: boolean }) {
  if (loading) return <InboxSkeleton />;
  const visible = SECTIONS.filter(section => groups[section.key].length);
  if (!visible.length) return incomplete ? null : <p className="dash__calm">You’re all caught up.</p>;
  return visible.map(section => <InboxSection key={section.key} section={section} items={groups[section.key]} now={now} />);
}

function InboxSection({ section, items, now }: { section: typeof SECTIONS[number]; items: InboxItem[]; now: number }) {
  const [shown, setShown] = useState(8);
  return (
    <section className={`dash__section--${section.key}`} aria-labelledby={`inbox-${section.key}`}>
      <h2 id={`inbox-${section.key}`} className="dash__h2">
        {section.title}
        <span className="dash__count">{items.length}</span>
        {section.key === 'merged' ? <span className="dash__period">Last 24 hours</span> : null}
      </h2>
      <ul className="list list__rows">
        {items.slice(0, shown).map(item => <Row key={`${item.workspace.id}:${item.change.id}`} item={item} now={now} state={section.key === 'merging'} />)}
      </ul>
      {items.length > shown ? <Button className="dash__more" variant="secondary" size="sm" onClick={() => setShown(shown + 20)}>Show more</Button> : null}
    </section>
  );
}

/** One pull request as a row: the state icon, the title with its label, who and where, and when. The section already names the state, except queued against merging. */
function Row({ item, now, state }: { item: InboxItem; now: number; state: boolean }) {
  const { change, address } = item;
  const repo = `${address.owner}/${address.repo}`;
  return (
    <li className="pr" data-status={change.status}>
      <PullStateIcon status={change.status} />
      <div className="pr__main">
        <div className="pr__title-row">
          <RouterLink href={`${addressPath(address)}/pull/${change.number}`} className="pr__title">
            {change.title}
          </RouterLink>
          {change.label && (change.status === 'attention' || change.status === 'revise') ? <Label tone={labelTone(change.status)}>{change.label}</Label> : null}
        </div>
        <p className="pr__meta">
          <span className="dash__row-meta">
            <span className="pr__repo">{repo} <span className="pr__num">#{change.number}</span></span>
            {state ? <span className="dash__state">{statusLabel(change).label}</span> : null}
          </span>
          <span className="dash__author">{authorLine(change.author)}</span>
        </p>
      </div>
      <RelativeTime at={change.updatedAt} now={now} className="dash__when" />
    </li>
  );
}

/** The person's repositories by organization, as GitHub lists them beside the feed, each with its visibility and how many pull requests are open. */
function Repositories({ teams, open }: { teams: Organization[]; open: Record<string, number> }) {
  const total = teams.reduce((sum, team) => sum + team.workspaces.length, 0);
  // One New repository is the page's; a second per organization only earns its place when there is a choice of organization.
  const owned = teams.filter((team) => team.role === 'owner').length;
  return (
    <section aria-labelledby="repos-title">
      <h2 id="repos-title" className="dash__h2">
        Repositories
        <span className="dash__count">{total}</span>
      </h2>
      {teams.map((team) => (
        <div key={team.id} className="dash__team">
          <h3 className="dash__team-name">
            <RouterLink href={paths.owner(team.slug)}>{team.kind === 'user' ? `@${team.slug}` : team.name}</RouterLink>
            {team.role === 'member' ? <span className="dash__role">Member</span> : null}
          </h3>
          <ul className="dash__repos">
            {team.workspaces.map((workspace) => {
              const count = open[workspace.id];
              return (
                <li key={workspace.id} className="dash__repo">
                  <span className="dash__repo-name">
                    <RouterLink href={paths.owner(team.slug)} className="dash__repo-owner">{team.slug}</RouterLink>
                    <span className="dash__repo-owner">/</span>
                    <RouterLink href={paths.repo({ owner: team.slug, repo: workspace.slug })}>{workspace.slug}</RouterLink>
                  </span>
                  <span className="dash__repo-meta">
                    <span>{workspace.visibility === 'public' ? 'Public' : 'Private'}</span>
                    {count ? (
                      <span className="dash__repo-open" role="img" aria-label={plural(count, 'open pull request')}>
                        <GitPullRequestIcon size={12} aria-hidden="true" />
                        {count}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
            {!team.workspaces.length ? <li className="dash__repo dash__repo--empty">No repositories yet</li> : null}
          </ul>
          {team.role === 'owner' && owned > 1 ? (
            <RouterLink href={paths.newRepository(team.slug)} className="dash__quiet">
              <PlusIcon size={13} aria-hidden="true" />
              New repository
            </RouterLink>
          ) : null}
        </div>
      ))}
      <RouterLink href={paths.repo(EXAMPLE_ADDRESS)} className="dash__quiet dash__example">
        Recorded example
      </RouterLink>
    </section>
  );
}

/** Signed in without a repository: one way to start, with the example beside it; or no organization when sign-up is closed. */
function FirstRun({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="page dash dash--first">
      <header className="dash__head">
        <h1 className="dash__title">Dashboard</h1>
        <PersonalClaim />
      </header>
      <section className="dash__first" aria-labelledby="first-title">
        <GitBranchIcon size={32} className="dash__first-icon" aria-hidden="true" />
        <h2 id="first-title" className="dash__first-title">
          Create your first repository
        </h2>
        <div className="dash__first-actions">
          {canCreate ? (
            <LinkButton variant="primary" href={paths.newRepository()}>
              New repository
            </LinkButton>
          ) : null}
          <LinkButton variant="secondary" href={paths.repo(EXAMPLE_ADDRESS)}>
            Open the example
          </LinkButton>
        </div>
      </section>
    </div>
  );
}

function PersonalClaim() {
  const { account } = useAccount();
  const login = account?.user?.username;
  return login ? <div className="dash__claim"><ClaimOwner slug={login} /></div> : null;
}
