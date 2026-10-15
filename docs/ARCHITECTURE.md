# Architecture

Braid runs as one Cloudflare Worker with React assets. Cloudflare supplies SQLite-backed Durable Objects, Workflows, Containers, Workers AI, Email Service, and Artifacts Git storage.

Agents submit pull requests, called `changes` in the API. The merge queue combines approved pull requests with main and runs configured checks before pushing. GitHub is optional. A repository can use Artifacts alone, merge through GitHub pull requests, or mirror main to GitHub.

## Code layout

`worker/index.ts` exports the fetch handler, Durable Objects, and Workflows. `worker/env.ts` defines bindings. `worker/schemas.ts` validates inputs with Valibot. `worker/errors.ts` defines `HttpError`, RPC `Result` values, and HTTP error mapping.

Each Worker folder owns a domain and its tests:

| Folder | Responsibility |
| --- | --- |
| `worker/http/` | API gateway, sign-in, agent tokens, authorization, public reads, and MCP. |
| `worker/accounts/` | Directory and Security objects, organizations, repositories, sessions, secrets, OAuth, email, passkeys, and notifications. |
| `worker/workspace/` | Workspace object, task Workflow, integration, local agents, and example seed. |
| `worker/repositories/` | Trees, commits, comparisons, history, branches, search, and provenance. |
| `worker/git/` | Smart HTTP, agent pushes, commits, and Git notes. |
| `worker/github/` | GitHub API, routes, webhooks, merge bridge, and mirrors. |
| `worker/agents/` | Hosted agent containers, execution, failures, providers, and reports. |
| `worker/changes/` | Pull request store, merge queue, path index, attribution, and simulated agents. |

`src/` contains the React UI. `shared/types.ts` defines the public contract. `shared/merge/` contains merge algorithms. `shared/policy.ts` evaluates policy. `shared/questions.ts` supplies review questions and policy descriptions.

## Pull request store

Each repository uses 16 SQLite Durable Objects for pull requests. IDs encode the shard for direct lookup. Submissions name a base commit. Each edited file supplies text or a Git blob hash. The store reads base files through a Git object cache.

The store computes line counts, runs guards, records path overlaps, and evaluates policy. Internal states are:

- `open`: review or prerequisites pending.
- `revise`: returned to the author.
- `attention`: owner decision required.
- `queued`: ready for the merge queue.
- `landing`: merge in progress.
- `landed`: merged.
- `closed`: closed without merging.

Git submissions store blob hashes instead of file contents in revision patches. The store scans each new blob as a stream. Large metadata records use 32,768-character chunks. SQLite rows stay below the platform's 2 MB limit. List requests read compact summaries instead of full file lists.

Repeating a submission's idempotency key returns the original pull request. Dependent pull requests wait outside the queue until their prerequisites merge. Restacking reapplies their own edits as a new revision. It clears approval. Conflicts return to the author.

The path index uses 16 shards to track overlapping active pull requests. Agents can query it before editing with `change touching`. Each submission also lists overlaps. The index does not lock files.

## Policy and review

`.braid/policy.json` on main sets path-specific review requirements. Later rules override earlier rules, as in `CODEOWNERS`. Policy also sets checks, merge rules, size limits, guards, earned autonomy, daily author caps, and a veto delay.

Edits to policy, agent instructions, CI workflows, and `CODEOWNERS` always require owner review. Invalid policy requires owner approval for every pull request. This includes malformed JSON, unknown fields, invalid values, oversized files, and binary policy files. Settings shows parsing errors and line numbers when available. An owner can approve an exact revision.

`shared/glob.ts` bounds matching work by pattern length multiplied by path length. Authors need 3 clean merges before independent work under the default policy. Policy can change that threshold and its review requirement.

Author-caused failures include failed checks and requested revisions. Repeated failures require owner review after the configured limit. Conflicts caused by other merged work do not count.

