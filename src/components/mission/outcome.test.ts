import { describe, expect, it } from 'vitest';
import { expectOutcome, outcomeTakesFocus } from './outcome';

describe('focus after a task write', () => {
  it('gives the first outcome of the right kind the focus the button lost, once', () => {
    expectOutcome('choice', 1_000);
    expect(outcomeTakesFocus('choice', false, 1_010)).toBe(false); // the button is still there and focused
    expect(outcomeTakesFocus('choice', true, 1_020)).toBe(true); // it went away: the outcome takes over
    expect(outcomeTakesFocus('choice', true, 1_030)).toBe(false); // the next render leaves focus alone
  });

  it('lets the control that made a merge re-render without taking the focus meant for the pull request', () => {
    expectOutcome('merge', 2_000);
    expect(outcomeTakesFocus('choice', true, 2_010)).toBe(false); // Ready to merge, busy then idle again
    expect(outcomeTakesFocus('merge', true, 2_500)).toBe(true); // the pull request row
  });

  it('does nothing before a write or long after one', () => {
    expect(outcomeTakesFocus('choice', true, 5_000)).toBe(false);
    expectOutcome('choice', 10_000);
    expect(outcomeTakesFocus('choice', true, 20_001)).toBe(false);
  });

  it('never moves focus a person placed elsewhere', () => {
    expectOutcome('merge', 30_000);
    expect(outcomeTakesFocus('merge', false, 30_500)).toBe(false);
    expect(outcomeTakesFocus('merge', false, 31_000)).toBe(false);
    expect(outcomeTakesFocus('merge', true, 31_500)).toBe(true);
  });
});
