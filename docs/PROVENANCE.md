# Agent provenance

Braid records the agent, owner, model, tool, and run for commits merged through its queue. The commit names the owner. Braid's stored records and `refs/notes/braid` hold the other attribution.

For imported history, Braid reads attribution from Git notes and commit metadata. These claims have lower confidence than merges Braid records itself.

## Identity

An agent is a model run by an owner. Sessions distinguish runs of the same model. Braid does not invent agent names.

| Level | Example | Source |
| --- | --- | --- |
| Owner | Ishaan, `theg1239` on GitHub | The person who approves the connection. Fleet agents share that approver. A person's own pull request names that person. |
| Agent | Claude Opus 5.5, `agent:…` | The submitting connection or fleet identity from `POST /api/agent/session`. |
| Model and tool | `claude-opus-5-5`, `claude-code/2.4.1` | Submitted metadata. A fleet token can also name the model. `modelName()` supplies its display name. |
| Session | `s_…`, parent `s_…` | One tool run. A subagent names its coordinator's session. |
| Pull request and task | `#12`, `mission-…` | The pull request and its source task. |

Braid uses `${id}+${login}@users.noreply.github.com` only after reading the GitHub ID and login together. GitHub sign-in or a repository connection supplies that identity. Disconnecting the repository connection removes the identity it supplies.

Without verified GitHub identity, the commit uses `<random Directory public id>@people.braid.local`. An email address never becomes a display name. Public metadata resolves Braid author and owner IDs. Reads do not create identities. Trailer links accept only pull request and task IDs.

## Commit message

Each queued pull request produces one commit. Its message contains the pull request title and summary. Braid adds only the submitted `Co-authored-by` lines, kept verbatim and deduplicated. The `coAuthors` field accepts at most 5 entries. Braid adds no attribution footer of its own.

The agent's owner authors the commit. Git content remains unchanged by attribution display rules.

## Git note

A note is a JSON object under `refs/notes/braid`. Ordinary Git log output and GitHub's commit view do not show this custom note.

```json
{"v":1,"agent":{"id":"agent:…","name":"Claude Opus 5.5","model":"claude-opus-5-5","tool":"claude-code/2.4.1","session":"s_42","parentSession":"s_1","fleet":"nightly"},
 "owner":{"name":"Ishaan","github":"theg1239"},"change":{"id":"ch_…","number":12,"revision":2},"task":{"id":"mission-…","title":"Limit deliveries per endpoint"},"approvedBy":"Maya"}
```

`approvedBy` names the owner who approves the revision. Otherwise, it names approving reviewers or `policy (auto)`.

Notes use a 2-character directory prefix, such as `ab/cdef…`. The queue rewrites only affected subtrees. It commits notes to Artifacts after merging, with compare-and-swap. It forwards the note ref to linked GitHub repositories with an expected prior head.

Failed note writes remain pending for retry. They do not block merges. Server reads use the `Trunk` object's `notesHead` because Artifacts does not resolve full note refs. `shared/provenance.ts` defines `NOTES_REF`, `noteSchema`, `parseNote`, and `provenanceOf`.

To read notes in a clone:

1. Fetch the note ref.

   ```sh
   git fetch origin refs/notes/braid:refs/notes/braid
   ```

2. Show the notes.

   ```sh
   git log --notes=braid
   ```

### Combined tasks

A combined task keeps its participating models in the commit attribution. Its version-1 note can include a `files` object keyed by repository path. Each entry contains the supplying `agent` and `owner`.

Blame uses the file entry. The commit row keeps the combined label.

| File | Attribution |
| --- | --- |
| Conflicting file | The selected agent. |
| Independent file | Its sole proposer. |
| Identical proposals | The selected matching proposer, or the first proposer. |
| Agent context file | Its agent. |
| Decision and handoff files | `kind: "bot"`, with `agent: {"name":"Braid","tool":"braid"}`. |

Each entry retains its recorded model, tool, and session. Missing metadata stays absent. Notes without `files` apply to the whole commit. Imported notes, including file entries, retain `trailers` confidence.

## Confidence

| Value | Meaning |
| --- | --- |
| `braid` | Braid records an authenticated submission and its merge. Its own record overrides commit claims. |
| `trailers` | Imported Braid notes or co-authors at `@agents.braid.local`. Braid does not witness these merges. |
| `inferred` | Attribution from recognized tool signatures in Git history. |

