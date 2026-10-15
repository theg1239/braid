import { vi } from 'vitest';

/** The Workers cache, as one data center keeps it: one store for the test that asks for it. */
export function edgeCache() {
  const kept = new Map<string, Response>();
  vi.stubGlobal('caches', { open: async () => ({ match: async (request: Request) => kept.get(request.url)?.clone(), put: async (request: Request, response: Response) => { kept.set(request.url, response); } }) });
  return kept;
}
