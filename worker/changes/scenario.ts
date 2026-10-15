/**
 * Synthetic agent work for the swarm simulator. Each agent's intent is fixed by
 * its index and the run seed; applying it to whatever trunk currently contains
 * is how a simulated agent "rebases" after a conflict. Edits are deliberately
 * shaped like real agent work: new files, shared registries, changelogs and
 * occasional edits to the same lines.
 */
import type { SwarmScenario } from '../../shared/types';
const SWARM_ROOT = 'swarm';
export const SCAFFOLD: Record<string, string> = {
  [`${SWARM_ROOT}/README.md`]: '# Swarm\n\nFiles in this directory are written by simulated Braid agents to exercise concurrent landing.\n',
  [`${SWARM_ROOT}/CHANGELOG.md`]: '# Swarm changelog\n',
  [`${SWARM_ROOT}/registry.json`]: JSON.stringify({ handlers: {} }, null, 2) + '\n',
  [`${SWARM_ROOT}/routes.ts`]: ['// Routes registered by simulated agents. Each agent inserts one line.', 'export const routes: Record<string, string> = {', "  '/': 'index',", '};', ''].join('\n'),
  [`${SWARM_ROOT}/hot.ts`]: ['// Every hotspot agent rewrites the same line, so most of them must rebase.', 'export const LIMIT = 0;', ''].join('\n'),
};
export const SCENARIO_PATHS = Object.keys(SCAFFOLD);

function random(seed: number) {
  return () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
}
const name = (index: number) => `h${String(index).padStart(4, '0')}`;

interface SwarmEdit { title: string; summary: string; files: { path: string; content: string | null }[] }

/** The agent's edit applied to the current trunk contents of the scenario files. */
export function swarmEdit(scenario: SwarmScenario, index: number, seed: number, attempt: number, files: Record<string, string | null>): SwarmEdit {
  const rand = random(seed * 7919 + index * 104_729 + 1);
  const handler = name(index);
  // A few agents make a mistake on their first attempt; the reviewer sends them back.
  const defect = attempt === 0 && rand() < 0.03;
  const edits: SwarmEdit['files'] = [];
  const read = (path: string) => files[path] ?? SCAFFOLD[path];
  const own = `${SWARM_ROOT}/handlers/${handler}.ts`;
  edits.push({ path: own, content: `export function ${handler}(input: string) {\n  return \`${handler}:\${input}\`;${defect ? ' // BRAID-SIMULATED-DEFECT' : ''}\n}\n` });
  if (scenario === 'disjoint') return { title: `Add handler ${handler}`, summary: `Adds ${own}.`, files: edits };
  if (scenario === 'hotspot') {
    edits.push({ path: `${SWARM_ROOT}/hot.ts`, content: read(`${SWARM_ROOT}/hot.ts`).replace(/export const LIMIT = \d+;/, `export const LIMIT = ${index + 1};`) });
    return { title: `Raise the limit for ${handler}`, summary: `Sets LIMIT to ${index + 1} in swarm/hot.ts.`, files: edits };
  }
  const registry = JSON.parse(read(`${SWARM_ROOT}/registry.json`)) as { handlers: Record<string, string> };
  registry.handlers[handler] = `./handlers/${handler}`;
  edits.push({ path: `${SWARM_ROOT}/registry.json`, content: JSON.stringify(registry, null, 2) + '\n' });
  const routes = read(`${SWARM_ROOT}/routes.ts`).split('\n');
  const first = routes.findIndex(line => line.startsWith('export const routes')) + 1, last = routes.lastIndexOf('};');
  const at = first + Math.floor(rand() * (last - first + 1));
  routes.splice(at, 0, `  '/${handler}': '${handler}',`);
  edits.push({ path: `${SWARM_ROOT}/routes.ts`, content: routes.join('\n') });
  edits.push({ path: `${SWARM_ROOT}/CHANGELOG.md`, content: `${read(`${SWARM_ROOT}/CHANGELOG.md`)}- Added ${handler}\n` });
  return { title: `Add handler ${handler}`, summary: `Registers ${handler} in the registry, route table and changelog.`, files: edits };
}
