import { LinkButton, Select } from '@cloudflare/kumo';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useDocumentTitle } from '../lib/title';
import { useLive } from '../lib/live';
import { SETTINGS_SECTIONS, navigate, paths, useRoute, type SettingsSection } from '../lib/router';
import { useSnapshot } from '../store/workspace';
import { useAccount } from '../account/AccountProvider';
import { useRepository } from '../account/RepositoryGate';
import { Account } from '../components/settings/Account';
import { AgentReportsSection } from '../components/settings/AgentReports';
import { AgentSettings } from '../components/settings/Agents';
import { General } from '../components/settings/General';
import { GitHubLinkSection } from '../components/settings/GitHubLink';
import { Queue } from '../components/settings/Queue';
import { RepositoryAccess } from '../components/settings/RepositoryAccess';
import { Rules, Security } from '../components/settings/Rules';
import { SettingsEmpty } from '../components/settings/Section';
import { Webhooks } from '../components/settings/Webhooks';
import { RouterLink } from '../components/ui/Link';
import { PageState } from '../components/ui/States';
import '../styles/pages.css';
import '../styles/settings.css';

const TITLES: Record<SettingsSection, string> = { general: 'General', rules: 'Rules', security: 'Code security', queue: 'Merge queue', webhooks: 'Webhooks', agents: 'Agents', github: 'GitHub', collaborators: 'Access', account: 'Account' };

/** Pages that read the repository's files or queue, so they say so until there is one. */
const READ_FROM_REPOSITORY = new Set<SettingsSection>(['rules', 'security', 'queue', 'webhooks']);

/** The sidebar, grouped as GitHub groups repository settings. */
const GROUPS: { label: string | null; items: SettingsSection[] }[] = [
  { label: null, items: ['general'] },
  { label: 'Access', items: ['collaborators'] },
  { label: 'Code and automation', items: ['rules', 'queue', 'webhooks', 'agents'] },
  { label: 'Security', items: ['security'] },
  { label: 'Integrations', items: ['github'] },
  { label: null, items: ['account'] },
];

/**
 * The pages this viewer has: Access for a member of the repository's organization, GitHub once there is a repository,
 * and Account for someone signed in or on the single-owner deployment, whose owner key a visitor elsewhere never needs.
 */
export function settingsSections({ accounts, signedIn, member, repository }: { accounts: boolean; signedIn: boolean; member: boolean; repository: boolean }): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => (section === 'collaborators' ? signedIn && member : section === 'github' ? repository : section === 'account' ? signedIn || !accounts : true));
}

/** Repository settings with GitHub's sidebar. Each section is one page; nothing here explains the product. */
export function SettingsScreen() {
  const snapshot = useSnapshot();
  const route = useRoute();
  const { accounts, account } = useAccount();
  const { team } = useRepository();
  const signedIn = accounts && !!account?.user;
  const reportsAvailable = !!snapshot.project.id && snapshot.capabilities.mode === 'live' && (!!team || (!accounts && snapshot.capabilities.authenticated));
  const reports = useLive(reportsAvailable ? 'agent-reports' : null, api.agentReports, 60_000);
  const reportCount = reports.data?.items.length ?? 0;
  const available = settingsSections({ accounts, signedIn, member: !!team, repository: !!snapshot.project.id });
  const requested = (route.id ?? 'general') as SettingsSection;
  const section = available.includes(requested) ? requested : null;
  const groups = GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => available.includes(item)) })).filter((group) => group.items.length);

  useDocumentTitle(section ? `${TITLES[section]} · Settings · Braid` : 'Page not found · Braid');

  if (!section) return <div className="page"><PageState title="Page not found"><LinkButton variant="secondary" href={paths.settings()}>Back to settings</LinkButton></PageState></div>;

  return (
    <div className="page settings">
      <div className="settings__mobile-nav">
        <Select aria-label="Settings page" value={section} items={available.map(value => ({ value, label: value === 'agents' && reportCount ? `Agents (${reportCount})` : TITLES[value] }))} onValueChange={value => {
          if (available.includes(value as SettingsSection)) navigate(paths.settings(value as SettingsSection));
        }} />
      </div>
      <nav className="settings__nav" aria-label="Settings">
        {groups.map((group, index) => (
          <div key={group.label ?? index} className="settings__group">
            {group.label ? <span className="settings__group-label">{group.label}</span> : null}
            <ul>
              {group.items.map((item) => (
                <li key={item}>
                  <RouterLink href={paths.settings(item)} className="settings__link" aria-current={item === section ? 'page' : undefined}>
                    {TITLES[item]}
                    {item === 'agents' && reportsAvailable ? <span className="settings__report-count" aria-label={reportCount ? plural(reportCount, 'unresolved report') : undefined}>{reportCount || ''}</span> : null}
                  </RouterLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="settings__body">
        <h1 className="settings__title">{TITLES[section]}</h1>
        {section === 'general' ? <General /> : null}
        {!snapshot.project.id && READ_FROM_REPOSITORY.has(section) ? <SettingsEmpty>No repository yet.</SettingsEmpty> : <>
          {section === 'rules' ? <Rules /> : null}
          {section === 'security' ? <Security /> : null}
          {section === 'queue' ? <Queue /> : null}
          {section === 'webhooks' ? <Webhooks /> : null}
        </>}
        {section === 'agents' ? <><AgentSettings signedIn={signedIn} />{reportsAvailable ? <AgentReportsSection live={reports} /> : null}</> : null}
        {section === 'github' ? <GitHubLinkSection /> : null}
        {section === 'collaborators' && team ? <RepositoryAccess organization={team} /> : null}
        {section === 'account' ? <Account signedIn={signedIn} /> : null}
      </div>
    </div>
  );
}
