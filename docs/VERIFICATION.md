# Verification

These records describe checks at the stated release. They do not establish the state of later code. Missing dates, commands, and locations remain unspecified.

Historical rows name the public copies of their tools. Earlier runs used copies in private audit storage.

## Release 6cae873b

Date: 2026-10-15, about 03:45 IST (22:15 UTC on 2026-10-14). Version `6cae873b-bd96-40d1-99f1-ca728100d943` deployed to https://braid-git.acmvit.workers.dev. The build ran from a copy of the working tree, so that concurrent edits could not enter it. Tools: Node.js 26.9.0 and project-local `cf` 1.0.0-beta.17.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | Worker types and TypeScript passed. |
| `npx vitest run` | 0 | 3,677 passed and 5 skipped, in 304 files. The 13 failures of the earlier setup run were fixed. |
| `npm run deploy:public` | 0 | Worker, assets and sandbox container deployed. |
| `node scripts/braid-shell.mjs` on the deployed build | 0 | 181.3 KB gzip in 4 files, below the 181.5 KB budget. |
| `node scripts/smoke.mjs https://braid-git.acmvit.workers.dev` | 0 | Conditional reads, merge gates, integration preview, queue landing, handoff, replay, and origin checks passed. |
| `node scripts/judge-canary.mjs` | 0 | Passed in 19.7 s with 83 HTTP reads and no warnings, at 1440×900 and 390×844, including GitHub mirrors. |

A review of the large pull request path ran before this release. It used `npx vitest run worker shared cli`, and 2,710 tests passed. It added tests for secret-bearing history, authorization during Git writes, binary mode conflicts, and the Artifacts blob memory limit.

Limits:

- No hosted agent task ran against production in this check.
- Revision retention refs have no automatic cleanup. About 19 different 50 MiB revisions fill the 1 GB Artifacts repository limit.

## Published source setup

Date: 2026-10-14. Snapshot: 18:26:46 UTC. Place: `/tmp/braid-judge/repo`, copied from the publishable file list without credentials or runtime state.

The list contained 857 paths. Of these, 838 existed on disk. The other 19 paths were deleted files still listed in Git's index.

Tools: Node.js 26.9.0, npm 11.19.1, Git 2.56.0, and project-local `cf` 1.0.0-beta.16. The latest global `cf` install returned beta.17. Commands inside the project still selected its locked beta.16.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | 283 packages added. npm reported 4 high-severity advisories. |
| `npm run typecheck` | 0 | Worker types and TypeScript passed. |
| `npm test` | 1 | 3,563 passed, 13 failed, 5 skipped. The failures were in 2 workspace test files. |
| `npm test -- worker/workspace/local.test.ts worker/workspace/workspace.test.ts` | 1 | The same 13 failures repeated. 232 tests passed. |
| `npm run build` | 0 | Worker assets and the sandbox image built. Docker was running. |
| `npm run build:cli` | 0 | CLI bundle and license notices built. |
| `node cli/dist/braid.mjs --help` | 0 | Full CLI commands appeared. |
| `node /tmp/braid-judge/repo/cli/dist/braid.mjs stats` | 0 | A fresh `octocat/Hello-World` clone showed 1 line in 1 file, attributed to people. |
| `npx --no-install vite --host 127.0.0.1 --port 4547 --strictPort` | 130 | Server ready without secrets or remote bindings. Stopped with SIGINT after smoke passed. |
| `node scripts/smoke.mjs http://127.0.0.1:4547` | 0 | Conditional reads, merge gates, integration, queue, handoff, replay, and origin checks passed. |
| `node scripts/braid-shell.mjs` | 0 | 181.3 KB gzip in 4 files. |
| `node scripts/judge-canary.mjs https://braid-git.acmvit.workers.dev --no-mirrors` | 0 | Public checks passed in 16.6 s, with 64 HTTP reads and no warnings. Both Chromium viewports passed. |
| `npx --no-install vitest run worker/http/setup-guide.test.ts worker/http/setup-guide-contract.test.ts` | 0 | 84 tests passed in 2 files. |

This run installed Playwright separately. Its install preserved both package files and the locked build dependencies.

Node.js 22.22.0 also passed typecheck and CLI help. This did not repeat the full suite on Node.js 22.

Limits:

- The copy has no Git metadata. Source packaging requires a Git checkout and Python 3.
- No deployment, live repository write, hosted agent run, or Cloudflare sign-in ran in this check.
- The test failures prevent a passing judge setup result for this snapshot.
- Concurrent source edits after the snapshot were outside this run.

## Documentation contracts

Date: 2026-10-14. Place: local source checkout.

Command: `npx vitest run worker/http/setup-guide.test.ts worker/http/setup-guide-contract.test.ts`.

Result: 84 tests passed in 2 files. Duration: 1.97 s. This check does not establish a full-suite, build, browser, or deployment result.

## Release d919fb16

