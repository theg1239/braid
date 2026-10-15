/**
 * Model providers a person connects with their own key for Braid's hosted agents. Workers AI needs no key and stays
 * the default. Subscription plans (ChatGPT, Claude) run from the person's machine with their own CLI login.
 */
export const PROVIDER_IDS = ['openai', 'anthropic', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDERS: Record<ProviderId, { name: string; keys: string; prefix: string }> = {
  openai: { name: 'OpenAI', keys: 'https://platform.openai.com/api-keys', prefix: 'sk-' },
  anthropic: { name: 'Anthropic', keys: 'https://console.anthropic.com/settings/keys', prefix: 'sk-ant-' },
  openrouter: { name: 'OpenRouter', keys: 'https://openrouter.ai/settings/keys', prefix: 'sk-or-' },
};

/** One limit as the provider last reported it: requests or tokens per window, or prepaid credit in US dollars. */
export interface ProviderLimit { kind: 'requests' | 'tokens' | 'credit'; remaining: number; limit?: number; resetsAt?: string }

/**
 * A connected provider as its owner sees it. The key itself never leaves the server after it is saved.
 * `status` is `rejected` once the provider refuses the key, and `limited` while it reports no capacity or credit.
 */
export interface ProviderConnection {
  provider: ProviderId;
  model: string;
  models: string[];
  connectedAt: string;
  lastUsedAt?: string;
  status: 'ready' | 'rejected' | 'limited';
  /** The last failure, in Braid's words; never the provider's text. */
  error?: string;
  limits?: ProviderLimit[];
  checkedAt?: string;
}
