import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Agent, Collision, FileChange, Mission } from '../../../shared/types';
import type { MissionFile } from '../../lib/derive';
import { textOf } from '../../test/fixtures';
import { DecisionPanel } from './DecisionPanel';

vi.mock('../../store/workspace', () => ({ useWorkspace: () => ({ snapshot: {}, applyMission: () => {}, refresh: async () => {} }), canWrite: () => false }));
vi.mock('../../lib/resources', () => ({ useFileChanges: (_mission: string, versions: unknown[]) => ({ results: versions.map(() => ({ status: 'loading' })) }), prefetchPreview: () => {} }));
vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T12:00:00Z') }));
vi.mock('@cloudflare/kumo', async (original) => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));

const agent = (id: string, name: string) => ({ id, name, role: 'Coding agent', color: '', status: 'review', task: '', scope: ['*'], summary: '', rationale: '', checks: [], changes: [] }) as Agent;
const change: FileChange = { path: 'docs/local.md', before: '', after: '# Notes\n', additions: 1, deletions: 0 };
function decision(resolution: NonNullable<Collision['resolution']>) {
  const agents = [agent('atlas', 'Codex'), agent('sable', 'Claude Code')];
  const collision: Collision = { id: 'c', path: change.path, agentIds: ['atlas', 'sable'], resolution };
  const mission = { id: 'm', status: 'review', agents, collisions: [collision] } as unknown as Mission;
  const file: MissionFile = { path: change.path, versions: agents.map(item => ({ agent: item, change })), disposition: 'selected', collision, shipping: { agent: agents[1], change } };
  return textOf(renderToStaticMarkup(<DecisionPanel mission={mission} file={file} />)).replaceAll('&#x27;', "'");
}

it("quotes the person's reason whatever it says, and nothing when they gave none", () => {
  expect(decision({ agentId: 'sable', resolvedAt: '2026-10-14T11:00:00Z' })).not.toContain('“');
  expect(decision({ agentId: 'sable', reason: "Chose Claude Code's version.", resolvedAt: '2026-10-14T11:00:00Z' })).toContain("“Chose Claude Code's version.”");
});
