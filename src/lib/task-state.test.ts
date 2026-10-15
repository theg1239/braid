import { expect, it } from 'vitest';
import type { Mission } from '../../shared/types';
import { isStopped } from './task-state';

it('reads a stopped task from its field, never from its error text', () => {
  const failed = { status: 'failed', error: 'This local task was cancelled by its owner.' } as Mission;
  expect(isStopped(failed)).toBe(false);
  expect(isStopped({ ...failed, cancelled: true })).toBe(true);
  expect(isStopped({ ...failed, status: 'running', cancelled: true })).toBe(false);
});
