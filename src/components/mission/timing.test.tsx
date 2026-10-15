import { describe, expect, it } from 'vitest';
import type { Agent, Mission } from '../../../shared/types';
import { agentFixture, missionFixture } from '../../test/fixtures';
import { agentDuration, durationLabel, taskDuration } from './timing';
import { agentByline, recordLabel } from './identity';

const agent = (extra: Partial<Agent>) => agentFixture({ model: 'claude-opus-5-5', owner: { name: 'Maya', github: 'maya-chen' }, status: 'working', ...extra });
const task = (agents: Agent[], status: Mission['status'] = 'review') => missionFixture({ source: 'live', execution: 'local', agents, status });
const start = '2026-10-12T12:00:00Z', end = '2026-10-12T12:02:00Z', later = Date.parse('2026-10-12T13:00:00Z');

describe('task execution durations', () => {
  it('keeps completed agent and task times fixed while they wait for review', () => {
    const run = agent({ status: 'review', startedAt: start, completedAt: end });
    expect(agentDuration(run, later)).toBe(120_000);
    expect(taskDuration(task([run]), later)).toBe(120_000);
    expect(taskDuration(task([run], 'merged'), later + 60_000)).toBe(120_000);
  });
  it('measures parallel wall time, not a sum of agent times', () => {
    const runs = [agent({ startedAt: start, completedAt: end }), agent({ startedAt: '2026-10-12T12:01:00Z', completedAt: '2026-10-12T12:04:00Z' })];
    expect(taskDuration(task(runs), later)).toBe(240_000);
  });
  it('only advances active work and leaves missing time unknown', () => {
    expect(agentDuration(agent({}), later)).toBeNull();
    expect(agentDuration(agent({ startedAt: start }), later)).toBe(3_600_000);
    expect(agentDuration(agent({ status: 'failed', startedAt: start }), later)).toBeNull();
    expect(taskDuration(task([agent({})]), later)).toBeNull();
    expect(taskDuration(task([agent({ startedAt: start })], 'running'), later)).toBe(3_600_000);
  });
  it('leaves a replayed run, finished the instant it started, untimed', () => {
    const replayed = agent({ status: 'review', startedAt: start, completedAt: start });
    expect(agentDuration(replayed, later)).toBeNull();
    expect(taskDuration(task([replayed]), later)).toBeNull();
    expect(agentDuration(agent({ startedAt: new Date(later).toISOString() }), later)).toBe(0);
  });
  it('formats short and long durations without cost estimates', () => {
    expect([0, 12_000, 65_000, 3_661_000, 24_590_000, 90_000_000, -1000].map(durationLabel)).toEqual(['0s', '12s', '1m 5s', '1h 1m', '6h 49m', '1d 1h', '0s']);
  });
});

describe('task record display names', () => {
  it('uses model and owner while preserving stored record paths', () => {
    const run = agent({});
    expect(agentByline(run)).toBe('Claude Opus 5.5 for @maya-chen');
    expect(recordLabel(task([run]), 'atlas.md')).toBe('Claude Opus 5.5.md');
    expect(run.id).toBe('atlas');
    expect(recordLabel(task([run]), 'handoff.md')).toBe('handoff.md');
  });
});
