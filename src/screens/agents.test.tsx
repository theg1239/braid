import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { agentFixture, missionFixture, textOf } from '../test/fixtures';

const state = vi.hoisted(() => ({ writable: false }));
const mission = missionFixture({ agents: [agentFixture({ id: 'a' }), agentFixture({ id: 'b' })], collisions: [{ id: 'choice', path: 'src/limits.ts', agentIds: ['a', 'b'] }] });
vi.mock('../store/workspace', () => ({
  useSnapshot: () => ({ project: { id: 'relay', name: 'relay', head: 'a' }, missions: [mission], capabilities: { canWrite: state.writable } }),
  canWrite: (snapshot: { capabilities: { canWrite: boolean } }) => snapshot.capabilities.canWrite,
}));
vi.mock('../components/agents/TaskComposer', () => ({ TaskComposer: () => null }));
vi.mock('../components/agents/Fleet', () => ({ Fleet: () => null, useFleet: () => null }));
vi.mock('../components/repo/RepositorySetup', () => ({ NoRepositoryPanel: () => null }));
vi.mock('../components/ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('../lib/router', () => ({ paths: { task: (id: string) => `/tasks/${id}` } }));
import { AgentsScreen } from './AgentsScreen';

describe('Agents page attention labels', () => {
  it('asks the owner in the filter and task row when the viewer cannot write', () => {
    state.writable = false;
    const html = renderToStaticMarkup(<AgentsScreen />);
    expect(textOf(html).match(/Needs the owner/g)).toHaveLength(2);
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('Needs your choice');
  });
  it('keeps the actionable labels for owners and example visitors who can write', () => {
    state.writable = true;
    const html = renderToStaticMarkup(<AgentsScreen />);
    expect(textOf(html)).toContain('Needs you 1');
    expect(textOf(html)).toContain('Needs your choice');
    expect(html).not.toContain('Needs the owner');
  });
});
