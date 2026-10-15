import { describe, expect, it } from 'vitest';
import { integrationAuthors, integrationPreview } from './integration';
import { composeChanges } from './domain';
import { seedWorkspace } from './seed';
import type { ChangeAuthor, Mission } from '../../shared/types';

const capabilities = { mode: 'demo' as const, artifacts: true, ai: true, storage: 'durable-object' as const, authenticated: false, model: 'test', namespace: 'test', canWrite: false };
const fixture = () => seedWorkspace('demo', capabilities);
function decide(mission: Mission, agentId = 'sable', reason = 'Keep the latency budget bounded.') {
  mission.collisions[0].resolution = { agentId, reason, resolvedAt: new Date().toISOString() };
}

describe('integration preview', () => {
  it.each(['atlas', 'sable'])('attributes collisions and identical content to the chosen %s proposal, and independent files to their proposer', agentId => {
    const { missions: [mission] } = fixture(); decide(mission, agentId);
    const authors = Object.fromEntries(mission.agents.map(agent => [agent.id, { kind: 'agent', id: agent.id, name: agent.name, model: agent.model, owner: agent.owner } satisfies ChangeAuthor]));
    const files = integrationAuthors(mission, authors);
    expect(files['src/limits.ts']).toBe(authors[agentId]);
    expect(files['src/delivery.ts']).toBe(authors[agentId]);
    expect(files['docs/receivers.md']).toBe(authors.reed);
  });
  it('falls back to the first proposer for identical content when no chosen agent proposed it, excluding skipped work', () => {
    const { missions: [mission] } = fixture();
    const [first, second, third] = mission.agents;
    first.changes = first.changes.filter(file => file.path === 'src/delivery.ts');
    second.changes = second.changes.filter(file => file.path === 'src/delivery.ts');
    mission.collisions = [{ id: 'doc-choice', path: 'docs/receivers.md', agentIds: [third.id], resolution: { agentId: third.id, reason: '', resolvedAt: '' } }];
    const authors = Object.fromEntries(mission.agents.map(agent => [agent.id, { kind: 'agent', id: agent.id, name: agent.name } satisfies ChangeAuthor]));
    expect(integrationAuthors(mission, authors)['src/delivery.ts']).toBe(authors[first.id]);
    first.status = 'skipped';
    expect(integrationAuthors(mission, authors)['src/delivery.ts']).toBe(authors[second.id]);
  });
  it('separates disagreement from identical contributions without inventing a shipping version', async () => {
    const { missions: [mission], context } = fixture();
    const preview = await integrationPreview(mission, mission.baseCommit, context);
    expect(preview.ready).toBe(false);
    expect(preview.totals).toMatchObject({ files: 3, independent: 1, agreements: 1, unresolved: 1, selected: 0 });
    expect(preview.files.find(f => f.path === 'src/limits.ts')?.change).toBeNull();
    expect(preview.files.find(f => f.path === 'src/delivery.ts')?.versions.every(v => v.selected)).toBe(true);
    expect(preview.checks.find(c => c.label === 'Runtime tests')?.status).toBe('warning');
    // The merge view reads what each of Braid's checks stands for from its kind.
    expect(preview.checks.map(c => c.kind)).toEqual(['proposals', 'decisions', 'base', 'patch', 'runtime']);
    expect(preview.checks.find(c => c.label === 'Patch validation')?.status).toBe('warning');
  });
  it('previews exactly the changes that integration writes and preserves decisions in the handoff', async () => {
    const { missions: [mission], context } = fixture(); decide(mission);
    const preview = await integrationPreview(mission, mission.baseCommit, context);
    expect(preview.ready).toBe(true);
    expect(Object.fromEntries(preview.files.map(f => [f.path, f.change!.after]))).toEqual({ ...composeChanges(mission) });
    expect(preview.totals).toMatchObject({ additions: 27, deletions: 0 });
    expect(preview.handoff).toContain('Keep the latency budget bounded.');
    expect(preview.handoff).toContain('Competing alternatives');
    expect(preview.handoff).toContain('not a Git commit');
    expect(preview.handoff).toContain('Not executed');
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('keeps the fingerprint stable when display order or lifecycle status changes', async () => {
    const { missions: [mission], context } = fixture(); decide(mission);
    const preview = await integrationPreview(mission, mission.baseCommit, context);
    mission.agents.reverse(); mission.agents.forEach(a => { a.changes.reverse(); a.status = 'merged'; });
    mission.status = 'merged'; mission.mergeCommit = 'new-main';
    const merged = await integrationPreview(mission, 'new-main', [...context].reverse());
    expect(merged.fingerprint).toBe(preview.fingerprint);
    expect(merged.ready).toBe(false);
    expect(merged.handoff).toContain('new-main');
  });
  it('invalidates the review for a changed choice, decision reason, proposal, or frozen constraint', async () => {
    const { missions: [mission], context } = fixture(); decide(mission);
    const preview = await integrationPreview(mission, mission.baseCommit, context);
    for (const edit of [
      (m: Mission) => decide(m, 'atlas'),
      (m: Mission) => decide(m, 'sable', 'A different policy decision.'),
      (m: Mission) => { m.agents[0].changes[0].after += '\n// changed alternative'; },
      (m: Mission) => { m.agents[1].rationale += ' Changed evidence.'; },
    ]) {
      const changed = structuredClone(mission); edit(changed);
      expect((await integrationPreview(changed, changed.baseCommit, context)).fingerprint).not.toBe(preview.fingerprint);
    }
    const changedContext = structuredClone(context); changedContext[0].body += ' New constraint.';
    expect((await integrationPreview(mission, mission.baseCommit, changedContext)).fingerprint).not.toBe(preview.fingerprint);
  });
  it('snapshots before asynchronous hashing and does not substitute current context for unavailable history', async () => {
    const { missions: [mission] } = fixture(); decide(mission);
    const pending = integrationPreview(mission, mission.baseCommit, null);
    decide(mission, 'atlas');
    const preview = await pending;
    expect(preview.files.find(f => f.path === 'src/limits.ts')?.versions.find(v => v.selected)?.agentId).toBe('sable');
    expect(preview.contextAvailable).toBe(false);
    expect(preview.handoff).toContain('original context snapshot is unavailable');
  });
  it('blocks a stale base even when every version has been chosen', async () => {
    const { missions: [mission], context } = fixture(); decide(mission);
    const preview = await integrationPreview(mission, 'new-main', context);
    expect(preview.ready).toBe(false);
    expect(preview.checks.find(c => c.label === 'Base revision')?.status).toBe('failed');
    expect(preview.blocker).toMatch(/branch changed/);
  });
});
