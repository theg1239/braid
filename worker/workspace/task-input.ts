import * as v from 'valibot';
import { contextNote, task, text } from '../schemas';
import { PROVIDER_IDS } from '../../shared/providers';

// Task-only extensions live together so the shared boundary schemas remain unchanged.
export const assignedTask = v.pipe(v.object({
  ...task.entries,
  timeBudgetMinutes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(54))),
  connectionIds: v.optional(v.pipe(v.array(text('Connection', 100)), v.minLength(1), v.maxLength(3),
    v.check(ids => new Set(ids).size === ids.length, 'Choose each connection once.'))),
  /** Braid's agents run on Workers AI unless the person picks one of their own connected providers. */
  provider: v.optional(v.picklist(['workers-ai', ...PROVIDER_IDS], 'Choose Workers AI or a provider you connected.')),
}), v.check(input => !input.connectionIds || input.execution === 'local', 'Connected agents run on your machine.'),
v.check(input => !input.provider || input.provider === 'workers-ai' || input.execution === 'cloud', 'Your providers run Braid’s hosted agents; local agents use their own.'),
v.check(input => !input.connectionIds || input.agentCount === undefined || input.agentCount === input.connectionIds.length,
  'The agent count must match the selected connections.'));

export const taskNote = v.object({
  ...contextNote.entries,
  missionId: v.optional(text('Task', 100)),
});
