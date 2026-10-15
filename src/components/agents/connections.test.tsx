import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, AgentRecord, Mission } from '../../../shared/types';
import { agentKey } from '../../../shared/models';
vi.mock('../../lib/router', () => ({ paths: {} }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({ missions: [] }) }));
vi.mock('../ui/Link', () => ({ RouterLink: () => null }));
vi.mock('../../lib/live', () => ({ useLive: () => null }));
vi.mock('../../account/RepositoryGate', () => ({ useRepository: () => ({ scope: 'repo-1' }) }));
import { runsForAgent } from './AgentRuns';
import { McpHeaders } from './ConnectAgent';

describe('fleet task timings', () => {
  it('does not attribute another owner or tool’s time to an agent with the same model', () => {
    const author = { kind: 'agent' as const, model: 'claude-opus-5-5', tool: 'claude-code/2', owner: { id: 'user:maya', name: 'Maya' } };
    const record = { id: agentKey(author)!, models: [author.model], owner: author.owner } as AgentRecord;
    const mine = { id: 'mine', model: author.model, owner: author.owner, tool: 'claude-code/3' } as Agent;
    const mission = { id: 'task', agents: [mine, { ...mine, id: 'another-owner', owner: { id: 'user:dev', name: 'Dev' } }, { ...mine, id: 'another-tool', tool: 'cursor' }] } as Mission;
    expect(runsForAgent(record, [mission], []).map(run => run.agent.id)).toEqual(['mine']);
  });
  it('recovers an older task’s timing through its actual pull request link', () => {
    const mission = { id: 'task', agents: [{ id: 'old', change: { id: 'ch_1' } }] } as Mission;
    expect(runsForAgent({ id: 'record' } as AgentRecord, [mission], [{ id: 'ch_1' } as never]).map(run => run.agent.id)).toEqual(['old']);
    expect(runsForAgent({ id: 'record' } as AgentRecord, [mission], [])).toEqual([]);
  });
});

describe('MCP connection headers', () => {
  it('names the workspace placeholder in text, not as an escaped entity', () => {
    expect(renderToStaticMarkup(<McpHeaders />)).toContain('<dt>X-Braid-Workspace</dt><dd>&lt;workspace ID&gt;</dd>');
  });
});