Inference recognizes these signals:

- Anthropic model co-authors, such as `Claude Opus 4.7 <noreply@anthropic.com>`.
- Generic Claude credits that identify the tool without a model.
- Explicit identities for Copilot, Codex and its connector, Cursor and Bugbot, Devin, Jules, Gemini CLI, Code Assist, OpenHands, Sweep, and Amazon Q.
- Aider's `Name (aider)` suffix or `aider (<model>)` co-author credit at its attribution addresses.
- GitHub App logins ending in `[bot]` and explicit automation addresses.
- Terminal co-author blocks, including blocks directly after the subject.
- Standalone “Generated with” footers.
- Agent source branches in GitHub's `Merge pull request #… from owner/codex/…` subjects.
- The legacy `Braid-Author` trailer.

A display name alone does not identify an agent. Quoted examples, fenced code, and prose mentions do not count. A merge destination such as `Merge branch 'main' into codex/…` does not identify the incoming code's author.

Known coding apps include PostHog AI, Sentry Seer, CodeRabbit, and Greptile. They use `kind: "agent"`. Dependabot, Renovate, GitHub Actions, release bots, and unknown apps use `kind: "bot"`. Gemini CLI's release robot is also a bot.

An agent co-author makes a human commit author its owner. A bot-authored commit names an owner only when exactly 1 distinct human co-author exists. Explicit coding credits take precedence over transport bots. Conflicting tool or model credits leave the specific agent unknown.

Tool credits do not prove an unstated model. External pull request metadata alone does not replace an unrecognized commit's Git author. Commit claims are not authenticated proof.

### Owner matching and bots

Server reads match inferred owners to Braid accounts by commit email or login, including GitHub no-reply logins. A unique match displays the Braid `@username`. Unmatched owners retain Git attribution without private addresses. Responses omit matching email addresses.

Cached line history uses the same matching rules without increasing confidence. `Provenance.kind` accepts `agent | human | bot`. Bots retain their name and tool in `agent` metadata. Bot rows have no owner byline or fleet record. Stats count bots separately in every grouping.

Stored agent rows remain readable. Reading Git facts can refresh inferred attribution. Braid records and imported note claims remain intact.

## Capture

| Input | Behavior |
| --- | --- |
| API | Pull requests, revisions, and local task results accept `model`, `agent: {tool, session, parentSession}`, and `coAuthors`. A revision without run metadata retains the prior run and owner. |
| MCP | `create_pull_request` and `update_pull_request` accept `model`, `tool`, `session`, `parent_session`, and `co_authors`. |
| Token | The gateway derives the owner from the approving grant. Fleet access tokens carry owner, fleet name, and model. Every request still checks membership and revocation. |
| CLI | `braid submit` sends the same metadata. Parent processes identify Claude, Codex, Cursor Agent, or Gemini. Flags and tool environment supply model and session. |
| Git hook | `braid init` installs a credential helper and a `post-commit` hook. Under `braid agent run`, the hook writes notes without changing messages. |
| Hosted task | The task records the selected model and initiating owner for each agent. |
| Imported history | Braid infers attribution from Git metadata. |

Tool strings allow at most 80 characters from `A–Z a–z 0–9 . _ / @ + -`. Session IDs allow at most 80 characters from `A–Z a–z 0–9 _ -`.

## Blame

`GET /api/blame?path=&ref=` returns `FileBlame` for the default branch's head. The recorded example also supports its recorded branch.

The queue stores line ranges as `[start, count, commitRow, origin?]`. Unchanged lines retain their commit. Added or changed lines take the merged commit. Deletion removes a file's map. A renamed file starts a new map.

For missing maps or external edits, Braid seeds attribution from:

- GitHub GraphQL blame, when a linked repository has the commit.
- First-parent Git history in Artifacts, otherwise.

GitHub blame belongs to the commit:

```graphql
object(oid:) {
  ... on Commit {
    blame(path:) {
      ranges {
        startingLine
        endingLine
        commit { oid message committedDate author { name email } }
      }
    }
  }
}
```

The Git walk follows whole-file renames. Each commit uses its own notes, co-authors, and author. Versioned seeds replace coarse maps while preserving Braid's recorded merges. Unresolved lines retain a boundary note.

