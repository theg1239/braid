import { describe, expect, it } from 'vitest';
import { repositoryUrlError } from '../../shared/repository-url';

describe('repository import URLs', () => {
  it.each([
    'https://github.com/ACM-VIT/examcooker',
    'https://github.com/owner/repository.git/',
    'https://gitlab.com/group/subgroup/project.git',
    'https://codeberg.org/owner/repository',
  ])('accepts a repository root: %s', value => { expect(repositoryUrlError(value)).toBeUndefined(); });
  it.each([
    'https://github.com/orgs/ACM-VIT/repositories', 'https://github.com/orgs/ACM-VIT',
    'https://github.com/ACM-VIT', 'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/blob/main/README.md', 'https://github.com/settings/apps',
    'https://gitlab.com/groups/team/projects', 'https://gitlab.com/team/repo/-/tree/main',
    'https://codeberg.org/explore/repos', 'https://github.com/owner/.git',
    'https://github.com/owner//repo', 'https://github.com/orgs%2facm/repositories',
    'https://github.com:444/owner/repo', 'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#readme', 'https://user:password@github.com/owner/repo',
    'http://github.com/owner/repo', 'https://github.com.evil.example/owner/repo',
    'git@github.com:owner/repo.git', '',
  ])('rejects a non-repository URL: %s', value => { expect(repositoryUrlError(value)).toBeTruthy(); });
});
