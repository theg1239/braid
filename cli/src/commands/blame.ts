import { buildCommand } from '@stricli/core';
import { posix } from 'node:path';
import { fileProvenance, parsePerson } from '../../../shared/provenance';
import type { BlameRange, FileBlame, Provenance } from '../../../shared/types';
import type { Braid } from '../api';
import { CliError, fail, print, type BraidContext } from '../context';
import { blame, gitText, gitTry, readCommits, resolveCommit, ZERO } from '../git';
import { authorLabel, changeLabel, historyLogins, ownerLabel, personLogins, provenances } from '../present';
import { maybeConnect, openRepository } from '../repository';
import { provenanceList } from '../schemas';
import { redact } from '../secrets';
import { age, columns, colours, fitLast } from '../terminal';

function uncommitted(context: BraidContext, root: string): Provenance {
  const ident = gitTry(context, ['var', 'GIT_AUTHOR_IDENT'], { cwd: root });
  const person = ident.status === 0 ? parsePerson(ident.stdout.toString('utf8').replace(/\s+\d+\s+[+-]\d{4}\s*$/, '')) : { name: 'You' };
  return { commit: '0'.repeat(40), at: new Date(context.now()).toISOString(), subject: 'Not committed yet', kind: 'human', owner: person, confidence: 'inferred' };
}

export function blameFile(context: BraidContext, root: string, path: string, revision?: string) {
  const prefix = gitText(context, ['rev-parse', '--show-prefix']);
  const file = posix.normalize(posix.join(prefix, path.replaceAll('\\', '/')));
  if (file.startsWith('../') || file === '..' || posix.isAbsolute(file) || file === '.') fail(`${path} is not a file in this repository.`);
  const commit = revision ? resolveCommit(context, root, revision) : undefined;
  const lines = blame(context, root, file, commit);
  const ids = [...new Set(lines.map(line => line.commit))];
  const facts = readCommits(context, root, ids);
  const known = new Map(provenances(context, root, [...facts.values()]).map(provenance => [provenance.commit, fileProvenance(provenance, file)]));
  let pending: Provenance | undefined;
  const provenanceOf = (id: string) => ZERO.test(id) ? pending ??= uncommitted(context, root) : known.get(id) ?? fail(`Git did not return commit ${id}.`);
  const ranges: BlameRange[] = [];
  lines.forEach((line, index) => {
    const provenance = provenanceOf(line.commit), last = ranges.at(-1);
    if (last?.provenance === provenance) last.lines++;
    else ranges.push({ start: index + 1, lines: 1, provenance });
  });
  const result: FileBlame = { path: file, ref: revision ?? 'HEAD', lines: lines.length, ranges };
  return { blame: result, text: lines.map(line => line.text) };
}

export async function upgrade(braid: Braid, result: FileBlame) {
  const ids = [...new Set(result.ranges.map(range => range.provenance.commit))].filter(id => /^[a-f0-9]{40}$/.test(id) && !ZERO.test(id));
  const witnessed = new Map<string, Provenance>();
  try {
    for (let index = 0; index < ids.length; index += 100) {
      for (const record of await braid.get(`/api/provenance?commits=${ids.slice(index, index + 100).join(',')}`, provenanceList)) if (record.confidence === 'braid') witnessed.set(record.commit, fileProvenance(record, result.path));
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error; /* Offline, or a Braid without the endpoint: the local answer stands. */
  }
  return witnessed.size ? { ...result, ranges: result.ranges.map(range => ({ ...range, provenance: witnessed.get(range.provenance.commit) ?? range.provenance })) } : result;
}

function blameTable(context: BraidContext, result: FileBlame, text: readonly string[], history: Iterable<string>) {
  const paint = colours(context), now = context.now();
  const logins = personLogins(result.ranges.map(range => range.provenance.owner), history);
  const rows = [['Lines', 'Author', 'Owner', 'Pull request', 'Age', 'Code'], ...result.ranges.map(range => [
    range.lines === 1 ? String(range.start) : `${range.start}-${range.start + range.lines - 1}`,
    ZERO.test(range.provenance.commit) ? 'Not committed' : authorLabel(range.provenance, logins),
    ownerLabel(range.provenance, logins), changeLabel(range.provenance), age(range.provenance.at, now),
    redact(text[range.start - 1]?.trim() ?? ''),
  ])];
  fitLast(context, rows);
  return columns(rows, (cell, column, index) => {
    if (index === 0) return paint.dim(cell);
    const range = result.ranges[index - 1];
    if (column === 1) return range.provenance.kind === 'agent' ? paint.cyan(cell) : ZERO.test(range.provenance.commit) ? paint.dim(cell) : cell;
    return column === 3 ? paint.yellow(cell) : column === 5 ? cell : paint.dim(cell);
  });
}

async function run(this: BraidContext, flags: { json?: boolean; rev?: string }, path: string) {
  const repository = openRepository(this);
  const local = blameFile(this, repository.root, path, flags.rev);
  const braid = maybeConnect(this, repository);
  const result = braid ? await upgrade(braid, local.blame) : local.blame;
  if (flags.json) { print(this, JSON.stringify(result, null, 2)); return; }
  const logins = await historyLogins(this, repository.root, flags.rev);
  for (const row of blameTable(this, result, local.text, logins)) print(this, row);
}

export const blameCommand = buildCommand({
  func: run,
  parameters: {
    flags: {
      json: { kind: 'boolean', brief: 'Print the FileBlame JSON', optional: true },
      rev: { kind: 'parsed', parse: String, brief: 'Blame the file as of this revision instead of the working tree', placeholder: 'revision', optional: true },
    },
    positional: { kind: 'tuple', parameters: [{ brief: 'The file to blame', parse: String, placeholder: 'path' }] },
  },
  docs: { brief: 'Show which agent, person or bot wrote each line of a file' },
});
