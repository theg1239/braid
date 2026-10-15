import type { Agent, Mission } from '../../shared/types';

/** An agent with every required field, for tests that set only the fields they check. */
export const agentFixture = (over: Partial<Agent> = {}): Agent => ({
  id: 'atlas', name: 'Claude Opus 5.5', role: '', color: '', status: 'review', task: '', scope: [], summary: '', rationale: '', checks: [], changes: [], ...over,
});

/** A task with every required field, for tests that set only the fields they check. */
export const missionFixture = (over: Partial<Mission> = {}): Mission => ({
  id: 'task', title: 'Task', intent: '', status: 'review', createdAt: '2026-10-12T12:00:00Z', baseCommit: 'a', agents: [], collisions: [], source: 'demo', execution: 'cloud', ...over,
});

/** The words rendered markup shows, with tags and runs of whitespace as single spaces. */
export const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
