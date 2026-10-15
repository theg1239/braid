import { buildChoiceParser, buildCommand } from '@stricli/core';
import { print, type BraidContext } from '../context';
import type { RepositoryStats } from '../schemas';
import { collectStats, type StatsOptions } from '../stats';
import { columns, count, plain } from '../terminal';

function statsTable(result: RepositoryStats) {
  const skipped = Object.entries(result.skipped).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`);
  return [
    `${plain(result.repository).replace(/\s/g, ' ')} · ${count(result.lines, 'line')} · ${count(result.files, 'file')}`,
    ...columns([['Author', 'Lines', '%'], ...result.rows.map(row => [row.name, row.lines.toLocaleString('en-US'), `${(row.share * 100).toFixed(1)}%`])]),
    ...(skipped.length ? [`Skipped: ${skipped.join(', ')}`] : []),
  ];
}

async function stats(this: BraidContext, flags: StatsOptions & { json?: boolean }, ...paths: string[]) {
  const result = await collectStats(this, paths, flags);
  if (flags.json) { print(this, JSON.stringify(result, null, 2)); return; }
  for (const row of statsTable(result)) print(this, row);
}

export const statsCommand = buildCommand({
  func: stats,
  parameters: {
    flags: {
      since: { kind: 'parsed', parse: String, brief: 'Only lines last changed by commits after this date, as Git reads it', placeholder: 'date', optional: true },
      by: { kind: 'parsed', parse: buildChoiceParser(['model', 'owner', 'tool'] as const), brief: 'Group agents by model, owner or tool', placeholder: 'model|owner|tool', optional: true },
      json: { kind: 'boolean', brief: 'Print repository statistics as JSON', optional: true },
    },
    positional: { kind: 'array', parameter: { brief: 'Tracked paths to count, relative to this directory', parse: String, placeholder: 'path' } },
  },
  docs: { brief: 'Count lines by agent, person or bot at HEAD, in any clone' },
});