Member requests allow 1 s for seeding before returning a temporary answer. Work continues in the background. Visitors receive stored results immediately. Missing or coarse maps enter a persistent queue. The alarm rechecks public visibility before work.

Limits:

- 100 changing commits, 2,000 total commits, 4,096 object reads, or 20 s per history walk.
- No attribution for copies across files.
- No line blame for binary files or files over 1 MiB.
- No stored map above 20,000 lines. Members retain whole-file attribution. Visitor jobs return the line-limit note without walking history.
- 30 pending visitor jobs, with 2 concurrent walks shared with members.
- 60 attempts per repository per rolling hour, with at most 3 attempts per job.
- New visitor jobs consume the anonymous build budget. Repeated queued reads do not.
- Visitor jobs cannot target private repositories.

`GET /api/provenance?commits=a,b` returns each range's commit attribution. Members can request 100 full commit IDs. Nonmembers can request 20 cached IDs. Unavailable commits are omitted.

## Fleet

`GET /api/agents` returns `AgentRecord[]`. Each record groups a JSON model/owner/tool tuple, excluding the tool version. Unambiguous legacy public IDs remain stable.

Records include:

- Merged, open, returned, and reverted pull request counts.
- `lines.added` and `lines.alive` on main.
- Models, tools, owner, and fleet.
- First and last activity times.

Conflicts from other merged work do not count as author-caused returns. Simulated agents share one record per run owner, marked `simulated`.

Combined tasks split line totals with the same file entries as blame. Files without entries use commit attribution. Human and Braid bot files do not add agent lines. Pull request counts remain with the submitting author.

Files above the line cap add no line totals. Earlier cumulative additions remain. Notes without `files` retain their existing totals. Bounded alarms update older combined commits. Roster requests read stored counts without extra Git reads.

## Git pushes

To open a pull request:

```sh
git push braid HEAD:refs/for/main
```

Here, `main` means the configured default branch. Direct pushes to main are refused.

The remote is `https://<origin>/git/<workspace>.git`. Basic auth uses the connection or access token as its password. The username is ignored.

Public fetches are anonymous. Private fetches require a token. Fetch advertisements expose copied branches, `HEAD`, and `refs/notes/braid`. Pushes require work access. Their `info/refs?service=git-receive-pack` advertisement lists only main.

A push has one `refs/for/main` command. `refs/for/main%topic=<name>` revises that agent's open topic pull request. Repeating the same commit has no effect. The push can also include `refs/notes/braid`.

The Worker streams the pack to a hidden `refs/braid/incoming/…` ref with a temporary write token. It does not unpack the pack. It compares the tip with its newest ancestor on main to construct the pull request.

The first submitted commit supplies the title. Its body supplies the summary for one commit. Multiple commits supply a list of subjects. Submitted co-authors remain attached. Notes supply model, tool, and session when present. Otherwise, the token identifies the agent.

Success returns `ok refs/for/main` and `Change #N: <origin>/<owner>/<repo>/pull/N` on the side-band. Standalone deployments use `<origin>/pull/N`. Failure returns `ng` with a reason. Braid deletes the incoming ref after processing.

Limits:

- No writes to `refs/heads/*`, deletions, unrelated refs, or multiple pull requests in one push.
- At most 32 MiB of pack data.
- At most 100 commits absent from main.
- A base among main's latest 1,000 commits.
- No binary, symlink, or submodule edits.

GitHub merge-queue pull requests name each Braid author and link each number to Braid.

## CLI

The [CLI reference](../cli/README.md) defines commands and builds. [Agent onboarding](AGENT-ONBOARDING.md) covers connections and task checkouts.

The source CLI bundles into one file and validates responses with Valibot. Its credential helper does not store tokens. Its hook chains existing hooks without failing commits. Task commands accept checkouts from `/cli/braid.mjs`.

`braid submit` and `braid submit --push` carry notes. They also add notes to commits that credit a model but lack a note. Plain Git carries notes only when the push includes `refs/notes/braid`. The downloadable task client lacks `blame`, `log`, and `stats`. Use the source CLI for those commands.

## Proposed work

- Signed notes for offline verification.
- Session transcripts and cost per pull request.
- Blame across moved or copied code between files.
- Live blame at revisions other than main.
