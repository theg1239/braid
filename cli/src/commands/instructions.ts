import { buildCommand, buildRouteMap } from '@stricli/core';
import * as v from 'valibot';
import { blockedStrings, instructionPaths, instructionText } from '../../../shared/instructions-file';
import { ApiError } from '../api';
import { fail, note, print, type BraidContext } from '../context';
import { connect, openRepository } from '../repository';
import { change, instructions } from '../schemas';
import { redact } from '../secrets';
import { colours, plain } from '../terminal';

async function list(this: BraidContext, flags: { json?: boolean }) {
  const braid = connect(this, openRepository(this));
  const found = await braid.get('/api/instructions', instructions);
  if (flags.json) { print(this, JSON.stringify(found.instructions, null, 2)); return; }
  const paint = colours(this), clean = (text: string) => redact(plain(text), braid.secrets);
  if (!found.instructions.length) print(this, 'No instructions yet.');
  for (const instruction of found.instructions) {
    print(this, `${paint.dim(instruction.id)}  ${clean(instruction.text)}`);
    const scope = [instruction.block?.length ? `blocks ${instruction.block.map(item => JSON.stringify(item)).join(', ')}` : '', instruction.paths?.length ? `in ${instruction.paths.join(', ')}` : ''].filter(Boolean).join(' ');
    if (scope) print(this, `  ${paint.dim(clean(scope))}`);
  }
  for (const problem of found.errors) note(this, `${paint.yellow('Warning:')} ${clean(problem)}`);
}

async function add(this: BraidContext, flags: { block?: readonly string[]; path?: readonly string[] }, text: string) {
  const input = v.safeParse(v.object({ text: instructionText, block: v.optional(blockedStrings), paths: v.optional(instructionPaths) }), { text, block: flags.block?.length ? [...flags.block] : undefined, paths: flags.path?.length ? [...flags.path] : undefined });
  if (!input.success) fail(input.issues[0].message);
  const braid = connect(this, openRepository(this));
  try {
    const opened = await braid.post('/api/instructions', input.output, change);
    print(this, `Opened pull request #${opened.number} to add the instruction; it lands under the repository's rules.${opened.html_url ? `\n${opened.html_url}` : ''}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) fail(`Only a person can add instructions, and braid signs in as an agent. Add it in Braid at ${braid.origin}/settings/agents.`);
    throw error;
  }
}

const listCommand = buildCommand({ func: list, parameters: { flags: { json: { kind: 'boolean', brief: 'Print JSON', optional: true } } }, docs: { brief: 'List the instructions every agent follows here' } });
const addCommand = buildCommand({
  func: add,
  parameters: {
    flags: {
      block: { kind: 'parsed', parse: String, variadic: true, optional: true, brief: 'A string changes may not add; repeat for up to 8', placeholder: 'text' },
      path: { kind: 'parsed', parse: String, variadic: true, optional: true, brief: 'Limit it to files matching this pattern, such as src/**; repeat for up to 10', placeholder: 'pattern' },
    },
    positional: { kind: 'tuple', parameters: [{ brief: 'What every agent should do, in one line', parse: String, placeholder: 'text' }] },
  },
  docs: { brief: 'Propose an instruction for every agent' },
});

export const instructionRoutes = buildRouteMap({
  routes: { list: listCommand, add: addCommand },
  defaultCommand: 'list',
  docs: { brief: 'List and add the instructions every agent follows' },
});
