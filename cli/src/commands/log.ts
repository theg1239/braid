import { buildCommand, numberParser } from '@stricli/core';
import { NOTES_REF, type CommitFacts } from '../../../shared/provenance';
import type { Provenance } from '../../../shared/types';
import { fail, print, type BraidContext } from '../context';
import { hasCommit, noteIndex, streamCommits } from '../git';
import { authorLabel, changeLabel, historyLogins, matches, ownerLabel, personLogins, provenances } from '../present';
import { openRepository } from '../repository';
import { redact } from '../secrets';
import { age, columns, colours, fitLast } from '../terminal';

interface Flags { agent?: string; model?: string; owner?: string; since?: string; limit: number; json?: boolean }

async function log(this: BraidContext, flags: Flags) {
  if (!Number.isInteger(flags.limit) || flags.limit < 1) fail('Use -n with a whole number of commits, such as -n 20.');
  const { root } = openRepository(this);
  const found: Provenance[] = [];
  if (hasCommit(this, root, 'HEAD')) {
    const index = noteIndex(this, root, NOTES_REF), batch: CommitFacts[] = [];
    const filtered = !!(flags.agent || flags.model || flags.owner);
    const take = () => { for (const provenance of provenances(this, root, batch.splice(0), index)) if (found.length < flags.limit && matches(provenance, flags)) found.push(provenance); };
    for await (const commit of streamCommits(this, root, [...(flags.since ? [`--since=${flags.since}`] : []), ...(filtered ? [] : ['-n', String(flags.limit)]), 'HEAD'])) {
      batch.push(commit);
      if (batch.length >= 200) { take(); if (found.length >= flags.limit) break; }
    }
    take();
  }
  if (flags.json) { print(this, JSON.stringify(found, null, 2)); return; }
  const logins = personLogins(found.map(provenance => provenance.owner), found.length ? await historyLogins(this, root) : []);
  const paint = colours(this), now = this.now();
  const rows = found.map(provenance => [provenance.commit.slice(0, 8), age(provenance.at, now), authorLabel(provenance, logins), ownerLabel(provenance, logins), changeLabel(provenance), redact(provenance.subject)]);
  fitLast(this, rows);
  for (const row of columns(rows, (cell, column, index) => column === 0 ? paint.yellow(cell) : column === 2 && found[index].kind === 'agent' ? paint.cyan(cell) : column === 1 || column === 3 ? paint.dim(cell) : cell)) print(this, row);
}

export const logCommand = buildCommand({
  func: log,
  parameters: {
    flags: {
      agent: { kind: 'parsed', parse: String, brief: 'Only commits by this agent, such as "Claude Opus 5.5" or copilot', placeholder: 'name', optional: true },
      model: { kind: 'parsed', parse: String, brief: 'Only commits by this model, by id or display name', placeholder: 'model', optional: true },
      owner: { kind: 'parsed', parse: String, brief: 'Only work by this person or their agents: name, @login or address', placeholder: 'person', optional: true },
      since: { kind: 'parsed', parse: String, brief: 'Only commits after this date, as git log reads it, such as 2.weeks or 2026-10-01', placeholder: 'date', optional: true },
      limit: { kind: 'parsed', parse: numberParser, brief: 'How many commits to show', placeholder: 'n', default: '20' },
      json: { kind: 'boolean', brief: 'Print the provenance of each commit as JSON', optional: true },
    },
    aliases: { n: 'limit' },
  },
  docs: { brief: 'Show recent commits with the agent, person or bot behind each' },
});
