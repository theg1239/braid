import { Badge } from '@cloudflare/kumo';
import { GithubLogoIcon } from '@phosphor-icons/react';
import type { GitHubLinkStatus } from '../../../shared/types';
import { relativeTime, shortHash } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { BADGE } from '../ui/Status';
import { Row } from './Section';
import { RelativeTime } from '../ui/Time';

const LINK_STATUS: Record<GitHubLinkStatus['status'], { label: string; tone: 'success' | 'warning' | 'error' | 'neutral' }> = {
  synced: { label: 'In sync', tone: 'success' },
  behind: { label: 'Behind', tone: 'warning' },
  diverged: { label: 'Diverged', tone: 'error' },
  error: { label: 'Error', tone: 'error' },
};
const LINK_MODE: Record<GitHubLinkStatus['mode'], string> = { 'pull-requests': 'Through pull requests', mirror: 'Main is mirrored' };

/** How this repository relates to GitHub, as rows. */
export function GitHubSummary({ link, recorded = false }: { link: GitHubLinkStatus; recorded?: boolean }) {
  const now = useNow();
  const status = LINK_STATUS[link.status];
  return (
    <>
      <Row label="Repository" hint={link.message}>
        {recorded ? <span className="gh__name mono"><GithubLogoIcon size={15} aria-hidden="true" />{link.fullName}</span> : <a href={`https://github.com/${link.fullName}`} target="_blank" rel="noreferrer" className="gh__name mono text-link">
          <GithubLogoIcon size={15} aria-hidden="true" />
          {link.fullName}
        </a>}
        <Badge variant={BADGE[status.tone]}>{status.label}</Badge>
      </Row>
      <Row label="Merges" hint={link.mirroredHead ? `Mirrored at ${shortHash(link.mirroredHead)}` : undefined}>
        <span className="srow__value">
          {LINK_MODE[link.mode]} on <span className="mono">{link.defaultBranch}</span>
        </span>
      </Row>
      <Row label="Linked" hint={link.checkedAt ? `Checked ${relativeTime(link.checkedAt, now)}` : undefined}>
        <span className="srow__value">
          by {recorded ? '@maya-chen' : link.linkedBy}{' '}
          <RelativeTime at={link.linkedAt} now={now} />
        </span>
      </Row>
    </>
  );
}
