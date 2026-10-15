import { vi } from 'vitest';
import * as github from '../github/routes';

/** Existing native-account fixtures use names that GitHub does not own; all other network traffic stays real. */
export function unoccupiedGitHubNames() {
  const original = github.userApi;
  return vi.spyOn(github, 'userApi').mockImplementation((env, userId, path, options) => {
    return path.startsWith('/users/') && options?.allowNotFound
      ? Promise.resolve(null) : original(env, userId, path, options);
  });
}