Reviewers can be other agents, GitHub review apps, or people. Workers AI supplies structured review for open pull requests awaiting review. Verdicts include approval, revision, escalation, rejection, and comment. Comments never count as approval. Owner approval of the exact revision satisfies its review requirement.

Automated review has a 120,000-character input budget. When a model cannot review the complete input, Braid requests owner review. Binary files also require owner approval. A truncated model prompt cannot approve a pull request.

`shared/questions.ts` turns a policy decision into one question. It identifies the cause once and offers at most 3 actions: approve, request changes, or close. Causes include guards, duplicates, failed revisions, size limits, protected files, and review escalations.

### Code security

Credential scans use provider patterns from Gitleaks. They also check edited private-key body lines. Dependency review checks new versions against OSV.dev, including OpenSSF malicious-package reports.

By default, credentials, malicious packages, and high-severity advisories return the pull request. An unreachable OSV.dev produces a warning.

GitHub can supply CodeQL and other code scanning. Policy can request installed review apps for each GitHub merge-queue pull request. Braid waits for the configured period and records missing reviews. Each Braid pull request receives comments for its own files.

Other CI connects through signed `merge_group` webhooks and commit statuses. See [CI](CI.md). Checks that also fail on main pause merging instead of assigning failure to a pull request.

### Evidence

A revision accepts screenshots and command results. Images are stored once per shard under their SHA-256 hash and served as immutable content. Agent evidence remains reported, not verified. Braid records its own combined-result checks separately.

A reported failing command returns the pull request with its output tail. Current evidence remains complete. Earlier revision evidence stays within a storage budget.

Limits:

- 12 screenshots per revision.
- 600 KB per screenshot and 4 MB total.
- 10 command results per revision.
- 8,000 output characters per command.

### Instructions

`.braid/instructions.json` lists agent rules. Each rule can include blocked strings and path patterns. The queue reads instructions with policy at each main commit. MCP and the AI reviewer receive the same instructions.

An added line containing a blocked string in a covered path triggers `guards.instructions`. The default action returns the pull request. Aho–Corasick matching scans each added line once.

Owners add instructions with `POST /api/instructions`. They remove instructions with `DELETE /api/instructions/:id`. Each request opens an owner-authored, approved pull request. It edits the instructions file and the managed section of `AGENTS.md` from main. Concurrent additions compose through the queue.

## Merge queue

One `Trunk` Durable Object owns each repository's queue. It composes pull requests in order on the current head. One compare-and-swap push preserves a commit for each pull request. The queue rechecks the enabling owner's authorization before every push.

Composition is atomic per pull request. Unchanged base files fast-forward. Other files use three-way line merging with patience alignment. The engine can combine independent list entries and imports. JSON conflicts can use key-level merging. Broader union requires a matching policy path.

Conflicts involving content, deletion, or file types return to the author with their regions. Other pull requests in the batch continue. A moved main causes the queue to compose again on the new head. The queue never overwrites it.

Batch size doubles after clean batches and halves after failures. An observed failure rate also caps it. For failure probability `p` per pull request, a batch of `n` fails with probability `1-(1-p)^n`. The cap targets about `0.29/p`, starting with a prior of 1 failure per 100 pull requests.

A durable push plan supports interrupted-push recovery. The queue retains return messages until the pull request shard acknowledges them. Shards retain task updates until the task acknowledges them. Lost RPC calls therefore remain retryable.

### Combined-result checks

Configured checks run on the exact composed commit. The queue pushes a staging branch. A Workflow runs the repository's install and check commands in a fresh, unprivileged Cloudflare container.

Up to 3 batches verify concurrently by default. Each batch starts from the result ahead of it. They merge strictly in order. Main advances only after required checks pass and its expected head still matches.

The runner repeats failing commands on the baseline. Both RPC responses preserve this evidence. If every failing command also fails on main, merging pauses. Pull requests return to the queue without blame.

