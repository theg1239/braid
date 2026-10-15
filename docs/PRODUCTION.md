# Deploy with accounts

Use your own Cloudflare account, hostname, and verified email sender for a deployment with public accounts. Complete the [local setup](../README.md#run-locally) first. The examples below use `https://braid-git.acmvit.workers.dev`; replace it with your deployment origin.

## Sign-in methods

Braid supports three sign-in methods: GitHub, email codes and passkeys.

- A passkey works only on the hostname where the person made it.
- The sender domain of the email must be enabled in Cloudflare Email Service.
- The automated tests use controlled providers and test credentials. They do not prove that the real GitHub application, email delivery or a person's passkey works in production. Do the rollout checks below for that.

This deployment has public signup on (`BRAID_SIGNUP_ENABLED=true`), at the owner's request. For a new deployment, start with signup off and do the rollout checks first.

## Private configuration

Keep `.env.production` and `.dev.vars.production` out of Git and out of the source archive. `.gitignore` already ignores both.

`.env.production` holds the deployment settings:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
BRAID_WORKER_NAME=braid-git
BRAID_AUTH_MODE=github
BRAID_PUBLIC_ORIGIN=https://braid-git.acmvit.workers.dev
BRAID_GITHUB_CLIENT_ID=your-oauth-client-id
BRAID_EMAIL_FROM=braid@your-domain.example
BRAID_ARTIFACTS_NAMESPACE=braid
BRAID_SIGNUP_ENABLED=false
BRAID_DAILY_TASK_LIMIT=20
BRAID_GLOBAL_DAILY_TASK_LIMIT=100
```

The `github` mode turns on public accounts with all three sign-in methods.

1. Register a [GitHub OAuth application](https://github.com/settings/applications/new). Give it the application URL above. Give it the callback `https://braid-git.acmvit.workers.dev/api/auth/github/callback`.
2. Put its `GITHUB_CLIENT_SECRET` in `.dev.vars.production`.
3. Put a random `SESSION_SECRET` of 32 characters or more in `.dev.vars.production`. Keep the same value for all later deployments.

Braid asks GitHub only for the identity and verified email scopes. It discards the provider token after sign-in.

- GitHub's issuer for the authorization response is `https://github.com/login/oauth`, not the root website URL. Keep issuer validation on.
- After a failed callback, start again with **Continue with GitHub**. Do not refresh the callback URL: its browser state is for one use.

> **Caution:** Do not copy the `ADMIN_TOKEN` of an owner-key deployment into `.dev.vars.production`. Never print these secrets or paste them into a chat.

## GitHub App

Repository import, linking and merging use a GitHub App. This App is separate from the sign-in application. Register it for the production origin only.

| Setting | Value |
|---|---|
| Homepage | `https://braid-git.acmvit.workers.dev` |
| Authorization callback | `/api/github/callback` |
| Setup URL | `/api/github/installed` |
| Webhook URL | `/api/github/webhook` |

Give the App these permissions:

- Contents: read and write. Braid pushes merge branches and mirrors main.
- Pull requests: read and write. Braid opens, comments on, closes and merges pull requests.
- Checks: read. Statuses: read. Metadata: read (GitHub adds it).

Subscribe the App to these events: push, pull request, pull request review, check suite, check run and status. Set a random webhook secret. Braid verifies each delivery with HMAC-SHA256 and ignores repeats. It uses a delivery only as a signal to read the current state from GitHub.

### Turn on linking and merging

The App of this deployment was registered as read-only, with webhooks off. To turn on linking and merging, an owner of the App does these steps:

1. Open the App's settings on GitHub.
2. Add the permissions and events above.
3. Turn on the webhook, with the URL above and a new secret.
4. Save the secret as `GITHUB_APP_WEBHOOK_SECRET` in `.dev.vars.production`.
5. Set `BRAID_GITHUB_WEBHOOKS=1` in `.env.production`.

Without webhooks, linking works, and the merge queue polls GitHub. Each installation owner must accept the new permissions on GitHub. Until they do, imports work, and linking reports that access is not available.

### App credentials

- In `.env.production`: `BRAID_GITHUB_APP_ID`, `BRAID_GITHUB_APP_SLUG` and `BRAID_GITHUB_APP_CLIENT_ID`.
- In `.dev.vars.production`: `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET`. The key can contain real newlines or `\n`.
- Do not use these credentials in development or in test deployments.

The helper registers a new App through GitHub's manifest flow. It reads `BRAID_PUBLIC_ORIGIN` from `.env.production`. It saves the credentials and the webhook secret privately.

```sh
node scripts/register-github-app.mjs --redirect-url https://your-setup-host/callback
```

- The registration callback must be public HTTPS, without query parameters. GitHub refuses loopback callbacks.
- The callback must validate the state that GitHub returns. Then it must redirect only to the helper's fixed loopback callback, with the code and the state.
- Use a temporary callback with logging off. Remove it after the registration.
- The helper does not replace an App that exists.

### Linking rules

- To link a repository, a person needs push permission on GitHub. Braid checks this with the person's own token, not with the App installation.
- Before each GitHub write, and before each read through the installation, Braid checks the person's Braid ownership and GitHub permission again. A cached installation token does not skip this check.
- Writes need push access. Reads and import previews need read access.
- If the owner who linked leaves Braid, another owner must link again with their own GitHub connection.
- Pull-request mode needs Braid's main to be the same as GitHub's default branch, or behind it. Mirror mode needs GitHub to be behind Braid, or empty.
- If branch protection stops the App from pushing to the default branch, Braid merges each pull request through the API with a merge commit. To let Braid fast-forward the branch, add the App to the bypass list of the branch rules.

### Checks and reviews on GitHub

Braid merges when the checks that GitHub reports are complete and GitHub allows the merge. GitHub's rules decide which review apps and checks are required.

- A review app that only comments, or that posts after the checks finish, can arrive after a batch merged.
- To make an app's verdict required, require its check in the branch rules or ruleset. Braid then waits for it. A requested change sends the responsible pull request back.
- Cancelled and timed-out runs count as failures. Neutral and skipped results are recorded as warnings.

## Build and deploy

Use the latest `cf` CLI. You do not need a Wrangler configuration.

Start Docker before the build. It builds `sandbox/Dockerfile` for the hosted agents. To use an image that you uploaded before, set `BRAID_SANDBOX_IMAGE=registry.cloudflare.com/ACCOUNT/IMAGE@sha256:DIGEST`. Braid refuses tags and other registries.

Source packaging needs Python 3 and a Git checkout. Skip `node scripts/package-source.mjs` when you use an extracted source ZIP.

```sh
npm run preflight
npm run typecheck
npm test
npm run build
node scripts/smoke.mjs
node scripts/package-source.mjs
npm run deploy:public
```

- `node scripts/smoke.mjs` needs `npm run dev` running on your computer.
- `npm run preflight` checks the syntax and the presence of the settings in both private files. It does not contact the providers, and it does not prove that email works.
- `npm run deploy:public` runs the preflight, loads `.env.production`, and runs `cf deploy --secrets-file .dev.vars.production`.
- `npm run deploy` alone keeps the defaults of an owner-key deployment, unless you set the same variables.

Optional variables:

- `CLOUDFLARE_ACCOUNT_ID`, if you have more than one account.
- `BRAID_WORKER_NAME`.
- `BRAID_REVIEW_MODEL`: the fallback reviewer model. The default is `@cf/zai-org/glm-5.3-flash`. Hosted agents always use `@cf/zai-org/glm-5.3-flash` when no provider key is selected.
- `BRAID_IP_LIMIT_NAMESPACE`, `BRAID_ANONYMOUS_LIMIT_NAMESPACE`, `BRAID_PUBLIC_EXPENSIVE_LIMIT_NAMESPACE` and `BRAID_AGENT_LIMIT_NAMESPACE`, if the default rate-limit IDs are already used in the account.
- `BRAID_ACCESS_TEAM_DOMAIN`, `BRAID_ACCESS_AUD` and `BRAID_ACCESS_OWNER_EMAILS`, for sign-in through Cloudflare Access.
- `BRAID_REMOTE_DEV=1` with `CLOUDFLARE_API_TOKEN`, to use remote bindings in development.

## Rollout checks

Do these checks with signup off:

1. Open `/api/account`. It lists the sign-in methods that you configured.
2. Select **Continue with GitHub**. GitHub redirects to the registered callback.
3. Ask for an email code for a test recipient. Make sure that the code arrives.
4. Sign in with GitHub and with email for the same verified address. Both give the same Braid account.
5. Sign out. The old cookie no longer works.

Then turn signup on, deploy again and do these checks:

1. Create the first organization.
2. Register a passkey in the browser. Sign out, then sign in with the passkey on the same domain.
3. Create a repository. Invite a second verified account. Make sure that a member cannot create tasks, select versions or merge.
4. Remove the member. The next request of that member to the repository fails.

Invitations are links that you copy. Braid does not send invitation emails.

Check agent connections:

1. Select **Copy setup prompt** in the account menu or in Settings.
2. Make sure that the agent gets access only after an owner selects a repository and approves it.
3. A read connection must refuse writes. A setup connection must refuse merges and organization administration.
4. Revoke the connection. The revocation must take effect at once.
5. Review and merge one live task. Read its `.braid/missions/<id>/decision.json` and `handoff.md` from Artifacts.

Hosted agents run checks in isolated Cloudflare containers and record the real exit status. Before a release, verify a real clone, command, check and pull request in a separate test Worker. The project's own CI stays responsible for its full release checks.

Check the GitHub App:

1. Authorize the App and install it on selected repositories.
2. Make sure that the picker shows only the repositories that the person can use.
3. Import a private repository. Compare its root tree with the source commit.
4. Remove the person's repository access. The next import must fail.

The controlled provider tests do not replace these live checks.

> **Caution:** `scripts/smoke.mjs` writes to an isolated session of the tour. Run it against production only when those writes are allowed. Keep its results separate from real agent runs and real sign-in checks.

## Seed mirrors

An operator can open many GitHub mirrors without the visitor attempt limits.

1. Set `BRAID_MIRROR_SEEDING=1` in `.env.production`.
2. Put a random `MIRROR_SEED_TOKEN` of 32 characters or more in `.dev.vars.production`.
3. Deploy.
4. Send `GET /api/repos/{owner}/{repo}` with the header `x-braid-mirror-seed: <token>` for each repository.

The key skips only the attempt limits. The limit of 1,000 mirrors and the size limits still apply. Send the requests slowly: each new mirror starts an import.

## Data, backups and rollback

On 2026-10-15, production deleted all of its first state. The deploy retired the first Durable Object classes, and the old Artifacts repositories were deleted. `BRAID_RETIRED_STATE=1` in `.env.production` keeps those tombstones. Do not set it on a new deployment.

- The owner-key repository uses the object `owner-v1`. Public organizations use separate repository objects.
- When you change the authentication mode, the old data stays. Braid does not import it into an organization.
- Before you change the mode of an owner-key deployment, download its backup from Settings on the updated owner-key release. Keep its Artifacts repository URL.
- There is no automatic account migration, and no endpoint to restore a backup.

To roll back:

1. Keep the previous configuration and owner key private and safe.
2. Deploy the previous verified source and configuration with `cf`. Do not delete Durable Objects or Artifacts repositories.
   Do not roll production back to a release from before 2026-10-15. Its Durable Object classes no longer exist.
3. A rollback of a public deployment must keep its session secret and storage that is compatible with its schema.

A rollback to owner-key mode makes the old owner repository available again. It does not delete the state of public organizations.

## Limits

- The default limits control early usage. They do not guarantee capacity or availability.
- Before you raise them, monitor request failures, workflow warnings, Workers AI use, Artifacts storage and the email quota.
- A tested restore procedure, a retention and deletion policy, and a load test with many organizations are not done.
