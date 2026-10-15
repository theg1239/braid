import type { Organization } from '../../shared/account';
import { InlineEdit } from '../components/settings/InlineEdit';
import { Section } from '../components/settings/Section';
import { navigate, paths } from '../lib/router';
import { useAccount } from './AccountProvider';
import { AddressEditor } from './AddressEditor';
import { accountApi } from './api';

export function OrganizationSettings({ organization, onChange }: { organization: Organization; onChange: () => void }) {
  const { refresh } = useAccount();
  return <Section id="organization" title="General" rows>
    <InlineEdit label="Name" value={organization.name} save={async name => {
      await accountApi.updateOrganization(organization.id, { name }); await refresh(); onChange();
    }} />
    <AddressEditor label="Organization address" slug={organization.slug} save={async slug => {
      const renamed = await accountApi.updateOrganization(organization.id, { slug });
      await refresh(); navigate(paths.organization(renamed.slug, 'settings'), { replace: true });
    }} />
  </Section>;
}
