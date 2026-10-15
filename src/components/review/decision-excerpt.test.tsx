import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Agent, Collision, FileChange, Mission } from '../../../shared/types';
import type { MissionFile } from '../../lib/derive';
import type { ChangeResult } from '../../lib/resources';
import { textOf } from '../../test/fixtures';
import { DecisionPanel } from './DecisionPanel';

let results: ChangeResult[] = [];
vi.mock('../../store/workspace', () => ({ useWorkspace: () => ({ snapshot: {}, applyMission: () => {}, refresh: async () => {} }), canWrite: () => true }));
vi.mock('../../lib/resources', () => ({ useFileChanges: () => ({ results }), prefetchPreview: () => {} }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T12:00:00Z') }));
vi.mock('@cloudflare/kumo', async (original) => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));

const agent = (id: string, name: string) => ({ id, name, role: 'Coding agent', color: '', status: 'review', task: '', scope: ['*'], summary: '', rationale: '', checks: [], changes: [] }) as Agent;
const version = (after: string): FileChange => ({ path: 'src/limits.ts', before: '', after, additions: after.split('\n').length, deletions: 0 });
const agents = [agent('atlas', 'Codex'), agent('sable', 'Claude Code')];
const changes = [version('const limit = 4;\nexport const burst = 2;\n'), version('const limit = 8;\n')];
const collision: Collision = { id: 'c', path: 'src/limits.ts', agentIds: ['atlas', 'sable'] };
const mission = { id: 'm', status: 'review', agents, collisions: [collision] } as unknown as Mission;
const file: MissionFile = { path: 'src/limits.ts', versions: agents.map((item, index) => ({ agent: item, change: changes[index] })), disposition: 'unresolved', collision, shipping: null };
const render = () => renderToStaticMarkup(<DecisionPanel mission={mission} file={file} />);
const slots = (html: string) => [(html.match(/class="choice-body__line"/g) ?? []).length, (html.match(/class="choice-body__more"/g) ?? []).length];

it('keeps three line slots and a count for each version while the versions load, when they arrive, and when they fail', () => {
  results = changes.map(() => ({ status: 'loading' }));
  const pending = render();
  expect(slots(pending)).toEqual([6, 2]);
  expect(pending.match(/skeleton-line/g)).toHaveLength(6);

  results = changes.map((change) => ({ status: 'ready', change }));
  const ready = render();
  expect(slots(ready)).toEqual([6, 2]);
  expect(ready).not.toContain('skeleton-line');
  expect(textOf(ready)).toContain('const limit = 8;');
  expect(textOf(ready)).toContain('export const burst = 2;');

  results = [{ status: 'ready', change: changes[0] }, { status: 'error', message: 'HTTP 503', changed: false }];
  const failed = render();
  expect(slots(failed)).toEqual([6, 2]);
  expect(textOf(failed)).toContain('Couldn’t load this version');
});
