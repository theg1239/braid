import { buildCommand } from '@stricli/core';
import { relative } from 'node:path';
import { fail, print, type BraidContext } from '../context';
import { ID, normalizeOrigin, resolveOrigin, savedCredentials, writeLink } from '../config';
import { git, gitTry } from '../git';
import { installHooks } from '../hooks';
import { braidRemote, currentRemote, openRepository } from '../repository';
import { shellCommand } from '../terminal';

function linkRemote(context: BraidContext, root: string, url: string) {
  const current = currentRemote(context, root);
  if (current === undefined) git(context, ['remote', 'add', 'braid', url], { cwd: root });
  else if (current !== url) git(context, ['remote', 'set-url', 'braid', url], { cwd: root });
  const key = `credential.${url}`;
  // An empty helper first clears any other, such as a keychain, so the agent token is never stored anywhere else.
  gitTry(context, ['config', '--local', '--unset-all', `${key}.helper`], { cwd: root });
  git(context, ['config', '--local', '--add', `${key}.helper`, ''], { cwd: root });
  git(context, ['config', '--local', '--add', `${key}.helper`, `!${shellCommand([...context.self, 'git-credential'])}`], { cwd: root });
  git(context, ['config', '--local', `${key}.useHttpPath`, 'true'], { cwd: root });
}

async function init(this: BraidContext, flags: { url?: string; workspace?: string }) {
  const repository = openRepository(this);
  const origin = resolveOrigin(this, repository.link, flags.url);
  const signedIn = [...new Set(savedCredentials(this.env, origin).filter(saved => Date.parse(saved.expiresAt ?? '') > this.now()).map(saved => saved.workspaceId))];
  const workspaceId = flags.workspace ?? this.env.BRAID_WORKSPACE_ID ?? repository.link?.workspaceId ?? (signedIn.length === 1 ? signedIn[0]
    : fail(signedIn.length ? `Several repositories are signed in at ${origin}; choose one with --workspace.` : `Run braid login --url ${origin} first, or name the repository with --workspace.`));
  if (!ID.test(workspaceId)) fail(`${workspaceId} is not a Braid repository id.`);
  const path = writeLink(repository.root, { url: origin, workspaceId });
  linkRemote(this, repository.root, braidRemote(origin, workspaceId));
  const hooks = installHooks(this, repository.root), folder = relative(repository.root, hooks.folder) || hooks.folder;
  print(this, `Linked to ${origin}, repository ${workspaceId}, in ${relative(this.cwd, path) || path}.`);
  print(this, `Added the braid remote, signed in through braid: git push braid HEAD:refs/for/main opens a change.`);
  print(this, `Installed the post-commit hook in ${folder}${hooks.chained ? '; the post-commit hook already there runs first' : ''}.`);
  if (hooks.earlier === 'restored') print(this, `Removed Braid's earlier prepare-commit-msg hook and put back the one it had set aside.`);
  if (hooks.earlier === 'removed') print(this, `Removed Braid's earlier prepare-commit-msg hook.`);
  if (hooks.earlier === 'set aside') print(this, `${folder}/prepare-commit-msg.pre-braid is a hook Braid once set aside, and it no longer runs. Merge it into prepare-commit-msg or delete it.`);
}

export const initCommand = buildCommand({
  func: init,
  parameters: {
    flags: {
      url: { kind: 'parsed', parse: normalizeOrigin, brief: 'Braid address, such as https://braid.example', placeholder: 'url', optional: true },
      workspace: { kind: 'parsed', parse: String, brief: 'Repository id at that Braid', placeholder: 'id', optional: true },
    },
  },
  docs: {
    brief: 'Link this repository to Braid, add the braid remote and install the post-commit hook',
    fullDescription: 'Writes .braid/config.json with the Braid address and repository id, adds a braid Git remote that signs in through braid\'s own credential helper, so git push braid HEAD:refs/for/main opens a change, and installs a post-commit hook that records each commit made under braid agent run (model, tool and session) in a refs/notes/braid note. Braid never changes commit messages. A post-commit hook already there keeps running first, and the prepare-commit-msg hook of earlier versions is removed, with the hook it had set aside put back.',
  },
});
