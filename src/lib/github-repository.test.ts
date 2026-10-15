import { describe, expect, it } from 'vitest';
import { githubRepository } from './github-repository';
import { parsePath } from './address';

describe('Opening a GitHub repository', () => {
  it.each(['openai/codex', 'https://github.com/openai/codex', 'github.com/openai/codex.git', 'https://github.com/openai/codex/tree/main?tab=readme#readme', '  openai/codex/  '])('opens %s at the same repository address', input => {
    expect(githubRepository(input)).toEqual({ owner: 'openai', repo: 'codex' });
  });
  it.each(['https://github.com/Octocat/Hello-World', 'octocat/a_repo.js', `octocat/${'a'.repeat(100)}`])('preserves GitHub repository names in %s', input => {
    const address = githubRepository(input)!;
    expect(address).not.toBeNull();
    expect(parsePath(`/${address.owner}/${address.repo}`)).toMatchObject({ screen: 'code', repo: address });
  });
  it.each(['', 'openai', 'owner/repo/file', 'https://evil.test/openai/codex', 'https://github.com.evil.test/openai/codex', 'https://user:secret@github.com/openai/codex', 'https://github.com:444/openai/codex', 'javascript:alert(1)', 'owner/..', 'api/repo', 'owner/repo name', 'https://github.com/owner/a%2Fb'])('rejects %s', input => {
    expect(githubRepository(input)).toBeNull();
  });
});
