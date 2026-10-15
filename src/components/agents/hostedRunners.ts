import { useState } from 'react';
import { PROVIDERS } from '../../../shared/providers';
import { modelName } from '../../../shared/models';
import type { HostedRunner } from '../../lib/api';
import { useLive } from '../../lib/live';
import { PROVIDERS_KEY, readProviders } from '../../lib/providers';

/**
 * What Braid's hosted agents can run on for this person: Workers AI, and each provider they connected whose key the
 * provider has not rejected. A choice whose provider is gone falls back to Workers AI here, in the picker, where the
 * person sees it; the server never substitutes one provider for another.
 */
export function useHostedRunners(enabled: boolean, initial: HostedRunner = 'workers-ai') {
  const providers = useLive(enabled ? PROVIDERS_KEY : null, readProviders, 60_000);
  const usable = (providers.data?.providers ?? []).filter((item) => item.status !== 'rejected');
  const [picked, pick] = useState<HostedRunner>(initial);
  const runner: HostedRunner = usable.some((item) => item.provider === picked) ? picked : 'workers-ai';
  const items = [{ value: 'workers-ai', label: 'Workers AI' }, ...usable.map((item) => ({ value: item.provider, label: `${modelName(item.model)} · ${PROVIDERS[item.provider].name}` }))];
  return { runner, pick, items };
}
