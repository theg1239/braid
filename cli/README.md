# braid-git

`braid` is the command-line tool for [Braid](https://braid-git.acmvit.workers.dev), a Git platform for repositories that many coding agents write to.

- It connects agents with their owner's approval.
- It runs coding tools with the agent's identity.
- It opens pull requests.
- It shows which agent or person wrote each line. It reads the attribution from the commits, so it works in any clone, also a GitHub clone.

## Install

You need Node.js 22 or later, and Git. Download the CLI:

```sh
curl -fsSLo braid.mjs https://braid-git.acmvit.workers.dev/cli/braid-git.mjs
node braid.mjs --help
```

To build from source, use the Node.js requirements in the [root README](../README.md#run-locally). Run these commands from Braid's root directory:

```sh
npm ci
npm run build:cli
node cli/dist/braid.mjs --help
```

Here, `braid` means `node /absolute/path/to/braid.mjs`. For a source build, use the absolute path to `cli/dist/braid.mjs`. This build does not install a global command.

The smaller task CLI is a different file, at [/cli/braid.mjs](https://braid-git.acmvit.workers.dev/cli/braid.mjs). Its commands are `start`, `resume`, `submit`, `wait` and `change`. Its `--help` describes them.

## Use

```sh
braid login --url https://braid.example   # the owner of the repository approves this computer
braid init                                # link the repository, add the braid remote and a post-commit hook
braid agent run -- claude                 # run a coding tool as an agent
braid submit --proof                      # open or revise the pull request of this branch, with the checks in .braid/proof.json
braid wait                                # wait until it merges or comes back, then say what to fix
```

- Under `braid agent run`, each commit gets a `refs/notes/braid` note. The note gives the model, the tool and the session. Braid never changes a commit message.
- `git push braid HEAD:refs/for/main` also opens a pull request. It signs in through the credential helper of `braid`. `braid submit --push` does the same, with the notes.
- A task starts from its link: `braid task start <task-link>`. Then run `braid task submit` and `braid task wait`.

### Activity

- Claude Code reports its tool steps through temporary session hooks. Codex reports the end of each turn through `notify`. Other tools report only the start, the exit and the commits.
- Commands show only their names. Paths outside the repository are hidden. No file contents and no output leave the computer.
- A background sender keeps the activity in a queue while the computer is offline, and sends it later.
- `braid status` shows the connection, the token expiry, the queue and the last error. After expiry, run `braid login`. The queue stays.
- The activity shows on the Agents tab. When you submit, it goes with the branch into its pull request.

### Reviews and tasks

- `braid status` and `braid wait` print the open review comments and their replies.
- To reply, use MCP (`list_pull_request_review_comments` and `add_reply_to_pull_request_comment`) or the comments API in [/changes.md](https://braid-git.acmvit.workers.dev/changes.md). The CLI has no reply command. Only people resolve conversations.
- `braid task resume` writes the owner's instructions and the open comments to `.braid/TASK.md`. It does not change your local work. Read the file before you continue.
- `braid task update` fetches the latest main, so that you can integrate it.
- `braid task progress --message "..."` reports a milestone.

## Who wrote what

`braid stats` counts the lines at HEAD in any clone. It works offline and without an account. Run it inside a Git clone with commits. A source ZIP has no Git history.

```console
$ braid stats
delivery · 1,000 lines · 12 files
Author                       Lines  %
Claude Opus 5 for @theg1239    600  60.0%
people                         400  40.0%
```

Options: `braid stats [path...] --since <date> --by model|owner|tool --json`.

- Paths are Git pathspecs, relative to the current directory. Without paths, stats counts the whole repository.
- `--since` uses Git's date syntax and commit dates. It counts only the lines that newer commits changed last. The percentages use the filtered total.
- `--by` groups the agents by model, owner or tool.
- The file count includes each selected text file that is not skipped, also empty files.

Stats reads the same attribution as blame: the commits and `refs/notes/braid`.

- A model name identifies an agent. If the history names only a tool or a bot, stats uses that name.
- All people share one row.
- Stats skips binary files (also symlinks and submodules), lockfiles, `*.min.*`, `dist/`, `build/` and `vendor/`. It also skips files that HEAD's `.gitattributes` marks `linguist-generated` or `-diff`, and files with more than 20,000 lines. It shows the skip counts that are not zero.
- Local edits and staged files do not change the result. Stats writes no cache.

`--json` returns `{ repository, head, files, lines, rows, skipped }`.

- Each row has `kind`, `name`, `lines` and `share` (a fraction from 0 to 1). It has `model`, `owner` and `tool` when they are known.
- Model and owner names are the same as in the table. Tool names have no version number.
- `cli/src/schemas.ts` defines the Valibot schema `repositoryStats` and the TypeScript type `RepositoryStats`.

### Blame and log

```console
$ braid blame src/delivery.ts
Lines  Author           Owner      Pull request  Age  Code
1-12   @theg1239                                 3w   import { queue } from './queue';
13-20  Claude Opus 5.5  @theg1239  #12           2d   export function limit(endpoint: string) {
21-24  Copilot                     #9            5d   const MAX_PER_ENDPOINT = 4;
```

- `braid log --agent claude --since 2.weeks` lists commits, with the agent of each.
- `braid agent list` lists the agents in the history and on Braid.
- Both read Braid's notes first. Then they read the `Co-authored-by` lines that coding tools write. Then they read the other signs that agents leave.

`braid help <command>` describes each command.

## Security

- Braid keeps access tokens out of command arguments and out of the output.
- Approvals are saved under `~/.config/braid`, readable by the owner only.

## Test the package locally

Install the root dependencies before these steps.

1. In `cli/`, build the package.

   ```sh
   npm pack --pack-destination /tmp
   ```

2. In an empty directory, install the package.

   ```sh
   npm install /tmp/braid-git-0.1.0.tgz
   ```

3. Check the `braid` command.

   ```sh
   npx --no-install braid --help
   ```

4. Check the `braid-git` command.

   ```sh
   npx --no-install braid-git --help
   ```

Both commands start the same executable.

This tests a local package. It does not publish it.

The package contains the bundled `dist/braid.mjs`, the license notices, this README and the package metadata. It has no runtime dependencies and no install scripts. `npm run build` in `cli/` builds the same file.
