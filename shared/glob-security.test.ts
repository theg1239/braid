import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { parsePolicy } from './policy-file';

it('bounds the cost of an adversarial policy glob', () => {
  const pattern = '*a'.repeat(12) + 'z';
  const policy = parsePolicy(JSON.stringify({ rules: [{ paths: [pattern], autonomy: 'auto' }] }));
  if (policy.errors.length) return; // Rejecting unsafe patterns at the policy boundary is also safe.
  const module = new URL('./glob.ts', import.meta.url).href;
  // A subprocess deadline prevents the vulnerable synchronous matcher from hanging Vitest.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {matchesGlob} from ${JSON.stringify(module)}; console.log(JSON.stringify([matchesGlob('a'.repeat(80), ${JSON.stringify(pattern)}), matchesGlob('a'.repeat(80)+'z', ${JSON.stringify(pattern)})]));`],
  { timeout: 1000, encoding: 'utf8' });
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual([false, true]);
});
