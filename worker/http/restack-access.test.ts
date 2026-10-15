import { describe, expect, it } from 'vitest';
import { agentPathAllowed, publicPathAllowed } from './agent-auth';

describe('restack access', () => {
  it('lets work agents, including those a fleet mints, restack; the fleet connection, read and setup grants and visitors cannot', () => {
    expect(agentPathAllowed('/api/changes/12/restack', 'POST', 'work')).toBe(true);
    for (const scope of ['read', 'setup', 'fleet'] as const) expect(agentPathAllowed('/api/changes/12/restack', 'POST', scope), scope).toBe(false);
    expect(agentPathAllowed('/api/changes/12/restack', 'GET', 'work')).toBe(false);
    expect(publicPathAllowed('/api/changes/12/restack', 'POST')).toBe(false);
  });
});
