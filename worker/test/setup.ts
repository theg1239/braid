import { beforeEach } from 'vitest';

// The Workers runtime always has the data center's cache; Node does not. Every test starts with an empty one, set as a
// plain global so a suite that unstubs its own globals keeps it. A test that wants to inspect the cache calls `edgeCache()`.
const kept = new Map<string, Response>();
Object.defineProperty(globalThis, 'caches', { configurable: true, writable: true, value: { open: async () => ({ match: async (request: Request) => kept.get(request.url)?.clone(), put: async (request: Request, response: Response) => { kept.set(request.url, response); } }) } });
beforeEach(() => kept.clear());
