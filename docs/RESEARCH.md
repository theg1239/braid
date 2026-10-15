# Research

Research dates: 2026-10-06 and 2026-10-07.

The sources include engineering reports, papers, product documentation, and attributed user reports. They do not provide customer-interview validation for Braid. Product hypotheses below require measurement.

## Coordination

Braid coordinates work on shared code. Isolated edits still need a review of their combined behavior.

| Problem | Evidence | Design implication |
| --- | --- | --- |
| Duplicate work and stale assumptions | [Cursor](https://cursor.com/blog/scaling-agents) describes contention around shared file locks. Its system uses separate planner and worker roles. This is one team's report. | Give agents clear roles and a fixed starting context. Show overlapping work without a global edit lock. |
| Incompatible independent edits | [CooperBench](https://arxiv.org/abs/2601.13295) evaluates over 600 paired tasks across 12 libraries. Tested agents have lower success rates together. Communication errors and broken commitments contribute. | Review the combined result. A clean text merge does not prove compatible behavior. |
| Text conflicts | [AgenticFlict](https://arxiv.org/abs/2604.03551) reports conflicts in 27.67% of over 107,000 processed pull requests. This rate describes that dataset. | Preserve alternatives. Distinguish identical edits from conflicts. Check the expected main commit before pushing. |
| Rejected work | A [study of 33,596 pull requests](https://arxiv.org/html/2601.15195v1) associates non-merge outcomes with larger edits and failed CI. Annotated rejections include abandonment, duplicates, and unwanted features. It does not establish that agents cause reviewer overload. | Keep the requested outcome beside the work. Put required decisions first. Count only selected edits in integration totals. |
| Unsupported completion claims | A [GitHub Community report](https://github.com/orgs/community/discussions/189621) describes an agent reporting fixes while conflicts and checks remain unresolved. This individual report does not establish a platform-wide defect. | Distinguish observed results, agent reports, and recorded examples. A patch-format check is not a runtime check. |
| Lost context | [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) uses progress files and Git history across sessions. [GitHub](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) verifies memory citations against code. | Preserve the task's starting context, source commits, choices, reasons, and check limits. Mark missing context as unavailable. |
| Unwanted contributions | A [maintainer interview](https://github.blog/open-source/maintainers/your-contributors-are-ai-first-now-is-your-project/) discusses agent pull request queues, repository instructions, and contribution boundaries. | Focus on requested work. Do not treat generated lines or agent counts as measures of value. |

## Existing tools

[Git worktrees](https://git-scm.com/docs/git-worktree) provide separate checkouts with branch safeguards. Braid uses Artifacts forks for remote repository isolation.

GitHub provides an [Agents tab](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/) with session history and diffs. Its [branch workflow](https://github.blog/changelog/2026-04-01-research-plan-and-code-with-copilot-cloud-agent/) can start work without a pull request. Its [memory system](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) preserves context across agents.

Braid's product hypothesis concerns the combined workflow:

- Compare several results for one task.
- Select a version for each conflicting file.
- Review the exact combined edit and its evidence.
- Preserve choices and alternatives in Git.

This hypothesis does not establish market exclusivity.

## Product decisions

The [design rules](DESIGN.md) put required decisions first. The [frontend contract](FRONTEND-CONTRACT.md) defines the controls.

The integration preview uses the merge's file-selection rules. Its SHA-256 fingerprint covers the proposed edits, choices, reasons, and fixed task context. Live task merges require this fingerprint. A changed preview returns HTTP 409. The fingerprint is not a Git commit or a CI result.

Integration writes `decision.json` and `handoff.md` under `.braid/missions/<id>/`. These files preserve source commits, selections, alternatives, constraints, and check limits. They contain outcomes and reasons, not private reasoning traces.

Hosted checks record actual command results. Local reports remain unverified. Recorded examples identify checks that did not run. Passing checks on one agent's result do not establish that the combined result works. See [integration](ARCHITECTURE.md#integration).

## Automated merges

The following reports inform policy and queue design. Their figures describe their own systems. Observational results do not prove the same effect in Braid.

| Source | Reported result | Braid mechanism |
| --- | --- | --- |
| Meta [RADAR](https://arxiv.org/abs/2605.30208) and [Diff Risk Score](https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/) | RADAR merges 331,720 of 535,290 reviewed edits. Gates include eligibility, risk scores, LLM review, CI, and a veto delay. Bots need a clean 60-day record and daily caps. The reported revert rate is one-third of other edits. The study identifies observational limits and reduced knowledge sharing. | Versioned policy, path rules, earned autonomy, daily author caps, a veto delay, and recorded approvals. |
| Spotify [background agents](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1) and [developer workflow](https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint) | Verification runs outside agents. Reported failures include disabled tests and dependency downgrades. Spotify describes removing an LLM judge that rejects about one-quarter of edits. | Guards inspect test removals and dependency downgrades. The queue runs configured checks. Agents can push pull requests through Git, but cannot push main directly. |
| [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) | Fixed steps surround agent steps. After at most 2 CI attempts, a person takes over. | Policy limits repeated author-caused failures before owner review. |
| Uber [SubmitQueue](https://arxiv.org/abs/2501.03440) and [uReview](https://www.uber.com/blog/ureview/) | Conflict analysis and speculative checks reduce CI resource use by 53%. Review filters suppress low-value comments. | Adaptive batches, failure isolation, and file-based assignment of review findings. |
| Cursor [scaling report](https://cursor.com/blog/scaling-agents) and [autonomous codebase report](https://cursor.com/blog/self-driving-codebases) | File locks limit throughput. A single integrator becomes a bottleneck. Requiring every commit to pass serializes work. | Agents can continue despite overlaps. The merge queue combines compatible edits and returns conflicts. |
| [Cognition](https://cognition.com/blog/multi-agents-working) and [Anthropic's compiler project](https://www.anthropic.com/engineering/building-c-compiler) | Parallel writers can overwrite work. Separate review agents can help. | Pull requests have a submitting author. Other agents review through the API or GitHub apps. Combined tasks retain file attribution. |
| [GitHub merge queue](https://github.blog/engineering/engineering-principles/how-github-uses-merge-queue-to-ship-hundreds-of-changes-every-day/), Trunk, Aviator, Mergify | Merge queues check the result that will merge and remove conflicting work. | Braid checks combined batches when checks are configured. It isolates failing pull requests. Separate queues by build target remain a proposal. |
| Atlassian [RovoDev](https://arxiv.org/abs/2601.01129) and [Anthropic Code Review](https://claude.com/blog/code-review) | RovoDev reports little benefit from a factuality gate and benefit from an actionability classifier. Anthropic's results are vendor-reported. | Existing review providers connect through GitHub or the reviews API. Workers AI supplies a fallback reviewer. |
| [AgenticFlict](https://arxiv.org/abs/2604.03551) and [merge-outcome study](https://arxiv.org/abs/2605.22534) | Text conflicts, duplicate work, and silent closures limit what merge rates explain. | Queue records distinguish merge methods, returned pull requests, and owner decisions. |

## Limits

- Pull requests contain at most 256 text files and 3 MiB of new content.
- Semantic checks cover only behavior tested by the repository's configured commands.
- Braid does not generate a complete test suite or prove behavioral compatibility.
- The [2,000-agent deployment measurement](VERIFICATION.md#thousands-of-simulated-agents-on-a-deployed-worker) uses synthetic edits without repository checks.
- Those measurements do not establish sustained production costs or reviewer time savings.
- Detecting duplicate or contradictory intentions before editing remains unresolved.
- Reviewer precision needs measurement before stronger blocking authority.
- Maintainer review-time measurements remain uncollected.

## User validation

1. Give maintainers an ordinary branch-based review task.
2. Give them the equivalent Braid integration review.
3. Measure time to find the disagreement.
4. Record incorrect choices.
5. Ask a second reviewer to recover the decision without a chat transcript.

## Competition requirements

The [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) assign 50% to originality and prototype quality. Coordination, context, review, and conflicts receive 25%. Usability receives 25%.

Entry requires a 5–10 minute video, a permitted open-source license, source code, and run instructions. Eligibility is limited to adult legal residents of the US or Canada.

A demonstration can show a shared base, concurrent forks, a disagreement, a written choice, the integration preview, a merge, and a Git handoff. Label recorded playback. Do not present it as live execution.
