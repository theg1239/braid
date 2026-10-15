import { useState } from 'react';
import { Button, useKumoToastManager } from '@cloudflare/kumo';
import { refreshLive, useLive } from '../lib/live';
import { useAccount } from './AccountProvider';
import { refreshOwnerAddresses } from './addresses';
import { claimOwner, ownerClaim } from './mirrors';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import '../components/shell/dialogs.css';

/** Eligibility comes from GitHub's verified account or organization membership, never a matching display name. */
export function ClaimOwner({ slug, claimable, onClaimed }: { slug: string; claimable?: boolean; onClaimed?: () => void | Promise<unknown> }) {
  const { account, refresh } = useAccount();
  const eligibility = useLive(claimable === undefined && account?.user ? `claim:${slug}:${account.user.id}` : null, () => ownerClaim(slug), 60_000);
  const [open, setOpen] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const toasts = useKumoToastManager();
  const { link, owned, kind } = eligibility.data ?? {};
  // What GitHub confirmed, in the words of the case: the person's own account, or an organization they administer.
  const proof = kind === 'user' ? `you are @${slug}` : kind === 'organization' ? `you are an admin of ${slug}` : `you own this account or administer this organization`;
  const action = link ? `Link @${slug} to GitHub` : owned ? `Turn on Braid for @${slug}’s mirrors` : `Claim @${slug}`;
  const claim = async () => {
    await claimOwner(slug);
    toasts.add({ title: link ? `@${slug} is linked to GitHub.` : owned ? `Braid is on for @${slug}’s mirrors.` : `You now own @${slug} on Braid.`, variant: 'success' });
    await Promise.all([refresh(), refreshOwnerAddresses(slug)]);
    refreshLive(`owner:${slug}:`);
    refreshLive(`claim:${slug}:`);
    await onClaimed?.();
    setClaimed(true);
  };
  if (claimed || !(claimable ?? eligibility.data?.claimable)) return null;
  return <>
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{action}</Button>
    {open ? <ConfirmDialog open title={action} variant="primary" onConfirm={claim} onClose={() => setOpen(false)}
      confirmLabel={link ? 'Link' : owned ? 'Turn on' : `Claim @${slug}`}
      description={link ? `GitHub confirms you are an admin of ${slug}, so its repositories open on Braid under @${slug}.`
        : owned ? `The GitHub repositories you opened under @${slug} are read-only on Braid. GitHub confirms ${proof}, so this turns on pull requests and agents for them.`
        : `You become the owner of @${slug} on Braid, because GitHub confirms ${proof}.`} /> : null}
  </>;
}
