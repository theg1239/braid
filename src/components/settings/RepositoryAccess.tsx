import { LinkButton } from '@cloudflare/kumo';
import type { Organization } from '../../../shared/account';
import { accountApi } from '../../account/api';
import { useRepository } from '../../account/RepositoryGate';
import { useLive } from '../../lib/live';
import { paths } from '../../lib/router';
import { SkeletonRows } from '../ui/Skeleton';
import { ErrorPanel } from '../ui/States';
import { RouterLink } from '../ui/Link';
import { Row, Section, SettingsEmpty } from './Section';

export function RepositoryAccess({ organization }: { organization: Organization }) {
  const { workspace } = useRepository();
  const access = useLive(workspace ? `org-access:${organization.id}:${workspace.id}` : null, () => accountApi.repositoryAccess(organization.id, workspace!.id), 30_000);
  if (access.error) return <ErrorPanel title="Couldn’t load access" message={access.error} onRetry={() => void access.refresh()} />;
  if (!access.data) return <SkeletonRows rows={4} detail height={64} label="Loading access" />;
  return <>
    <Section id="access-owners" title={organization.kind === 'user' ? 'Owner' : 'Organization owners'} rows>
      {access.data.owners.map(member => <Row key={member.id} label={member.name}><span className="srow__value">Owner</span></Row>)}
    </Section>
    {organization.kind !== 'user' ? <Section id="access-teams" title="Teams" rows foot={<LinkButton variant="secondary" href={paths.organization(organization.slug, 'teams')}>Manage access in organization</LinkButton>}>
      {access.data.teams.length ? access.data.teams.map(team => <Row key={team.id} label={<RouterLink href={paths.organizationTeam(organization.slug, team.slug, 'repositories')}>{team.name}</RouterLink>}><span className="srow__value">{team.permission === 'write' ? 'Write' : 'Read'}</span></Row>) : <SettingsEmpty>No team access.</SettingsEmpty>}
    </Section> : null}
  </>;
}
