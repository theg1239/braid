import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AgentCheck, FileChange } from '../../../shared/types';
import type { MissionFile } from '../../lib/derive';
import { agentFixture, missionFixture, textOf } from '../../test/fixtures';

vi.mock('../../lib/hooks', () => ({ useNow: () => Date.parse('2026-10-14T12:00:00Z'), useIdempotencyKey: () => () => 'key' }));
vi.mock('../../lib/resources', () => ({ useTaskChange: () => null, useIntegrationPreview: () => ({ preview: null, error: null, reload: async () => {} }) }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => ({ project: { branch: 'main' }, capabilities: {} }), useWorkspace: () => ({ refresh: async () => {} }), canWrite: () => false, readOnlyReason: () => '' }));
vi.mock('../../lib/router', () => ({ paths: new Proxy({}, { get: (_, name) => (id = '') => `/${String(name)}/${id}` }) }));
vi.mock('../ui/Link', () => ({ RouterLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@cloudflare/kumo', async (original) => ({ ...await original<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: vi.fn() }) }));

import { TaskNext } from './TaskNext';

const head = 'a'.repeat(40);
const change: FileChange = { path: 'README.md', before: '', after: '# Relay\n', additions: 1, deletions: 0 };
function ready(checks: AgentCheck[]) {
  const agent = agentFixture({ checks, changes: [change] });
  const mission = missionFixture({ source: 'live', execution: 'local', baseCommit: head, agents: [agent] });
  const files: MissionFile[] = [{ path: change.path, versions: [{ agent, change }], disposition: 'independent', collision: null, shipping: { agent, change } }];
  return textOf(renderToStaticMarkup(<TaskNext mission={mission} files={files} head={head} onRestart={() => {}} />));
}

it("counts a local task's test results by their kind, not by how they are labelled", () => {
  expect(ready([{ kind: 'report', label: 'Local report: npm test', status: 'warning', detail: 'Agent-reported passed.' }])).toContain('Test results are agent-reported.');
  expect(ready([{ label: 'Local report: npm test', status: 'warning', detail: 'An agent check named like a report.' }])).toContain('No test results were submitted.');
});
