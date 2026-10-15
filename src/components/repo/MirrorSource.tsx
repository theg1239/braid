import { useEffect } from 'react';
import type { WorkspaceSnapshot } from '../../../shared/types';
import { refreshOwnerAddresses } from '../../account/addresses';
import type { RepositoryMirror } from '../../account/mirrors';
import { absoluteTime } from '../../lib/format';
import type { Address } from '../../lib/router';

export function MirrorSource({ mirror, address, snapshot }: { mirror: RepositoryMirror; address: Address; snapshot: WorkspaceSnapshot | null }) {
  const copied = !!snapshot?.project.head && !snapshot.importing && !snapshot.branchCopy;
  useEffect(() => {
    // The address predates the import. Read its authoritative sync time once the workspace finishes; a failed read keeps the earlier time.
    if (mirror.importing && copied) void refreshOwnerAddresses(address.owner).catch(() => undefined);
  }, [mirror.importing, copied, address.owner]);
  return <a className="mirror-source" href={mirror.source} title={mirror.syncedAt ? `Synced ${absoluteTime(mirror.syncedAt)}` : undefined}>
    mirrored from github.com/{address.owner}/{address.repo}
  </a>;
}
