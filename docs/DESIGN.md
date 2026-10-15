# Design

## Current product model

Agents open pull requests. Braid merges them under the owner's rules. Owners request work, set rules, review results, and answer questions that need their approval.

| Term | Meaning |
| --- | --- |
| Pull request | A proposed edit, called a `change` in the API. Its displayed state is Open, Merged, or Closed. |
| Task | Work requested from agents, called a `mission` in the API. With the merge queue enabled, its result becomes a pull request. |
| Rules | The policy in `.braid/policy.json`. It sets path permissions, review requirements, and required checks. |
| Merge queue | The service that combines approved pull requests with main, runs configured checks, and merges in order. |
| Review required | A question in the merge box. It gives one reason and up to 3 actions from `shared/questions.ts`. |
| Proof | Screenshots and command results attached to a pull request. Each result identifies where it ran. Agent reports remain unverified. |
| Instructions | Agent rules in `.braid/instructions.json` and the managed section of `AGENTS.md`. Owners edit them through pull requests. |
| Agent | A model run by an owner's tool. Display the model and owner, such as “Claude Opus 5.5 for @maya-chen”. |
| Blame | Line attribution in Code. It shows the model or person, owner, age, and confidence. See [provenance](PROVENANCE.md). |
| Fleet | The agent list under Agents. Each row groups a model, owner, and tool. It shows pull request counts and line totals. |

Tasks ask the owner to choose between different versions of a file. Failed checks block merging. Blocked instruction strings send pull requests back by default. Request changes can create an instruction.

With the merge queue disabled, tasks can merge through direct integration. The [architecture](ARCHITECTURE.md#integration) defines its review and expected-head checks.

## Rules every screen must pass

1. Use GitHub's structure and words where an equivalent exists.
2. Use at most 1 primary button per view.
3. Do not repeat a sentence on the same page.
4. Show review counts on Pull requests and a notice on Code.
5. Give each question one reason and at most 3 actions.
6. Name the effect of each action.
7. Keep merge strategies and internal state names out of primary views and filters.
8. Offer Revert on merged pull requests. Explain why it is disabled when unavailable.
9. Show where evidence ran. Label agent reports as unverified.
10. Show one **Recorded** label on every tour page. Omit per-item **Simulated** and **Scripted** tags. Keep queue simulator load out of the fleet.
11. Use labels, badges, and short rows. Put full reasons on detail pages.
12. Identify agents by model and owner. Do not invent names, avatars, monograms, or sparkle icons.
13. Use dark Cloudflare Kumo components and local fonts.
14. Prefer removing a control or sentence over adding one.

## Interface

Repository addresses use `/:owner/:repo`. Public repositories allow reading without sign-in. Disabled write controls explain the required access.

Repository tabs are Code, Pull requests, Agents, and Settings. Pull requests use Conversation, Guide, Checks, Files changed, and a merge box. Settings uses GitHub's sidebar groups. Each settings row has a label, a short hint, and a value or control.

Code offers Preview for Markdown, Code, and Blame. A blame card shows the commit, tool, session, pull request, task, and confidence. Inferred attribution has a visible label. The task page retains the agent branch graph.

Signed out, `/` is the landing page. Each part plays when it comes into view:

- The header sits on the sky at the top. Once the page scrolls, it gathers into a floating capsule in the middle.
- The claim and the Copy prompt pill. The pill copies a prompt that sets up a coding agent from `/setup.md`.
- A working copy of Braid over the tour's recording, with the Code, Pull requests, Agents and Settings tabs:
  - Code opens every file on main with blame. Each run of lines opens its commit's card.
  - Pull requests opens each pull request with its proof, checks and reviews, and the merge queue.
  - Agents shows the fleet of named agents and the sample task, with its agent graph and two versions to choose from.
  - Settings states the rules in the words of Settings › Rules.
- Four moments. Each has one line over one picture:
  1. `braid blame` on a GitHub clone, for blame by model and owner.
  2. The merge queue as a braid, beside the 100-agent comparison and a link to its method.
  3. The evidence of #23: its screenshots in a browser frame and a phone frame. Each command then checks off on the pull request's strand into main.
  4. Two agents' strands meet at `src/limits.ts` and part into two editor panes. The owner chooses one, and its strand runs into main.
- The three ways in, then one line each for mirrors, the CLI, hosted agents and `refs/notes/braid`.
- The close: every merged pull request of the tour drawn into one main, then "One main." and the pill.

The two drawn moments sit on a stage centred on the page, so their main meets the line the background draws. The working copy keeps one size, so changing a view never moves the page. Its views load when the browser is idle. `scripts/landing-data.mjs` writes every row from the recording, the sample task and the app's own wording. It also crops #23's screenshots to their content.

Each figure from the recording shows one Recorded label. The page has no Scripted or Simulated tags. The sample task records no choice, so the fourth moment shows the owner's choice as the next step. With reduced motion, each part shows in its final state. The background artwork stays behind the page and keys to each part's `data-breath` attribute. The page has no sparkles, invented metrics or testimonials.

The signed-in home page shows review needs and recent merges across repositories. It also lists personal and organization repositories. Explore lists public repositories. The recorded example uses `/example/relay` and one banner.

The [frontend contract](FRONTEND-CONTRACT.md) defines routes, controls, and fields. [README](../README.md) gives setup instructions. [Verification](VERIFICATION.md) records checks and measurements.

## Design evidence

- [Parasuraman et al.](https://doi.org/10.1109/3468.844354) describes levels of automation. [Stripe Radar](https://docs.stripe.com/radar/reviews) and [Graphite inbox](https://graphite.com/docs/use-pr-inbox) provide review workflow examples.
- [ParallelPilot](https://arxiv.org/abs/2609.33113) reports 63% more completed tickets in a study of 16 participants doing short coding tasks. This is not a Braid result.
- [Amershi et al.](https://doi.org/10.1145/3290605.3300233) supports correction, explanations, and global controls. These inform Revert, review questions, and the merge pause.

## Original exploration (historical)

This section preserves design exploration. It is not an implemented feature list or the current product specification.

The proposal uses one Artifacts fork per agent and a graph of branches that join main. It proposes these features:

- A planner that assigns work and file claims.
- Candidate implementations with a separate reviewer.
- Push subscriptions and a WebSocket per task.
- Drag controls for merge order and choices within diff regions.
- A separate Git repository for decisions and agent context.
- Automatic deployment through Workers Builds.

The proposed graph uses event order on its horizontal axis. It shows overlap bands between branches and caps visible branches at 12. The proposed screens include task lists, a task graph, agent details, an overlap inspector, a decision ledger, and a repository browser.

The proposed palette uses a light background, mineral colors, and orange action controls. Archivo and Fragment Mono supply the type. The proposed implementation uses React, Vite, TypeScript, Tailwind, Radix, Motion, SVG, and React Router. These choices do not define the current dark Kumo interface.

The proposed demonstration follows an import, parallel work, a version choice, integration, and a cloneable decision record. A recorded replay requires a visible label. A live demonstration requires separate evidence.

Exploration sources:

- [Cloudflare competition brief](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
- [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)
- [Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)
- [Artifacts changelog](https://developers.cloudflare.com/artifacts/platform/changelog/)
