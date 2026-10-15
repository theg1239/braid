import { Banner, LinkButton } from '@cloudflare/kumo';
import { PlayCircleIcon } from '@phosphor-icons/react';
import { paths } from '../../lib/router';
import { useAccount } from '../../account/AccountProvider';
import { EXAMPLE_SESSION_LIMIT } from '../../../shared/errors';

/** The one place the recorded example says what it is. */
export function ExampleBanner({ limited = false }: { limited?: boolean }) {
  const { accounts, account } = useAccount();
  const [href, label] = !accounts ? [paths.settings('account'), 'Use your own repository'] : account?.user ? [paths.site(), 'Your repositories'] : [paths.signin(paths.newRepository()), 'Use your own repository'];
  return (
    <section className="app-notice app-notice--example" aria-label="Recorded example">
      <Banner variant="secondary" size="sm" icon={<PlayCircleIcon weight="fill" />} description={limited ? EXAMPLE_SESSION_LIMIT : 'Recorded example'} action={<LinkButton size="sm" variant="secondary" href={href} className="example-action">{label}</LinkButton>} />
    </section>
  );
}