Otherwise, the queue halves the suspect set until it isolates a failing pull request. A single failure receives 1 retry by default. Continued failure returns its command output to the author. Infrastructure failures do not count against authors. Batches built on failed or different commits require recomposition.

### Revert

An owner can revert a merged pull request whose parent commit is recorded. The revert opens an approved pull request based on the original merged commit. It restores each affected file to its prior version.

The queue composes the revert with subsequent work. Independent edits survive. Conflicts return for review. Repository checks still apply.

## Provenance and Git

Merged commits name the agent's owner. Their messages contain the submitted title, summary, and co-author lines. Braid adds no attribution footer. `refs/notes/braid` holds the remaining metadata.

The queue writes notes after merges. Failed writes remain pending without blocking main. Braid's stored merge records take precedence over imported claims. Incremental line maps support blame and fleet totals. Combined tasks keep file-specific attribution.

[Provenance](PROVENANCE.md) defines note fields, confidence, history seeding, line limits, public job budgets, and fleet counts.

The Git endpoint is `https://<origin>/git/<workspace>.git`. Public repositories allow anonymous clone and fetch. Private reads require a token. Pushes require work access.

A push to `refs/for/main` opens a pull request. A `%topic=<name>` suffix revises the same agent's topic pull request. Here, `main` means the configured default branch.

The Worker streams the pack into a hidden Artifacts ref. It reads commits to construct the pull request, then removes the ref. The response links to `/<owner>/<repo>/pull/<number>`. Fetches expose copied branches and Braid notes.

### Large submissions

Pull requests have no file-count or total-content cap. Each new blob can contain up to 31,998,976 bytes. This leaves 1 KiB below Artifacts' 32 MB blob limit. Artifacts limits each repository to 1 GB.

A Git push can transfer up to 29,000,000 bytes. Artifacts rejects pushes near 30 MB. Larger pull requests use separate uploads. Each upload names a commit that adds a smaller set of objects.

1. Split new objects across commits whose packs fit the transfer limit.
2. Upload each commit to a separate name:

   ```sh
   git push braid <first-commit>:refs/braid/uploads/part-1
   git push braid <second-commit>:refs/braid/uploads/part-2
   ```

3. Open the pull request:

   ```sh
   git push braid HEAD:refs/for/main
   ```

4. Remove each upload ref after submission:

   ```sh
   git push braid :refs/braid/uploads/part-1
   git push braid :refs/braid/uploads/part-2
   ```

Upload refs belong to the authenticated agent. Public fetches do not list them. Each upload checks work access. Uploads do not move main. The merge queue still checks its owner's authorization before each push.

Before accepting a revision, Braid pins its blobs under a hidden, content-addressed ref. The ref also retains its base and submitted commit. This protects review history from Git garbage collection after upload refs are removed. Braid checks the owner's current access before creating this ref. These objects count toward Artifacts' repository limit.

The final submission contains paths, modes, and blob hashes. Independent or identical binary edits merge by hash. Different concurrent binary edits remain conflicts. Line merging reads at most 1 MiB per file. Larger concurrent edits also remain conflicts.

Reverts restore the original blob hash and executable bit through a new pull request. Binary reverts use the same merge queue.

JSON submissions accept inline text or existing blob hashes. The JSON body limit is 31 MiB. Workers limits serialized RPC messages to 32 MiB. HTTP request limits are higher, starting at 100 MB. Use Git uploads for larger content.

Inline commit construction allows 29 MB of new text per push. Tree construction allows 29 MB of decoded metadata. These working budgets reserve memory within Workers' 128 MB limit. Existing blob references do not count toward the inline text budget.

## GitHub

The GitHub App requires Contents and Pull requests write access. It reads Checks and Statuses. Webhooks cover pushes, pull requests, reviews, and checks.

`POST /api/github/link` requires the person's GitHub push access. Every GitHub write or installation-backed read rechecks Braid ownership and the person's GitHub access. Cached installation tokens do not bypass this check.

