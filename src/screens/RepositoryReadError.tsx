import type { Live } from '../lib/live';
import { EmptyPanel, ErrorPanel } from '../components/ui/States';

export function RepositoryReadError({ state, title, notFound }: { state: Pick<Live<unknown>, 'error' | 'errorStatus' | 'refresh' | 'refreshing'>; title: string; notFound: string }) {
  if (!state.error) return null;
  if (state.errorStatus !== null && state.errorStatus >= 400 && state.errorStatus < 500 && state.errorStatus !== 429) {
    return <EmptyPanel title={state.errorStatus === 404 ? notFound : state.error} />;
  }
  return <ErrorPanel title={title} message={state.error} onRetry={() => void state.refresh()} retrying={state.refreshing} />;
}
