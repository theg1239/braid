import { defineConfig } from 'vitest/config';
export default defineConfig({ resolve: { alias: { 'cloudflare:workers': new URL('./worker/test/runtime.ts', import.meta.url).pathname } }, test: { include: ['worker/**/*.test.ts', 'shared/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'cli/**/*.test.ts'], environment: 'node', setupFiles: ['./worker/test/setup.ts'],
  // Tests that run real Git share the machine with the whole parallel suite; five seconds is too tight for them there.
  testTimeout: 20_000 } });
