import { useAccount } from '../account/AccountProvider';
import { CreateOrganizationForm } from '../account/OrganizationSetup';
import { useDocumentTitle } from '../lib/title';
import '../styles/new.css';
import '../styles/account.css';

export function NewOrganizationScreen() {
  const { account } = useAccount();
  useDocumentTitle('New organization · Braid');
  return <div className="page new-repo">
    <header className="new-repo__head"><h1>New organization</h1></header>
    <div className="new-repo__card">{account?.signupEnabled ? <CreateOrganizationForm /> : <p>Ask an organization owner for an invitation.</p>}</div>
  </div>;
}
