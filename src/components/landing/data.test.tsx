import { describe, expect, it } from 'vitest';
import recording from '../../../worker/changes/recorded.json';
import { MERGED, OVERLAP, PROOF, PULLS, STRANDS } from './data';

describe('recorded landing data', () => {
  it('keeps every named pull request with its recorded author and final outcome', () => {
    const outcomes = { landed: 'merged', closed: 'closed', revise: 'sent back', attention: 'needs a person', queued: 'merging', landing: 'merging', open: 'needs a person' };
    for (const pull of PULLS.filter(pull => pull.label.startsWith('#'))) {
      const change = recording.changes.find(change => `#${change.number}` === pull.label)!;
      expect(pull.attempts.at(-1)!.outcome).toBe(outcomes[change.status as keyof typeof outcomes]);
      if (change.author.kind !== 'simulated') expect(STRANDS[pull.strand].model).toBe(change.author.name);
    }
  });

  it('names only checks that failed on the combined result as the reason a pull request went back', () => {
    const failed = PULLS.flatMap(pull => pull.attempts.filter(attempt => attempt.failed).map(attempt => ({ pull, attempt })));
    expect(failed.length).toBeGreaterThan(0);
    for (const { pull, attempt } of failed) {
      expect(attempt.outcome).toBe('sent back');
      const change = recording.changes.find(change => `#${change.number}` === pull.label)!;
      expect(change.checks.some(check => check.label === attempt.failed && check.status === 'failed' && check.source === 'braid')).toBe(true);
    }
  });

  it('lists every pull request the tour merged, in the order main took them, by model, person or the simulated fleet', () => {
    const landed = recording.changes.filter(change => change.status === 'landed').sort((a, b) => a.landedAt!.localeCompare(b.landedAt!) || a.number - b.number);
    expect(MERGED.map(merge => merge.pull)).toEqual(landed.map(change => change.number));
    for (const [index, change] of landed.entries()) {
      const merge = MERGED[index];
      expect(merge.simulated ?? false).toBe(change.author.kind === 'simulated');
      if (change.author.kind === 'agent') expect(merge.by).toBe(change.author.name);
      if (change.author.kind === 'human') expect(merge.by).toBe(`@${change.author.owner.github}`);
    }
  });

  it('draws the proof from #23 as recorded: its commands, where each ran, and its screenshots cropped, not redrawn', () => {
    const proof = recording.changes.find(change => change.number === PROOF.number)!;
    expect(PROOF.commands.map(({ command, where }) => [command, where])).toEqual(proof.evidence!.filter(item => item.kind === 'command').map(item => [item.command, item.source === 'braid' ? 'Braid' : "agent's machine"]));
    expect(PROOF.captured.map(shot => [shot.width, shot.height])).toEqual(proof.evidence!.flatMap(item => (item.kind === 'screenshot' && 'width' in item ? [[item.width, item.height]] : [])));
    PROOF.tight.forEach((shot, index) => {
      expect(shot.width).toBeLessThanOrEqual(PROOF.captured[index].width);
      expect(shot.height).toBeLessThan(PROOF.captured[index].height);
    });
    expect(PROOF.merged).toBe(proof.landedCommit!.slice(0, 7));
  });

  it('shows each version of the contested file by the line that decides it: one waits, the other fails fast', async () => {
    const { TASK } = await import('./demo/data');
    expect(OVERLAP.path).toBe(TASK.conflict);
    expect(OVERLAP.lanes.map(lane => lane.model)).toEqual(['Claude Opus 5.5', 'GPT-6.1 Sol']);
    for (const lane of OVERLAP.lanes) expect(TASK.agents.find(agent => agent.model === lane.model)!.version![lane.number - 1].trim()).toBe(lane.line);
    expect(OVERLAP.lanes[0].line).toContain('setTimeout');
    expect(OVERLAP.lanes[1].line).toContain('throw new RateLimited');
  });

  it('draws #23 with the proof it carries and #73 as the duplicate a person closed', async () => {
    const { PULLS: DEMO, QUEUE } = await import('./demo/data');
    const proof = recording.changes.find(change => change.number === 23)!;
    const shown = DEMO.find(pull => pull.number === 23)!;
    expect(shown.commands.map(({ command }) => command)).toEqual(proof.evidence!.filter(item => item.kind === 'command').map(item => item.command));
    expect(shown.reviews.filter(review => review.app).map(review => review.reviewer)).toEqual(['CodeRabbit', 'Copilot']);
    const held = recording.changes.find(change => change.number === 73)!;
    expect(held.status).toBe('closed');
    expect(held.events.some(event => event.type === 'overlap' && event.message.includes('#51'))).toBe(true);
    expect(DEMO.find(pull => pull.number === 73)!.events.map(event => event.type)).toEqual(['submitted', 'overlap', 'escalated', 'closed']);
    // The merge group the queue view plays is #22 and #23's, combined on the main it found and merged onto it.
    const group = recording.queue.recent.find(each => each.landed.some(landed => landed.number === 23))!;
    expect(QUEUE.group.pulls.map(pull => pull.number)).toEqual(group.landed.map(landed => landed.number).sort((x, y) => x - y));
    expect([QUEUE.group.base, QUEUE.group.head]).toEqual([group.base.slice(0, 7), group.head.slice(0, 7)]);
  });
});

