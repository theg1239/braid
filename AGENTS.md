# Braid

An agent-native Git workspace on Cloudflare. Use the latest `cf` CLI. Do not run Wrangler or add a Wrangler configuration.

- `src/`: React UI. `shared/types.ts`: public data contract. `shared/merge/` and `shared/policy.ts`: the merge engine and policy evaluation. `shared/questions.ts`: how a change asks a person, and policy in sentences.
- `worker/`: Worker API, Durable Object state, Workflows, Workers AI, Artifacts and Git, one folder per domain (`docs/ARCHITECTURE.md`, Code layout). `worker/changes/`: change store, landing queue, path index and simulated agents. Map failures through `worker/errors.ts`: `HttpError` for Braid's refusals, typed platform codes such as `ArtifactsError.code`, never matching on message text. Parse everything Braid receives (request bodies, webhooks, GitHub answers, model output) with Valibot where it arrives (`worker/schemas.ts`), then trust the types instead of guarding again.
- Use `npm run dev`, `npm run build`, `npm run typecheck`, `npm test`.
- Run `node scripts/smoke.mjs` against the development server for the API workflow.
- Keep sample replay visibly distinct from live agent execution. Never claim tests ran unless they actually did.
- All live repo writes require owner authorization; the landing queue rechecks the owner who enabled it before every push. Do not return Artifacts tokens in workspace snapshots.
- Every landing composes on the current trunk and pushes with compare-and-swap: a moved trunk means composing again, never overwriting, and unresolved conflicts never land. Main has one writer: with landing on, task results and reverts enter the queue as changes. Tasks preserve context in `.braid/missions/`; landed commits are authored by the agent's owner, keep the change's message untouched (Braid adds nothing to it), and carry their provenance in a `refs/notes/braid` note (`docs/PROVENANCE.md`).
- Integrate existing review, CI, security and GitHub tooling rather than rebuilding it. Braid owns coordination, reconciliation, verification of the combined result and policy.
- The tour carries one Recorded label on every page instead of per-item Simulated or Scripted tags: its edits are synthetic while review, policy, merging and landing are real. Simulated load from the queue simulator stays out of the fleet.
- UI fonts are served locally. Keep the application runtime entirely on Cloudflare.
- Use Cloudflare Kumo components with the dark theme, and let clear controls carry the workflow instead of explanatory paragraphs. Keep prose natural and connected without clipped slogans or sequences of sentence fragments.
- `docs/DESIGN.md` opens with the current product model and the rules every screen must pass; check new UI against them and prefer removing over adding. Its historical section is exploration, not a claim of implemented features. Review `docs/FRONTEND-CONTRACT.md` for routes.
- Keep `.dev.vars`, credentials, `.cloudflare` runtime state, and generated output out of Git and source archives.
