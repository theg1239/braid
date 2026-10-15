import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../shared/types';
import { agentFixture, missionFixture } from '../../test/fixtures';
import { missionFiles } from '../../lib/derive';

vi.mock('@cloudflare/kumo', async (original) => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));
vi.mock('../../lib/router', () => ({ paths: { review: (id: string) => `/review/${id}` } }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({}), useWorkspace: () => ({ applyMission: vi.fn(), refresh: vi.fn() }), readOnlyReason: () => 'Sign in to choose a version.' }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { CheckList } from './AgentCards';
import { FileChoice } from './FileChoice';

const agent = (id: string, name: string) => agentFixture({ id, name, role: 'Reliability', color: '#888', task: 'Limit deliveries', summary: `Proposal from ${name}`, rationale: 'Keep each endpoint independent.', checks: [{ label: 'Runtime tests', status: 'warning', detail: 'Not run.' }], changes: [{ path: 'src/limits.ts', before: '', after: id, afterHash: id, additions: 1, deletions: 0 }] });
const mission = missionFixture({ id: 'choice', title: 'Limit deliveries', baseCommit: 'main', agents: [agent('a', 'Claude Opus 5.5'), agent('b', 'GPT-6.1 Sol')], collisions: [{ id: 'collision', path: 'src/limits.ts', agentIds: ['a', 'b'] }] });
const file = missionFiles(mission)[0];

describe('Task version choices', () => {
  it('keeps comparison separate from explicit version selection', () => {
    const html = renderToStaticMarkup(<FileChoice mission={mission} file={file} writable />);
    expect(html.match(/<article /g)).toHaveLength(2);
    expect(html).toContain('Compare versions');
    // The accessible name starts with the visible label, so "click Use this version" works for speech input.
    expect(html).toContain('aria-label="Use this version: Claude Opus 5.5&#x27;s src/limits.ts"');
    expect(html).toContain('aria-label="Use this version: GPT-6.1 Sol&#x27;s src/limits.ts"');
    // The question can take focus when the previous choice settles.
    expect(html).toMatch(/<section tabindex="-1"[^>]*aria-label="Choose a version of src\/limits\.ts"/);
    expect(html.match(/Reasoning and checks/g)).toHaveLength(2);
    expect(html).not.toContain('Loading comparison');
  });

  it('gives read-only users a reason on both disabled choice controls', () => {
    const html = renderToStaticMarkup(<FileChoice mission={mission} file={file} writable={false} />);
    expect(html.match(/title="Sign in to choose a version\."/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Compare versions');
  });

  it('never calls sample checks or agent-reported checks verified passes', () => {
    const checks: Agent['checks'] = [{ label: 'Sample patch', status: 'passed', detail: 'Recorded output' }, { kind: 'runtime', label: 'Runtime tests', status: 'warning', detail: 'Not executed' }];
    const demo = renderToStaticMarkup(<CheckList checks={checks} mission={{ source: 'demo', execution: 'cloud' }} />);
    expect(demo).toContain('Sample');
    expect(demo).toContain('Not run');
    expect(demo).not.toContain('Passed');
    // A check is "not run" by its kind; a label that merely says so is an agent's own check.
    const named = renderToStaticMarkup(<CheckList checks={[{ label: 'Runtime tests', status: 'warning', detail: 'Ran in CI' }]} mission={{ source: 'live', execution: 'cloud' }} />);
    expect(named).not.toContain('Not run');
    const local = renderToStaticMarkup(<CheckList checks={[{ label: 'Local report: npm test', status: 'warning', detail: 'Passed locally' }]} mission={{ source: 'live', execution: 'local' }} />);
    expect(local).toContain('Agent-reported');
    expect(local).not.toContain('data-state="pass"');
  });
});
