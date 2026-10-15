import { useAccount } from '../account/AccountProvider';
import { useRoute } from '../lib/router';
import { SearchScreen as RepositorySearchScreen } from './SearchScreen';
import { GlobalSearchScreen } from './GlobalSearchScreen';

/** Both search routes share one chunk; a standalone workspace keeps its repository search. */
export function SearchScreen() {
  const { accounts } = useAccount();
  return useRoute().screen === 'global-search' && accounts ? <GlobalSearchScreen /> : <RepositorySearchScreen />;
}