describe('the demo’s recorded rows', () => {
  it('lists the named agents’ pull requests as the recording left them, and none of the simulator’s', async () => {
    const { PULLS } = await import('./demo/data');
    const named = recording.changes.filter(change => change.author.kind !== 'simulated');
    expect(PULLS.map(pull => pull.number).sort((a, b) => a - b)).toEqual(named.map(change => change.number).sort((a, b) => a - b));
    for (const pull of PULLS) {
      const change = named.find(each => each.number === pull.number)!;
      expect(pull.title).toBe(change.title);
      expect(pull.state).toBe(change.status === 'landed' ? 'merged' : change.status === 'closed' ? 'closed' : 'open');
      if (change.author.kind === 'agent') expect(pull.by.model).toBe(change.author.name);
      // Every check and every command is the current version's, with where it ran.
      expect(pull.checks).toHaveLength(change.checks.filter(check => check.revision === change.revision).length);
      for (const command of pull.commands) expect(['Braid', "agent's machine"]).toContain(command.where);
    }
    const proof = PULLS.find(pull => pull.number === 23)!;
    expect(proof.shots.map(shot => [shot.viewport, shot.width, shot.height])).toEqual([['desktop', 1280, 800], ['phone', 390, 844]]);
  });

  it('keeps the fleet to the named model agents, with their recorded counts', async () => {
    const { FLEET } = await import('./demo/data');
    const agents = recording.agents.filter(agent => agent.models[0] !== 'simulated');
    expect(FLEET).toHaveLength(agents.length);
    expect(FLEET.some(agent => /simulated/i.test(agent.model))).toBe(false);
    for (const row of FLEET) {
      const agent = agents.find(each => each.name === row.model && `@${each.owner.github}` === row.owner)!;
      expect([row.merged, row.sentBack, row.open, row.added, row.alive]).toEqual([agent.changes.landed, agent.changes.sentBack, agent.changes.open, agent.lines.added, agent.lines.alive]);
    }
  });

  it('asks the questions and states the rules in the app’s own words', async () => {
    const { PULLS, RULES } = await import('./demo/data');
    expect(PULLS.find(pull => pull.number === 7)!.question).toMatchObject({ label: 'Reviewer flagged', answers: ['Approve and merge', 'Request changes', 'Close pull request'] });
    expect(PULLS.filter(pull => pull.state !== 'open').every(pull => !pull.question)).toBe(true);
    expect(RULES.areas[0]).toMatchObject({ paths: ['src/billing/**'], decides: 'human', note: 'Refunds and invoices need a person.' });
    expect(RULES.checks.commands).toEqual(recording.policy.policy.checks);
    expect(RULES.safeguards).toContain('A pull request that repeats another open one goes to a person.');
  });

  it('draws the task’s two versions of one file and the blame of every file on main', async () => {
    const { BLAME, COMMITS, FILES, TASK } = await import('./demo/data');
    const versions = TASK.agents.filter(agent => agent.version);
    expect(versions.map(agent => agent.model)).toEqual(['Claude Opus 5.5', 'GPT-6.1 Sol']);
    expect(TASK.conflict).toBe('src/limits.ts');
    for (const [path, ranges] of Object.entries(BLAME)) {
      expect(ranges.reduce((sum, [, lines]) => sum + lines, 0), path).toBe(FILES[path].length);
      for (const [, , commit] of ranges) expect(COMMITS[commit], path).toBeDefined();
    }
  });
});
