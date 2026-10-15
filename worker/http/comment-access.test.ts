import { describe, expect, it } from 'vitest';
import { agentPathAllowed, publicPathAllowed } from './agent-auth';

describe('review comment access', () => {
  it('lets anyone read a public pull request\'s comments, and no one write them anonymously', () => {
    expect(publicPathAllowed('/api/changes/23/comments', 'GET')).toBe(true);
    expect(publicPathAllowed('/api/changes/ch_0123456789abc/comments', 'HEAD')).toBe(true);
    expect(publicPathAllowed('/api/changes/23/comments', 'POST')).toBe(false);
    expect(publicPathAllowed('/api/changes/23/comments/c1/resolve', 'POST')).toBe(false);
  });

  it('lets agents read comments, and only work connections reply; resolving stays with people', () => {
    for (const scope of ['read', 'work', 'setup'] as const) expect(agentPathAllowed('/api/changes/23/comments', 'GET', scope), scope).toBe(true);
    expect(agentPathAllowed('/api/changes/23/comments', 'POST', 'work')).toBe(true);
    for (const scope of ['read', 'setup', 'fleet'] as const) expect(agentPathAllowed('/api/changes/23/comments', 'POST', scope), scope).toBe(false);
    for (const scope of ['read', 'work', 'setup', 'fleet'] as const) expect(agentPathAllowed('/api/changes/23/comments/c1/resolve', 'POST', scope), scope).toBe(false);
  });
});
