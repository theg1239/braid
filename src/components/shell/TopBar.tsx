import { useHeaderCounts } from '../../lib/needs';
import { useRepository } from '../../account/RepositoryGate';
import { RepositoryHeader, type HeaderProps } from './RepositoryHeader';
import { useMirror } from '../../account/mirrors';
import { useWorkspace } from '../../store/workspace';

export function TopBar(props: Required<HeaderProps>) {
  const { address, visibility } = useRepository();
  const counts = useHeaderCounts(props.snapshot);
  const mirror = useMirror();
  const { refresh } = useWorkspace();
  return <RepositoryHeader {...props} address={address} visibility={visibility} counts={counts} mirror={mirror} onClaimed={refresh} />;
}