Writes require push access. They include pull request creation, merging, closing, review requests, and note forwarding. Reads require read access.

| Mode | Behavior |
| --- | --- |
| Pull requests | GitHub is authoritative. The queue refreshes Artifacts from GitHub's default branch before composing. It opens a `braid/land/<batch>` pull request for each batch. |
| Mirror | Braid is authoritative. Each merge fast-forwards GitHub from the last mirrored head. A direct GitHub push stops mirroring. |

GitHub merge-queue pull requests list the Braid pull requests, models, and owners with links. Required checks, `CODEOWNERS`, branch protection, and review apps apply.

Braid reads checks, statuses, reviews, and mergeability. It fast-forwards GitHub when permitted. Otherwise, it uses a merge commit when branch protection requires that path. Cancelled or timed-out checks fail. Neutral and skipped conclusions pass with warnings.

Braid isolates failures to pull requests. File comments return to their responsible authors.

Transfers stream upload-pack into receive-pack without unpacking in the Worker. Target commits become `have` lines. Shallow boundaries identify missing history.

HMAC-SHA256 verifies webhooks. Deduplication occurs per GitHub repository. Webhooks wake the queue, which reads current GitHub state. It also polls while its pull request is open.

## Scale and delivery

List requests gather only shards recorded as containing pull requests. A shard registers when it takes its first pull request number. Repositories without this registry require one scan across all shards.

The queue caches trees and blobs it creates to reduce Artifacts reads. Blobs above 1 MiB bypass the read cache. Composition retains at most 4 decoded file texts. Git hash comparisons avoid decoding unchanged binary content. These bounds protect the Worker's 128 MB memory limit.

Cloudflare's rate-limit binding handles location-specific throttling. Agents exchange connections for 5-minute signed access tokens. Directory checks membership on each authenticated repository request. Security checks revocation.

A fleet connection lets a coordinator mint separate agent identities under one owner approval. Trust and daily limits apply per agent.

Git writes, passkeys, and the recorded example load on first use. Static scripts, styles, and fonts bypass the Worker. Hashed assets cache for 1 year. HTML passes through the Worker for URL-based social metadata before authentication or repository reads.

Limits:

- Deployed throughput with repository checks is not established by the recorded synthetic scale runs.
- Sustained fleet costs remain unmeasured.
- Simulated edits do not measure live model throughput.

## Authorization and public reads

The Worker verifies signed sessions and rejects cross-origin mutations before choosing a Durable Object. Valibot parses external inputs where they enter. These include request bodies, webhooks, GitHub and OSV responses, model output, and policy files.

Security stores session revocation, verified profiles, authentication challenges, passkeys, connections, and usage budgets. Directory authorizes authenticated repository requests. Personal and organization owners can write. Organization teams can grant repository Write access. Other organization members can read.

Usernames and organization slugs share one namespace. Repository slugs are unique within each owner. Generated collisions receive numbered suffixes. Renames retain old addresses as aliases. Unknown and inaccessible private repositories return the same 404.

The gateway discards client-supplied internal authorization headers. Workflows recheck the initiating owner's membership before Git writes.

### Visibility

New repositories default to private when requests omit visibility. Creation forms send their explicit Public or Private selection. Private GitHub imports force private visibility. Linking or syncing a private GitHub repository also forces private visibility with an audit entry. Publishing that private link returns 409.

Legacy repository rows remain private until a member reads retained import evidence. Anonymous discovery does not migrate them or call Workspace objects. Explore lists a repository only when `workspaces.has_commits = 1`. Braid records this when a creation or import finishes. Reservations are not in rows, counts or pagination. A background migration checks existing heads four at a time, and it keeps empty repositories. Discovery uses an `(updated_at, id)` cursor. Durable repository and pull request writes update activity. Failed activity notifications retry.

Directory visibility responses have a 5 s lease in isolate and data-center caches. Forced-private imports wait for that lease to expire.