Date: 2026-10-14. Production: [Braid](https://braid-git.acmvit.workers.dev), version `d919fb16`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npx vitest run` | 3,319 passed, 5 skipped. 255 files passed, 3 skipped. |
| `npm run build && node scripts/braid-shell.mjs` | Shell: 181.1 KB gzip in 4 files. |
| `node scripts/smoke.mjs` | Passed against production. |
| `node scripts/judge-canary.mjs` | Passed against production in 31.0 s with 95 HTTP reads. |

The `openai/codex` copy stopped at 7,491 commits. Artifacts returned `ERR artifacts_git_receive_pack_storage_limit` for every push, including an empty push. Scratch repositories and a full local clone established these observations:

- The 1 GB repository limit counts individually compressed objects, not transferred packs.
- A scratch copy reached 8,448 commits after 120 MiB of pack transfers.
- Those objects occupied about 1,041 MB when compressed individually.
- The first 7,491 commits occupied an estimated 918 MB, sampled from one-fifth of the objects.
- Complete Codex history exceeded one repository's capacity.
- Non-thin history parts resent 6–8 MiB snapshots. Thin parts used about one-tenth as much data.
- Reusing a recently deleted Artifacts name returned 409.

The release implemented replacement for full copies. It created a new import beside the full copy. The full copy served until the replacement became ready, then was deleted. Replacement history used 60% of the prior depth and only the default branch.

Limits:

- Production replacement had not run.
- The next signed-in Codex sync was expected to retain about 4,500 of GitHub's 12,201 commits.
- That expected depth was not a completed production measurement.

## Release ee4fbe1f

Date: 2026-10-14. Production: [Braid](https://braid-git.acmvit.workers.dev), version `ee4fbe1f`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npx vitest run` | 3,310 passed, 5 skipped. 255 files passed, 3 skipped. |
| `npm run build && node scripts/braid-shell.mjs` | Shell: 181.1 KB gzip in 4 files. |
| `node scripts/smoke.mjs` | Passed on fresh development state and production. |
| `node scripts/judge-canary.mjs` | Passed against production in 25.4 s with 95 HTTP reads, including mirrors. |

Artifacts imports allowed at most 40 MB. Mirrors opened one commit deep, then copied history in parts. Artifacts accepted a 26 MB push and refused a 31 MB push.

Production observations:

- `octocat/Hello-World` exposed its complete 2-commit first-parent history.
- `openai/symphony` exposed all 47 commits. Its Git clone was complete, not shallow.
- `openai/codex` was still copying its 12,182 commits.

Existing mirrors copied history on their next sync. Interrupted transfers stopped consuming the mirror budget. Failed copies retried after 1 h.

Mirror page observations:

- Public mirror badge with source attribution.
- 46 px commit bar.
- Prior file retained until the next file read.
- Cold viewport geometry with locally measured CLS 0.

Worker domains moved to `http/`, `accounts/`, `workspace/`, `repositories/`, `git/`, `github/`, and `agents/`. Error mapping used typed signals. See [Code layout](ARCHITECTURE.md#code-layout).

## Release ebf543f9

Date: 2026-10-14. Production: [Braid](https://braid-git.acmvit.workers.dev), version `ebf543f9`.

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Passed on deployed source. |
| `npx vitest run` | 3,291 passed, 6 skipped. 252 files passed, 3 skipped, before the final 4 small edits. |
| Focused suites after those edits | Mirrors: 72 tests, including a regression that failed without its fix. Guide contracts: 84. Hosted output: 48. |
| `npm run build && node scripts/braid-shell.mjs` | Shell: 180.9 KB gzip in 4 files. |
| `node scripts/smoke.mjs` | Passed on fresh development state and production. |
| `node scripts/judge-canary.mjs` | Passed against production in 23.9 s with 95 HTTP reads. Mirror checks compared `octocat/Hello-World` with GitHub's head. |
| Production mirror browsing | `/octocat/Hello-World` and `/openai/codex` imported on first visit in about 10 s and 20 s. Tree, files, history, blame, and pages returned 200 without console errors. |

The release added these features after `a7a9ce70`:

- GitHub mirrors, namespace claims, and user-authorized private mirrors.
- Model-written pull request guides.
- Diff function signatures and moved-code links.
- Local agent activity.
- Typed hosted failures with recovery.
- Hosted provider keys.
- `report_problem` and public MCP reads.
- Full CLI at `/cli/braid-git.mjs`.

Limits:

- No live GitHub permission-revocation check.
- No GitHub write check.
- No hosted task using a real provider key.

## Production canary

The browser canary needs `playwright-core` and Chromium. The root `npm ci` installs `playwright-core` as a development dependency. Complete the [local setup](../README.md#run-locally) before these steps.

1. If Chromium is not cached, install it.

   ```sh
   npx playwright-core install chromium
   ```

2. Check the command options.

   ```sh
   node scripts/judge-canary.mjs --help
   ```

3. Run the public checks without mirror creation or refresh.

   ```sh
   node scripts/judge-canary.mjs https://braid-git.acmvit.workers.dev --no-mirrors
   ```

Without an origin, the command uses the deployed Braid URL. It reads landing pages, guides, source ZIP, MCP tools, crawler previews, tour APIs, and public repository routes. Chromium checks desktop and phone views. It creates no tour sessions.

Mirror checks run by default. They can create or refresh `octocat/Hello-World` on the target deployment. Use them only on a deployment where you authorize those writes.

- `--no-mirrors` skips mirror checks. Its time limit is 110 s.
- `--require-mirrors` includes mirror checks and refuses skipped mirror coverage. Its time limit is 180 s.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects an installed Chromium executable instead of the downloaded browser.
- Failures or incomplete coverage return a nonzero exit code.
- Confirmed empty repositories produce warnings.

The [local API smoke check](../README.md#verify) writes to a separate tour session. It does not cover public repository access.

<a id="the-judges-walk-fixed-and-evidence-for-the-engine"></a>
## Release 3688c684

Date: 2026-10-13. Deployed version: `3688c684-2a22-4483-9c0e-17b1b012febc`.

Recorded gates passed:

- `npm run typecheck`.
- 2,390 tests in 171 files, with 5 skipped, including recording and opt-in search benchmark.
- Production build: 179.0 KB gzip shell in 4 files.
- Smoke against fresh development state.
- Deployment preflight.
- Source packaging.

The example recording completed its final merge group. Pull requests #36 and #51 included scripted Braid `npm ci`, typecheck, and test results, plus CodeRabbit and Copilot reviews. Opening a visitor copy started no pending merge. Duplicate policy held #73 against #51. A person closed #73 as superseded.

The `refund-rounding` branch supplied Code, Blame, Commits, and Compare. Cited pull request numbers stayed unchanged. The landing page used 5 sections with one sentence and picture each.

Agents used one composer for connected and hosted agents, up to 3 at once. New task used the same composer. Empty lists used one line. Simulated agents appeared last. Visitors did not wait for unreadable connections.

Dependency support covered API, CLI `--depends-on`, MCP `depends_on`, and task results. Dependents waited for prerequisites. Restack produced a new revision on changed prerequisites. Conflicts remained unresolved.

### Search, blame, and loading measurements

Cross-repository search at `/search` supported `repo:`, `org:`, `user:`, `path:`, and `language:`.

| Measurement | Result |
| --- | --- |
| Cold production search on a 140 MB imported repository | 6.8 s. |
| Local search with 10 ms simulated read latency | 6.5 s before, 1.2 s after. |
| Index after import/merge | 20 ms. |
| Local blame, 500 lines and 50 changing commits | 956 ms cold, 0.26 ms cached. Every line matched `git blame --first-parent`. |
| Controlled route comparison with 250 ms request latency | Pull request #23, Agents, Explore, Blame, and pull request list: about 1.35 s before, 0.8 s after. |
| Files changed, first diff | 1.6 s before, 0.86 s after. |
| Visitor example merge display | About 1 min before, 20 s after. |

Visitor blame requests queued bounded background work. Screens used route-specific skeletons and early reads.

### Security checks

Revoked connections rejected access tokens on the next request, replacing a delay of up to 5 min. Visitors on one network received separate example sessions. Public commit messages received metadata redaction. The unsubscribe form submitted successfully.

Review fixes covered:

- Restack races with reused idempotency keys.
- Stale default-branch reads after lost notifications.
- Early reads surviving sign-out.
- Publication of secret-withheld prerequisites through restack.
- Anonymous search build-budget accounting.
- Late lookups exposing private names after sign-out.

### Merge-engine experiment

A local harness replayed 1,415 file merges from 718 two-parent commits in 8 public repositories. Sources were Express, Flask, Gin, ripgrep, mdBook, JSON Schema, Yarn, and npm. It compared Braid, `git merge-file`, and committed results.

The harness found 6 unsafe automatic results, including duplicated tests and release sections. The corrected engine returned conflicts for those cases. Clean Braid merges where Git conflicted fell from 54 to 4. Three matched the committed file. One preserved independent tests in a different order.

The example's 2,056 recorded merges stayed unchanged. Repository suites did not run. These results do not establish semantic correctness.

### Attribution experiment

The selected corpus contained 93 labelled commits from 24 public repositories. It covered Claude Code, Codex, Copilot, Cursor, Devin, Jules, Aider, OpenHands, Sweep, Amazon Q, and Gemini CLI.

Agent/human precision rose from 75.0% to 100%. Recall rose from 64.3% to 97.1%. Human false positives fell from 6 of 14 to 0. Dependabot and Renovate received separate bot attribution in Blame and `braid stats`.

The corpus selected coverage examples. It was not a random sample.

### Concurrent-edit experiment

Local scripted edits targeted one TypeScript project. Braid's composer and a Git queue using `git merge-tree` processed them in order.

| Scripted pull requests | Braid merged | Git queue merged |
| --- | --- | --- |
| 25 | 16 | 9 |
| 50 | 29 | 12 |
| 100 | 55 | 18 |

Checks on combined trees caught the same 8 seeded cross-file failures in both systems. No merged pull request lost its own test. Independent list entries and `package.json` edits explained the gain. Overlapping exports, imports, and README sections still conflicted.

Composition took about 0.2 ms per pull request in Braid and 6.7 ms in Git. No live models produced these edits.

<a id="third-qa-round-fixed"></a>
## Release 56593402

Date: 2026-10-13. Deployed version: `56593402-28e3-43dc-9fc0-10971617964c`.

Recorded gates passed:

- `npm run typecheck`.
- 1,967 tests in 126 files. Recording skipped.
- Production build.
- Smoke against fresh development state.
- Deployment preflight.
- Source packaging.

QA covered production, development, and a signed-in mock. It found 0 blocking, 6 serious, and 9 minor problems. The release fixed the code issues. Public test-repository curation remained with the owner.

Keyboard and phone checks confirmed focused comment forms, focus return on Cancel, 24 px line targets, and ⌘Enter/Ctrl+Enter submission. Organization tabs fit 390 px. Inbox counts remained visible. Search restored focus. Visitor headers retained repository names.

Axe-core 4.14 checked WCAG 2.1 AA on 18 code/pull-request views and 40 account, organization, and header states. It found no violations in those rechecks. Selected line-number contrast was 7.2:1. Code-comment contrast was 8.1:1.

Files changed used nested lists. Pages had one `h1` and unique landmark names.

Other checked fixes:

- Passkey confirmation for email accounts.
- Flat primary buttons.
- “Pushes” in pull request labels.
- A real example comparison.
- Named actors in organization history.
- Landing-header CLS 0 on every production page measured.

<a id="usernames-and-a-header-that-follows-the-page"></a>
## Release adadf11d

Date: 2026-10-13. Deployed version: `adadf11d-3888-4c08-8d8e-29bffc1af1ba`.

Recorded gates passed:

- `npm run typecheck`.
- 1,930 tests in 122 files. Recording skipped.
- Production build.
- Smoke against fresh development state.
- Deployment preflight.
- Source packaging.

Usernames shared a namespace with organizations. GitHub sign-in claimed an available login. Personal profiles used `/<username>`. Repositories used `/<username>/<repo>`. Renames preserved aliases.

`@username` replaced public email display. Email remained in Account settings. The same-origin avatar proxy restricted hosts, refused redirects, and passed only images.

The shared header rendered location before data. It included Search, creation controls, review count, and an account menu. The menu supplied username, profile, organizations, Settings, and Sign out.

<a id="organizations-review-comments-and-steady-loading"></a>
## Release 5ee26617

Date: 2026-10-12. Deployed version: `5ee26617-467c-4f99-9107-ec74aa00a4f3`.

Recorded gates passed:

- `npm run typecheck`.
- 1,812 tests in 119 files. Recording skipped.
- Production build.
- Smoke against fresh development state.
- Deployment preflight.
- Source packaging.

Organization creation stopped creating repositories. Organization pages supplied Overview, Repositories, Teams, People, and Settings. Visitors saw only public repositories. Teams gained maintainers and repository Read/Write grants. Repository settings and organization administration remained owner-only.

Settings Access listed grants. The API used `/api/orgs`. Account responses retained both `organizations` and compatibility `teams` for existing tabs.

People could comment, reply, and resolve conversations. Line comments followed revisions or became outdated. Unresolved comments reached `braid wait`, task briefs, and hosted revisions. MCP exposed them through `list_pull_request_review_comments` and `add_reply_to_pull_request_comment`. Work connections could reply. Only people could resolve.

Email notifications covered owner review requests and returned agent work. Notifications batched per minute, deduplicated, and capped at 20/h. Settings and confirmed email links controlled subscriptions.

CLS fell from 0.03–0.06 to 0 on example Code, Pull requests, pull-request detail, Agents, and a 140 MB repository. Measurements covered desktop and phone.

Other checks covered:

- Passkey management within 2 h of sign-in, then confirmation by passkey or GitHub.
- Branch-aware search links and commit-hash comparisons.
- Missing-file errors.
- Accessibility failures reduced from 77 nodes to 0 across 6 pages.
- Halved idle prefetching.
- Retried stalled account reads.
- Route downloads reduced by 10–30%.
- Shell: 180.8 KB gzip in 4 files.

<a id="a-github-shaped-repository-an-inbox-and-steering"></a>
## Release 67ed9d0c

Date: 2026-10-12. Deployed version: `67ed9d0c-24d6-4db8-accc-530191e97559`.

Recorded gates passed:

- `npm run typecheck`.
- 1,658 tests in 104 files. Recording skipped.
- Production build.
- Smoke against fresh development state.
- Deployment preflight.
- Source packaging.

The release added owner pages, Explore search/sort, history, commit pages with short hashes, branches, comparison, code search, and a cross-repository inbox.

Tasks could select 1–3 owner work connections. Only selected connections could claim them. Owner instructions reached connected task context and hosted checkpoints. Run times appeared only when measured.

This recording still contained a pending merge group. Visitor copies merged it with a “no checks ran” label. Example reviews named the Braid reviewer. Example owners had logins. Shared copies and caches were deployment-specific.

An error boundary retained the header after screen failures. ⌘K searched loaded pull requests by title or `#number` and searched code. Routes preloaded their code. Icons shared a chunk. The shell fell from 199.4 KB in 6 files to 183.4 KB gzip in 4.

Production cold-load medians from Asia, 3 loads each:

| Page | LCP before | LCP after |
| --- | --- | --- |
| Landing | 1.7 s | 1.1 s |
| Explore | 2.6 s | 1.1 s |
| Example Code | 2.9 s | 1.5 s |
| Pull requests | 3.1 s | 1.5 s |
| Pull request #23 | 3.0 s | 1.5 s |
| File | 3.2 s | 2.1 s |

File requests fell from 86 to 39. One read reached the prior version immediately after deployment and returned 404. New reads answered after 20 s. Only successful responses entered caches.

## Faster example reads

Date: 2026-10-12. Five deployed versions:

- `1be547ad-f2fa-40a9-bcb5-9b82b746f81e`.
- `7fc94668-443e-45c0-9425-d950d5a2b7c3`.
- `da693a36-31f3-4922-8fe2-8abe396858fa`.
- `c88d3122-b7ad-477c-b4c2-9609fd287272`.
- `9418931a-558f-4194-916c-3fa5dbff9ec3`.

Each followed full tests, production build, local smoke, deployment preflight, and packaging. Counts progressed from 1,228 to 1,229 tests in 69 files. Recording was skipped. `npm run typecheck` preceded the first 4 deployments. The last prefetch-delay edit was typechecked after deployment.

`Server-Timing` showed about 0 ms inside the Durable Object. Network travel to it took about 50 ms or 500 ms by data center.

Example copies used the visitor's continent for placement. Visitors without sessions read regional, hourly copies through Cache API and ETags. First writes created sessions. A signed cookie retained read-only access after the daily cap.

Cached reads fell from about 420–610 ms to 5–60 ms. Tree and README loaded alongside state. Markdown loaded early. Other prefetching waited 2.5 s after page settlement.

Example Code LCP fell from about 3.6 s to 1.6–2.1 s. Pull request #23 fell from 5.1 s to 1.2–2.5 s.

## First reads start with the page

Date: 2026-10-12. Deployed version: `5899e8c2-1033-4356-8820-249119bc4be6`.

Recorded gates passed:

- `npm run typecheck`.
- 1,228 tests in 69 files. Recording skipped.
- Production build.
- Local smoke.
- Deployment preflight.
- Source packaging.

Asynchronous `public/boot.js` started account reads and example state before application code. React reused them without extra first-view requests. Production's first data request started 148 ms after HTML, down from about 650 ms.

Empty pull request pages offered setup prompts to authorized users. Phone import bars kept source and timer on one line.

## Git protocol v2 through Braid

Date: 2026-10-12. Deployed version: `b0145117-5e15-4471-9d01-e79a65ee6f9c`.

Recorded gates passed:

- `npm run typecheck`.
- 1,226 tests in 69 files. Recording skipped.
- Production build.
- Local smoke.
- Deployment preflight.
- Source packaging.

One timing-sensitive CLI check failed under full-suite load. It passed alone and on rerun.

Fetches passed through Artifacts protocol-v2 capabilities. `ls-refs` exposed branches and `refs/notes/braid`, excluding `refs/braid/*`. Fetch packs streamed back. Pushes retained protocol v1.

The public 140 MB repository cloned shallowly within 1 min over v2 without internal refs. A full clone completed in 240 s. It included 30 branches and complete history, occupying 268 MB.

<a id="a-stopped-import-restarts-and-a-real-import-in-production"></a>
## Release 5bc07907

Date: 2026-10-12. Deployed version: `5bc07907-6e92-45a1-9bd2-e1bb98330a40`.

Recorded gates passed:

- `npm run typecheck`.
- 1,225 tests in 69 files. Recording skipped.
- Production build.
- Local smoke.
- Deployment preflight.
- Source packaging.

Try again initially omitted JSON and an idempotency key. The Worker returned “Send a JSON request.” The fix supplied both. Selecting the same source also restarted stopped imports.

The 140 MB GitHub repository reopened on `stable` after retry. All 30 branches appeared about 3 min later. The public clone advertisement listed all heads.

Clone observations before protocol-v2 forwarding:

- Full clone through Braid v1 failed after 249 s.
- Shallow v1 clone failed during negotiation. Artifacts returned bare NAK instead of the shallow list.
- A direct Artifacts v2 clone ended early after 343 s.
- A small Artifacts repository cloned with full history and with shallow history in about 2 s.

The [v2 record](#git-protocol-v2-through-braid) gives the subsequent results.

## The example past its cap, and clone addresses

Date: 2026-10-12. Deployed version: `d44eafa6-a6cb-4004-ba4e-b0679555a8a9`.

Recorded gates passed:

- `npm run typecheck`.
- 1,223 tests in 68 files. Recording skipped.
- Deployment preflight.
- Production build.
- Local smoke on fresh development state.
- Source packaging.

Networks over the then-current 12-session daily limit received a read-only example. Production Code, Blame, Pull requests, and Agents loaded on desktop and phone without failed requests or console errors. Replay task stayed disabled. Writes returned a reason.

Public clone addresses used `/<owner>/<repo>.git`. Private and unknown addresses returned 404. Token-based private access retained `/git/<id>.git`. Local tests cloned through the Worker. Production routing reached the Git handler.

The first development smoke attempt failed after exhausting example sessions. Fresh-state smoke passed. Version `7add0730` had deployed despite that failure, with the same code except clone-address routing.

## Streamed imports, every branch, less text

Date: 2026-10-12. Deployed version: `d439e231-8b62-488e-8711-e93ab82566cc`.

Recorded gates passed:

- `npm run typecheck`.
- 1,221 tests in 68 files. Recording skipped.
- Deployment preflight.
- Production build.
- Local smoke.
- Source packaging.

Artifacts reported `main` for a source whose only copied branch was `stable`. Braid waited until its 15 min timeout, although copying took 17 s. The fix used the branch named by copied `HEAD`. State reads recovered pending imports.

A 140 MB Artifacts import answered after 16.5 s. Braid's request returned within 1.5 s and used GitHub preview files. Through a development account mock, files appeared about 0.1 s after the click.

A scratch `octocat/Hello-World` import retained only `master`. Against real GitHub and Artifacts, the 140 MB repository's other 29 branches copied in 160 s from a laptop. None were refused. Scratch repositories were deleted.

Production example smoke passed. Landing, Explore, sign-in, and `/new` loaded signed out at desktop and phone sizes without console errors. Later example pages returned 429 after this network used 12 daily sessions.

Limits:

- Production streamed import and branch copying were not checked in this release.
- Those actions required a signed-in owner.

## New repository, background import and redesigned settings

Date: 2026-10-12. Deployed version: `bc66abff-e7cf-4186-b4fb-295cb8fee27e`.

Recorded gates passed:

- `npm run typecheck`.
- 1,213 tests in 67 files. Recording skipped.
- Deployment preflight.
- Production build.
- Local smoke.
- Source packaging.

Pending imports returned 202. Alarms polled every 2–5 s for up to 15 min. Stopped imports offered retry.

Development account fixtures followed an import from start to completion. New repository, Add code, Settings, Agents, and dashboard loaded at desktop and phone sizes without console errors.

Production example smoke passed. Landing, Explore, sign-in, `/new`, Code, Blame, Pull requests, and Agents loaded signed out without console errors or failed requests. `/new` redirected to sign-in.

Limit: no production background import with a signed-in owner.

## Public repositories and the landing page

Date: 2026-10-12. Deployed version: `b6bd4173-2ee0-49d2-98c0-d5f723276485`.

Recorded gates passed:

- `npm run typecheck`.
- 1,177 tests in 64 files. 1 recording test skipped.
- Deployment preflight.
- Production build.
- Local smoke.
- Source packaging.

Public repositories opened anonymously at `/:owner/:repo` and appeared in `/explore`. Four independent review rounds found and fixed:

- Detected secrets still returned to nonmembers.
- Emails in Braid-authored metadata.
- An email-to-public-ID lookup leak.
- Unbounded anonymous load and hostile regular expressions.
- Claimable reserved slugs.

The review ended with approval to ship. Limits were 300 requests/min per network, including 60 expensive reads. Permitted Git content remained verbatim. Existing repositories stayed private unless import evidence proved a public source.

Production example smoke passed. Landing, Explore, Code, Blame, and Pull requests loaded signed out on desktop and phone without console errors or failed requests.

Limits:

- No production public-repository creation.
- No anonymous production clone.
- No production load test.

## Agent provenance

Date: 2026-10-10. Deployed version: `ab319eaa-ad22-4f6e-80df-dc7df86bd262`.

The source passed `npm run typecheck`, 744 tests in 54 files, production `cf build`, and deployment preflight. Recording required `BRAID_RECORD=1` and otherwise stayed skipped.

Deployed example results:

- Smoke passed.
- `src/delivery.ts` blame returned model and owner ranges.
- The fleet listed 7 agents.
- Agent filters returned their pull requests.
- Pull request proof showed model and owner.
- Pages had no console errors.
- Signed-out sign-in logged 3 expected 401s before example selection.
- An unauthenticated `/git/<workspace>.git` clone returned 401.

A real Git client tested `git push braid HEAD:refs/for/main` against the local test server. Artifacts pushes and GitHub note forwarding remained untested.

The typed CLI passed its own checks. Its intended package name was `braid-git`. This did not establish npm publication. `braid blame` attributed 741 real-repository lines: 461 human, 275 PostHog AI, and 5 Cursor.

## Load time, validation and queue delivery

Date: 2026-10-08. Deployed with `cf` as `a18bf43e-4202-48a1-ad0a-01aaabbbd09d`.

Recorded gates passed:

- `npm run typecheck`.
- 570 tests in 37 files. Recording skipped without `BRAID_RECORD=1`.
- Production `cf build`.
- Local API smoke.
- Deployment preflight.
- Production example smoke.

Every example route loaded on desktop and phone without console errors or failed requests.

| Asset | Before | After |
| --- | --- | --- |
| First JavaScript | 1,093 KB. 315 KB gzip | 525 KB shell. 160 KB gzip |
| First-paint CSS | 213 KB | 129 KB |
| Fonts | 139 KB | 34 KB |
| Worker startup bundle | 2,713 KB | 626 KB |

Screens loaded separately. `@pierre/diffs` and Shiki loaded only for code views. Highlighting used workers and JavaScript regular expressions. Git writes, passkeys, and recording data loaded on first use.

A production preview used 4× CPU throttling and Fast 4G. Uncompressed first contentful paint fell from 3.8 s to 2.2 s on measured routes. A Brotli proxy produced 1.1 s. Static assets bypassed the Worker. Hashed assets cached for 1 year.

Valibot parsed external inputs. Queue and shard outboxes retained messages until delivery. Tests dropped the first RPC and verified retry.

Revision comparison used `since` and `compare`. Every recorded pull request, including simulated work, had diffs. The example included a revision after failed checks. Preview routes showed no console errors or failed API calls.

Markdown used a lazy renderer. It rejected raw HTML and unsafe link targets. Tests kept unresolvable links as text.

## Thousands of simulated agents on a deployed Worker

Date: 2026-10-07. Place: isolated owner-key Worker `braid-scale-20261007` with its own Artifacts namespace.

Three consecutive runs used one repository with merging enabled. Each simulated agent added a handler to shared JSON, route, and changelog files. Edits were synthetic. Reviews came from the simulated reviewer. No repository checks were configured.

The deployed store, policy, merge engine, queue, Git builder, and compare-and-swap pushes processed the work.

| Agents | All merged after | Resubmitted after conflict or review | Returned by queue |
| --- | --- | --- | --- |
| 100 | 21 s | 5 | 0 |
| 500 | 113 s | 11 | 0 |
| 2,000 | 524 s | 57 | 0 |

Including setup, 2,701 pull requests merged in 50 batches. File merge methods:

- Fast-forward: 2,016.
- Key-level JSON: 1,997.
- Three-way line merge: 1,487.
- Combined list entries: 3,905.

All pull requests merged without owner decisions. These runs measured coordination and publication without repository verification. Configured checks add waiting time and failure-based batch limits. Evidence remains in ignored `.cloudflare/scale-live-*.json` files.

## Full repository access and hosted sandboxes

Date not recorded. Locations: local checkout, sandbox image, isolated Cloudflare validation Worker, and production.

The source passed 451 tests in 20 files, `npm run typecheck`, Cloudflare build, and local example API smoke.

Endpoint regressions covered:

- 450 binary entries across pages.
- Hidden paths.
- Exact binary downloads.
- Oversized-file metadata.
- Symlinks and submodules without traversal.

GitHub and Artifacts shared the ExamCooker root tree at `0b61f387c04a2154978f6945fc390ab58aecfbdf`. It contained 738 files, including 1 symlink, plus 1 submodule. The prior 60-file display came from a bounded text reader. Tree browsing and hosted execution switched to complete repository access.

A local sandbox-image check cloned that commit and compared every file with Git. It verified 47,157,396 bytes, 1 symlink, and 1 submodule pointer. Collection returned only a disposable verification file.

The isolated Worker completed `mission-d4578285-0635-4a54-87e5-2c17fa731479` through Workers AI and the native container API. It verified UID/GID 1000 without Linux capabilities. It ran a Node assertion and `git diff --check`.

The Worker published `a076ce5962773249ff7da6c0c86944ce1094000c` to Artifacts. The immutable diff matched the expected one-file edit. No merge ran.

The first live attempt exposed a numeric-user requirement. The fix used `setpriv` to remove capabilities. All 451 tests passed afterward. Private GitHub import still required provider verification.

A signed GitHub API request verified the production read-only App identity and permissions. Contents and Metadata were read-only. It had no event subscriptions. The temporary registration relay was removed. Credentials remained in private production configuration.

Browser checks covered the tree, graph selection, and two-version comparison at 390 px and 1280 px. No horizontal overflow occurred. Graph connections remained visible.

The source archive contained 154 files. It passed a scan against configured secret values. Private configuration and runtime state were excluded.

Production deployed with signup open. Example smoke passed. Signed-in ExamCooker showed its complete root, including lockfiles, omitted directories, and the symlink.

Limits:

- GitHub App authorization, installation, and private import still needed live verification.
- Browser automation stopped responding on setup.

## Connected coordinator and same-task revisions

Date not recorded. Locations: local tests, live Artifacts probe, and development browser.

The source passed 386 tests in 15 files, `npm run typecheck`, and Cloudflare production build. Tasks defaulted to one connected Codex or Claude coordinator with one start command. Repository-scoped approval was reusable. The task showed its result first, with expandable checks, context, and activity.

The CLI/Workspace regression used temporary Git repositories. It covered start, committed submission, revision, newer-main fetch, renewal, local merge, resubmission, and final decision history. Network and Artifacts publication used controlled adapters.

The 138 CLI checks also covered separate credentials, legacy receipts, exact pending retries, consistent collection, and file preservation during update.

Storage and publication regressions covered:

- Chunked diffs and immutable streamed exports.
- Deletion and executable modes.
- Stale previews and lost push responses.
- Expired claims during updated-base publication.
- Fingerprint migration recovery for an already-merged commit.
- Invalid paths, special entries, and metadata limits.
- Preservation of an unrelated 12 MB binary without history transfer.

A live Artifacts probe created a temporary repository. It published a proposal, then replaced it with a sibling commit using the exact old head. Artifacts accepted the revision and returned its head. The temporary repository was deleted.

Limits:

- The probe did not cover production browser approval or a complete account workflow.
- Development page load succeeded, but snapshot and viewport automation timed out.
- Desktop and phone visuals were not verified.
- Main client chunk: about 966 KB, 285 KB gzip, with a bundle warning.

## Large-repository publishing

Date not recorded. Locations: local Git fixtures, reported user checkout, and production browser.

The import failure came from shallow cloning all current blobs before a small write. Publishing switched to commit/tree reads and new-object transfer. The 8 MB whole-repository transfer cap was removed. `worker/git/push.ts` retained separate content, response, and metadata bounds.

All 288 tests in 14 files and `npm run typecheck` passed. A native smart-HTTP regression included a 12 MB random binary. Publication transferred under 10 KB without upload-pack. It preserved binary content, executable mode, symlink, and submodule references. `git fsck` passed.

Other regressions covered stale and raced heads, interrupted authorization, oversized patches, incomplete acknowledgments, and exact prepared-commit recovery.

Context checks covered relevant files beyond early-directory limits, nested agent scope, full-file bounds, and pinned commits. Hosted regeneration received complete originals after unseen replacements. Oversized, binary, or unavailable originals blocked publication. Scope checks persisted. Review diffs retained actual base content.

These checks used native Git and controlled Artifacts/model adapters. They did not prove production Artifacts compatibility or a new hosted-task success.

`npm run build`, local example smoke, and production preflight passed. Signup remained enabled under existing approval.

The production browser showed **Improve ZIP downloading** with one checked-out agent and two waiting agents. The checked-out agent had encountered the old limit. The deployed CLI could retry its saved submission with `submit --retry`. Failed hosted tasks did not restart automatically.

The user's run also found rejection of unchanged symlinks and submodules. The corrected collector compared base, index, and filesystem before skipping unchanged entries.

Regression cases rejected:

- Modified, staged, deleted, or assume-unchanged symlinks.
- Changed submodule commits.
- Dirty or untracked submodule contents.
- Symlinked submodule directories.

Clean initialized submodules and empty uninitialized directories passed. Read-only collection matched the user's saved 4-file, 20,020-byte proposal.

## Local and Cloudflare agent release

Date not recorded. Deployed version: `6f6005ab-710d-498a-b0d5-27f9f93f857a`, with signup open.

The release offered 1–3 local agents or 3 Workers AI agents. Local work used the downloadable Node CLI for approval, pinned checkout, retry, and renewal. Labels distinguished waiting agents, local execution, and reported checks. Both execution modes shared review and merge conditions.

Production results:

- Example smoke passed conditional reads, merge conditions, and saved context.
- Health, account configuration, and 4 setup guides answered successfully.
- Downloaded CLI and source archive matched local verified files.
- Anonymous state, export, passkey, checkout, submission, and cancellation requests returned 401.
- The example overview retained its labels without horizontal overflow at 1280 px.

`npm run typecheck` and 263 tests in 13 files passed. Git tests used a real local HTTP server. The first rerun could not bind in the sandbox. The complete suite passed after loopback networking was enabled.

Local-agent checks covered scopes, expired/revoked connections, cancellation, exact retries, lost responses, UTF-8 paths/content, escaped request sizes, failed reports, and stale-main protection. CLI checks used temporary Git repositories and mocked HTTP. They did not verify a live HTTPS Artifacts checkout.

A hosted failure exposed unsupported `redirect: 'error'` behavior. The fix used manual redirects and refused redirected responses before forwarding credentials. A regression covered it. Failures retained safe stages: authorization, fork, generation, validation, or publication.

This fixed the identified publication issue. It did not establish every prior failure's cause or a new hosted-model success.

Cloudflare build and local example smoke passed. Smoke used isolated state after earlier runs exhausted the initial session allowance. Browser fixtures verified execution choices, agent count, and setup controls without live writes.

Limits:

- Complete production local checkout/submission remained unchecked.
- A fresh hosted task still required live verification.

## Public account release validation and rollout

Date not recorded. Locations: local tests and Chromium, production, and the shared browser.

The initial account release passed `npm run typecheck` and 46 tests. Local HTTP smoke, default Cloudflare build, and public-account build passed.

Tests covered access separation, member removal, revoked sessions/connections, passkey signatures, email replay, idempotency, workflow/import recovery, and lost pushes. Conditional reads invalidated cached snapshots after permission, identity, or capability changes.

Smoke covered strong, weak, list, and wildcard validators. It verified empty 304 responses and full responses for stale validators. Weak comparison handled Cloudflare-weakened ETags.

Chromium checks at 1440 px and 390 px completed example selection, required reason, merge review, and confirmation. Compatibility mission routes redirected to tasks. Phone overview had no horizontal overflow. Idle state returned 304 about every 8 s.

Local account fixtures covered sign-in, code entry, menus, read-only controls, shortcuts, disabled context editing, settings, and agent approval. A Kumo group-label placement initially crashed the account menu. The corrected menu opened. The read-only badge left space for the phone repository selector.

The owner-compatible deployment preceded the account switch. Its private backup contained `relay-webhooks`, 4 tasks, 13 files, and 2 task inputs. Main was `26daa5b52a00abe1db174fd8a461fae8cda44bae`. The backup SHA-256 matched export evidence. Backup and both production configuration files remained ignored and owner-readable only.

Public accounts deployed through `cf` as `4bf2f9de-10e1-49a9-b40e-b86c85e43f46`. Signup opened at the owner's request. Production `/api/account` confirmed `provider: github`, `signupEnabled: true`, and 3 sign-in methods.

Production example smoke passed compressed ETags, merge conditions, exact composition, handoff, and origin checks. Anonymous live state, exports, passkey lists, and team creation returned 401. GitHub redirects included PKCE and the correct callback. Passkey challenges used the production hostname and required user verification. All 3 agent setup guides were available.

A real callback supplied `iss=https://github.com/login/oauth`. Braid expected `https://github.com`. Workers logs located the request. A matching callback reproduced failure. The corrected issuer deployed without bypassing validation.

New checks covered callback completion, PKCE, secure session, one-time state, logout revocation, and rejection of untrusted issuers before token exchange. Invalid callbacks returned safe 400 responses. The owner then reached a public-team repository and launched a live task.

Approved production email reached its recipient. The first challenge expired. A fresh code completed shared-browser sign-in. The owner created a team.

Limits:

- Browser passkey flow remained unverified.
- Public invitations remained unverified.
- Complete live task success in a public team remained unverified.
- See [production rollout](PRODUCTION.md) for provider checks and backup limits.

The client chunk measured about 954 KB, 282 KB gzip, with a bundle warning. The source archive contained 129 files. Scans checked it against actual configured secrets. Private configuration, credentials, and runtime state were excluded.

A synthetic private-key fixture moved to runtime construction to avoid archive scanning. All 68 CLI checks still passed afterward.

## Earlier deployed prototype

The deployed [Braid](https://braid-git.acmvit.workers.dev) example was labelled recorded. The following live evidence used the owner repository, Workers AI, and Artifacts.

## Live parallel run

Date: 2026-10-06. Task: `mission-da5ebeeb`, **Protect webhook delivery**.

All 3 agents started at `2026-10-06T07:35:47.997Z`. Each forked base `59e35a6d7f1ef39d45feb0fd59909aa00c4a3cbe`. They ran Cloudflare-hosted `@cf/zai-org/glm-5.3-flash` with high reasoning effort.

| Recorded agent | Artifacts repository | Commit | Finish, UTC |
| --- | --- | --- | --- |
| Atlas | `relay-webhooks-da5ebeeb-atlas` | `833e8ca3296ff2912f9a103e451946b0937dacb6` | 07:37:23.948 |
| Sable | `relay-webhooks-da5ebeeb-sable` | `0b56b64673f304f8a1fed4dd92b3b77d36c2ae0a` | 07:36:35.801 |
| Reed | `relay-webhooks-da5ebeeb-reed` | `93f7c86d71de70558bc866de56f2e999bfab2b7c` | 07:36:33.408 |

Atlas and Sable edited `src/delivery.ts` independently. Merge before selection returned 409. Selecting Sable with a written reason enabled integration. Independent documentation and the receiver example remained.

Main became `26daa5b52a00abe1db174fd8a461fae8cda44bae`. Reading `.braid/missions/mission-da5ebeeb/decision.json` from Artifacts at that commit verified all 3 source commits and the selected version.

## Validation

Prototype validation date not recorded. Locations: development, local HTTP Git server, and Chrome.

TypeScript and production build passed. The 24 automated checks covered proposal validation, authentication, paths, overlaps, merge conditions, exact composition, fingerprint changes, context, and real local Git publication.

Local HTTP smoke passed persistence, blocked merges, decisions, changed-preview refusal, decision history, handoff, concurrent replay, and origin checks. Adding context after merge preserved the historical fingerprint.

Chrome checks covered 1512 px, 1440 px, 1280 px, and 390 px. They exercised selection, required reasons, combined diffs, confirmation, changed-preview 409, ledger, context, task launch, command menu, and keyboard controls. Phone pages had no horizontal overflow.

Agents, Review, and Merge retained header coordinates. A 16-step desktop flow measured CLS 0.0004. The phone flow measured 0. These were development measurements.

The selected integration separately passed TypeScript and mocked-fetch checks:

- HMAC and UTF-8 signing.
- Stable idempotency.
- Immediate 401 return.
- 429, 503, and network retries.
- A 3-attempt limit.
- HTTPS and empty-input validation.
- Receiver tamper rejection.

No outbound webhook was sent. These candidate checks ran outside deployed agents. The prototype still reported agent runtime checks as unexecuted. It did not execute arbitrary project checks inside the orchestration Worker.

The recorded review identified one sample discrepancy. `docs/delivery.md` said invalid input throws. The selected library returned a structured failure. The sample demonstrated review and Git integration, not production webhook delivery.

## Reproduce

1. Follow setup in [README](../README.md).
2. Run the live check against an isolated owner-key Worker.

   ```sh
   node scripts/live-check.mjs https://your-validation-worker.workers.dev --secrets-file path/to/private-validation-secrets
   ```

The check creates a disposable sample and runs one small hosted task. It requires observed passing checks and an Artifacts proposal commit. Evidence goes under ignored `.cloudflare/`. It stops before merge.

## Recorded tools and build

Tool date: 2026-10-08. The recorded npm release was `cf 1.0.0-beta.13`. This records that run, not a version requirement.

Claude Fable 5.1 at max effort contributed the initial design and frontend. Claude Opus 5.5 at max effort rebuilt the UI with Cloudflare Kumo 2.14.0. The prototype used Cloudflare for hosting, state, orchestration, model inference, and Git storage.

The earlier build's client chunk measured about 822 KB, 248 KB gzip. Syntax grammars and themes loaded lazily. Existing integration records did not gain `handoff.md` files retroactively. Preview handoffs remained available to copy or download.
