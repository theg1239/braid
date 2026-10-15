import { useLive } from '../lib/live';
import { useAccount } from './AccountProvider';
import { accountApi } from './api';

/** The page and its header share an owner read, scoped to the current viewer. */
export function useOwner(slug: string) {
  const { account } = useAccount();
  return useLive(`owner:${slug}:${account?.user?.id ?? 'public'}`, () => accountApi.owner(slug), 60_000);
}