### Public API

Nonmembers select repositories with `X-Braid-Workspace`. Evidence images use `?workspace=`. Allowed `GET` and `HEAD` endpoints cover code, pull requests, tasks, attribution, policy, instructions, queue status, and coordination. The [frontend API table](FRONTEND-CONTRACT.md#data) gives the complete contract.

`HEAD` has no body. Public capabilities use live viewer mode with `canWrite: false`. Snapshots omit file caches and Artifacts tokens. Sensitive reads and writes require authentication.

Public responses preserve permitted Git content and paths. They redact Braid metadata, including private policy details. They omit credentials, hooks, internal remotes, and private identities. Secret-bearing revisions withhold files and evidence, including merged task overlaps.

Credential findings persist when pull requests are written. Scanner migrations update stored findings. Leaked Braid tokens revoke their connections, including already-issued access tokens. Reads resolve existing public identities without creating new IDs.

Public revision selectors accept branch names, tag names, and their `refs/heads/` or `refs/tags/` forms. Commit hashes and prefixes require publication checks. Hidden refs cannot select revisions. Publication history walks consume the public build budget.

Limits:

- 300 reads/min per IPv6 /64 or full IPv4 address, including mapped IPv6.
- Unknown IDs and 304 responses count toward that limit.
- 60 expensive reads/min, shared by diffs, downloads, upload-pack, and build-capable endpoints.
- 30 cold builds/min per repository, with at most 10 from one network.
- Build-budget exhaustion returns 503 with `Retry-After`.
- Public provenance reads accept 20 cached commits.
- CI and GitHub links appear only when known public.
- Visitor polling has a 30 s floor and skips attention reads.
- Starting an example write lifts the polling floor for 1 min.

`X-Braid-Workspace: demo` selects the recorded example. A visitor's first example write creates a signed identifier for an isolated copy. Each address can create 40 writable copies per day.

### Credentials

Standalone owner-key deployments remain supported. Owner keys and Artifacts tokens stay out of snapshots, logs, Git, and source archives. Server-side write tokens are revoked after use.

Approved local work connections can obtain a 10-minute read token for one fork. The CLI uses a temporary Git askpass environment. It does not put the token in a remote URL or file.

## Repository imports and browsing

Workspace stores project state, task state, context notes, and activity in separate SQLite records. Transactions write changed records only. Each task preserves its starting context and commit.

Imports reserve repository identity before starting an Artifacts import. The initial copy contains one commit from the default branch. Braid waits at most 1.5 s.

`POST /api/project` returns one of these responses:

- `201` with a ready project, including the sample.
- `202` with `importing: {name, source, startedAt, branch?, preview?, error?}`.

The copy continues under `waitUntil`. Completion uses the branch named by the copy's `HEAD`, because Artifacts can report a different default branch.

During GitHub copying, `preview` lets members read files through the GitHub contents API. The installation token has Contents read access only. Every preview rechecks the importer's Braid ownership and GitHub read access.

An initial import publishes as soon as Artifacts finishes it. The Workspace alarm recovers an interrupted publication through the same finalization path. It polls every 2–5 s. Import, workflow, and activity scheduling retain the earliest alarm. Grant and initial-token cleanup run after publication, and they do not hold the finished snapshot. The root tree and README are warmed in the object cache that Code reads. A GitHub or mirror import of a selected branch reads the copy's HEAD, without another branch advertisement.

Background copying transfers default-branch history, then other branches, up to 300 branches. Runs last about 1 min. Thin packs declare the destination's shallow boundary. History arrives newest first in bounded pushes, retained under hidden `refs/braid/history` refs.

`project.branches` grows as copies finish. `branchCopy` counts remaining work. `readingNames` uses the known head when Artifacts cannot resolve the default branch. Refused branches are skipped. Every run rechecks the importing owner.

Members see pending imports in `/api/state`. Public viewers do not. Imports stop with an error after 15 min. An owner or setup connection can retry with idempotent `POST /api/project/import/retry` and `{}`. Private GitHub retries require the person in Braid.

Accepted retry keys replay 202. Snapshots show completion. A stopped import permits another source after Artifacts confirms it retained no repository.

Automatic [GitHub mirrors](GITHUB-MIRRORS.md) reuse copying through a separate read-only path. Unclaimed public namespaces use anonymous Git. Private access and claimed identities use the visitor's GitHub token. Claims record immutable GitHub IDs. Background refresh does not grant write access.

### GitHub import access

Owners authorize the App and select an installation and repository. Braid checks user access, installation access, and repository ownership. Tokens and import grants use context-bound encryption.

The import bridge accepts only upload-pack and streams GitHub data directly to Artifacts. It uses a token scoped to one repository and rechecks current access. Redirects are refused. GitHub credentials never enter browser responses, Artifacts metadata, or agent containers.

### Tree reads

The browser reads the actual Git tree at a pinned commit, one directory at a time. Hidden paths, lockfiles, binaries, symlinks, and gitlinks remain visible. Pagination and inline limits affect display only.

Symlinks are read by blob hash without traversal. Repository inventory does not depend on the text cache. Imports retain tracked files at the imported revision. Background copying adds history even for single-branch sources.

## Tasks

With the merge queue enabled, task results and reverts reach main as pull requests. A single-agent result opens or revises one pull request. It carries task context under `.braid/missions/`.

Several agents with compatible files combine into one pull request under repository policy. Different versions of the same file require an owner choice. The approved combination includes a decision ledger. The queue composes it with current main. The task completes when its pull request merges.

With the queue disabled, tasks use direct integration.

### Hosted execution

A lane is one agent's isolated task execution. Hosted tasks create 1–3 lanes. The execution sequence is:

1. Validate the task, connections, and capacity.
2. Refresh the Artifacts main commit.
3. Save the pinned commit and task context.
4. Save an idempotency receipt and a stable Workflow job.
5. Fork Artifacts for each lane.
6. Revoke each initial fork token.
7. Start a fresh container for each lane.
8. Clone the full repository at the pinned commit.
9. Revoke the bootstrap read token.
10. Verify execution restrictions.
11. Parse repository manifests and record the model’s environment and verification decision, then run the agent.
12. Collect and validate actual Git edits.
13. Publish the proposed commit with a scoped token.
14. Record overlaps and results.
15. Destroy the container.

Durable alarms deliver Workflow jobs and recover interrupted execution. Agents receive no owner, provider, model API, or Git write credentials.

The `exec` tool can inspect instructions, read files, edit code, install dependencies, and run checks. `setpriv` selects UID/GID 1000, removes Linux capabilities, and prevents privilege gains. Preflight checks these restrictions. A different user ID alone is insufficient under the [container policy](https://developers.cloudflare.com/containers/api/durable-object-container/#exec).

Checks retain actual output and exit codes. `finish` reruns repository policy and model-selected checks on the final checkout, then reads Git edits and validates paths, modes, secrets, and size limits. Failed installs and command timeouts return to the model while task time remains; final check failures allow two repair attempts. A repository without tests records that fact without claiming a passing test. Model-authored file lists and check claims are not trusted. Failed checks block merging. Inactivity limits and alarms bound abandoned execution.

Publishing reads affected ancestor trees from Artifacts. It creates only new blobs, changed trees, and the commit. Unrelated contents and history stay on the server.

Different versions of one file become overlaps. Identical files do not. Results enter review or become pull requests. Failures retain their stage and safe explanation. The UI polls durable state and supports reconnection.

Containers include Node, Git, Git LFS, Python, Go, npm, pnpm, yarn, mise and build tools. JSON, Python tomllib and Go’s manifest parser preserve repository declarations, including nested workspaces; they never invent commands. The agent installs repository-declared runtimes and tools such as bun, uv, poetry and Rust with mise. It records choices the repository leaves open. Submodule and LFS pointers remain intact. External contents require initialization and access. Command output and model context have limits independent of repository size.

The default task budget is 27 minutes, preserved across retries and resumptions; Retry with more time allows 54 minutes. Model-selected commands accept 1–600 seconds and configured setup/checks receive up to 10 minutes, bounded by remaining task time. Increased task budgets scale command and model limits by up to two. A task watchdog bounds stalled RPCs. Timeout evidence records command, limit kind, numeric limit and elapsed time.

Hosted errors retain safe diagnostics without raw credential-bearing exceptions. Git and GitHub profile requests use manual redirect handling and refuse redirected responses.

### Provider keys

Workers AI is an explicit keyless choice and the default without a connected provider. A signed-in owner can select their connected OpenAI, Anthropic, or OpenRouter provider in Settings. Tasks freeze the selected model and, for a connected provider, its owner and key version. A failed selected provider never falls back to Workers AI or another key. ChatGPT and Claude subscription plans stay local.

`/api/providers` validates keys before storage. Security seals them with AES-GCM bound to the person and provider. Responses show only connection state, last use, and reported rate or credit limits.

Tasks pin the key owner and version. Each model request borrows that key from Security through the sandbox Durable Object. Keys never enter containers. Replacing or disconnecting a key stops the task at its next model call.

Agent connections cannot start tasks with an owner's provider key. Rejected keys require reconnection. Braid does not substitute another provider or owner's key. Subscription-based coding tools run locally with the owner's CLI login. See [agent onboarding](AGENT-ONBOARDING.md).

### Local execution

Local tasks pin the same commit and context without starting hosted Workflows. Approved work connections claim 1–3 lanes and clone complete isolated forks. Sparse paths, skip-worktree entries, and partial or promisor clones are refused before renewal or submission.

The coding tool runs on the owner's machine. The Node task CLI preserves local commits and edits. It collects bounded text files, regular-file deletions, and executable modes.

Submission requires the original base, summary, rationale, stable idempotency key, and active claim. The Worker reads actual base files and stages the exact content. It rechecks owner membership and connection revocation before publication. A prepared commit supports lost-response recovery. Different content cannot replace a staged submission.

Local passing reports remain unverified warnings. Reported failures block merging. Expired connections can be approved again to renew existing checkouts. Another connection cannot take an active claim.

Owners can cancel unfinished local tasks. Agent connections cannot cancel tasks, resolve overlaps, or merge. Local failure does not start a substitute hosted agent.

### Local revisions

Local work defaults to one coordinator. Its subagents need no separate Braid connections. Revisions require the prior commit. Chunked SQLite plans use request signatures to recover exact commits across retries.

A pending revision blocks merge and update. Earlier results remain immutable and linked by commit. Integration preserves revision attribution.

Updating a task returns a read token for current main without changing accepted code or checks. The coordinator fetches and checks locally. Only single-agent tasks can submit from a new base, which must equal current main. That submission uses a fresh fork.

Large diffs use immutable content records. Snapshots and previews contain hashes, line counts, deletion and mode metadata, and references. File review verifies task and agent ownership before loading a referenced diff.

Schema-2 backups stream snapshots, context, and immutable content. They omit credentials and mutable Git plans. Exports capture content IDs before streaming and read each record's parts separately.

The Git tree builder validates all edits, including context paths, before staging. Unsupported replacements and metadata limits preserve reviewed work. Recovery checks for the prepared main commit before rebuilding a migrated fingerprint.

## Integration

Direct integration requires these conditions:

- The task is in review.
- Every included agent has completed.
- No check has failed.
- Every overlap has a valid selection.
- Main still matches the task's base.

Warnings for unexecuted checks remain visible. The preview uses the same file-selection rules as integration. Identical contributions count once. Unresolved files have no selected diff.

The preview snapshots task state before asynchronous hashing. Its SHA-256 fingerprint covers intent, base, proposed edits, evidence, selections, reasons, and starting context. It is not a Git commit or CI result.

Live merge requests require the fingerprint and an idempotency key. A changed fingerprint returns 409. Decisions freeze while validation and submission proceed. Missing historical context remains unavailable.

Integration adds a JSON decision ledger, Markdown agent context, and a handoff to the selected tree. The ledger includes the fingerprint, file attribution, and check limits.

Direct publication checks main's advertised head against the base. Receive-pack compares the old commit atomically. Successful unpack and ref acknowledgments are required. Lost responses recover only when main equals the recorded prepared commit.

Direct integration produces a squash commit with agent commit IDs retained as attribution. Task selections apply to whole files. Line and structural merges apply after submission to the queue.

## Recorded example

`worker/changes/record.test.ts` runs the real store, policy, merge engine, queue, and GitHub gate with scripted agents, reviewers, and checks. Its Relay service recording includes `recorded.json` and `recorded-main.json`. The final merge group finishes before recording. Opening the example has no pending batch.

The recording includes line attribution, commits, 6 model/owner agent rows, and a run of 36 simulated agents. Its sample task starts from the recorded main commit. Claude Opus 5.5 and GPT-6.1 Sol propose different `src/limits.ts` versions. Gemini 3 Pro supplies documentation.

Visitors first read a shared recording. Their first write creates a separate copy. Review decisions and sample task results apply over the recording. Approved work progresses through the example queue and merges with three-way composition.

Visitor-created merges state that no checks run. Agent output, reported commands, and commit IDs are predetermined. Screenshots come from Chromium renders during recording. Repository instructions still apply. Labels identify the example without implying model calls, forks, or remote pushes.

Owners can also run up to 2,000 labelled simulated agents against live repositories. Their edits are synthetic. Review, policy, merging, and Git publication use the real implementation. See [recorded measurements](VERIFICATION.md#thousands-of-simulated-agents-on-a-deployed-worker).

## Implementation references

| Mechanism | Source |
| --- | --- |
| Source reads without cloning | [MCP](../worker/http/mcp.ts) and [composer](../worker/changes/trunk.ts). |
| Incremental attribution | [File counts](../worker/changes/file-lines.ts) and [attribution](../worker/repositories/provenance.ts). |
| Expected-head pushes | [Queue](../worker/changes/trunk.ts) and [Git transport](../worker/git/transport.ts). |
| Public immutable caching | [`cachedRepositoryRead`](../worker/http/api.ts), with a 10 s branch-head cache. |
| Combined-result verification | [Workflow](../worker/changes/verify.ts) and [queue tests](../worker/changes/changes.test.ts). |
| Approval constraints | [Policy](../shared/policy.ts), [parser](../shared/policy-file.ts), and [questions](../shared/questions.ts). |

[Anthropic's source-control report](https://www.anthropic.com/engineering/redesigning-source-control) describes related choices. Braid uses GitHub-style RPC names, not a cross-forge protocol. It checks configured commands before merging. It has no comment-only approval classifier.

The [100-pull-request experiment](VERIFICATION.md#the-judges-walk-fixed-and-evidence-for-the-engine) records 55 merges through Braid and 18 through Git. It uses scripted edits and does not measure production throughput.

## Limits

- Pull request content uses the [large submission path](#large-submissions). Command output, model context, and hosted task collection have separate bounds.
- Repository size does not determine publication transfer size.
- Backups export state and task context. Automated restore and retention/deletion workflows are not implemented.
- A passing hosted check proves only that its recorded command exits successfully.
- Project CI remains responsible for complete release requirements.

## Official references

- [cf programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- [Artifacts namespace lifecycle](https://developers.cloudflare.com/artifacts/concepts/namespaces/)
- [Git operations from Workers](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers RPC limits](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
