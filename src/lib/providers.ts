import type { ProviderConnection } from '../../shared/providers';
import { request } from './api';

/** The person's own provider keys, as Settings and the task composer read them; the answer never holds a key. */
export const PROVIDERS_KEY = 'providers';
export const readProviders = () => request<{ providers: ProviderConnection[] }>('/api/providers');
