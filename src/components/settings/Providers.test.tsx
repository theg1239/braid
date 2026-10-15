import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '../../../shared/providers';
import { Providers } from './Providers';

const live = vi.hoisted(() => ({ data: { providers: [] } as { providers: ProviderConnection[] } | null, error: null as string | null, refreshing: false, refresh: vi.fn() }));
vi.mock('../../lib/live', () => ({ useLive: () => live, setLive: vi.fn() }));
vi.mock('@cloudflare/kumo', async original => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));
afterEach(() => { live.data = { providers: [] }; live.error = null; });

it('offers keyless Workers AI and API-key providers while keeping subscription plans local', () => {
  const html = renderToStaticMarkup(<Providers />);
  for (const name of ['OpenAI', 'Anthropic', 'OpenRouter']) expect(html).toContain(name);
  expect(html).toContain('Workers AI'); expect(html).toContain('No key needed'); expect(html).toContain('Default');
  expect(html).toContain('ChatGPT and Claude plans'); expect(html).toContain('Run from your machine');
});

it('keeps every named row while provider connections load, without offering writes', () => {
  const ready = renderToStaticMarkup(<Providers />);
  live.data = null;
  const pending = renderToStaticMarkup(<Providers />);
  for (const name of ['Workers AI', 'OpenAI', 'Anthropic', 'OpenRouter', 'ChatGPT and Claude plans']) expect(pending).toContain(name);
  expect(pending.match(/class="srow(?: srow--compact)?"/g)).toHaveLength(5);
  expect(ready.match(/class="srow(?: srow--compact)?"/g)).toHaveLength(5);
  expect(pending).toContain('aria-busy="true"');
  expect(pending).not.toContain('Loading providers');
  expect(pending).not.toContain('>Connect<');
});

it('keeps the rows and exposes retry when the provider read fails', () => {
  live.data = null; live.error = 'Could not read providers.';
  const html = renderToStaticMarkup(<Providers />);
  for (const name of ['OpenAI', 'Anthropic', 'OpenRouter']) expect(html).toContain(name);
  expect(html).toContain('Could not read providers.');
  expect(html).toContain('Try again');
  expect(html).not.toContain('aria-busy="true"');
  expect(html).not.toContain('skeleton-line');
  expect(html).not.toContain('>Connect<');
});
