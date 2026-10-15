# Connect your CI

Braid's merge queue works with any CI, as GitHub's merge queue does:

1. Braid sends a `merge_group` webhook for each batch.
2. Your CI tests that commit.
3. Your CI reports the result with commit statuses.

If the repository is linked to GitHub for pull requests, you do not need this. GitHub Actions already run on each merge-queue pull request.

## Set up

1. In Settings › Webhooks, enter the HTTPS endpoint of your CI and a secret of 16 characters or more.
2. In `.braid/policy.json`, list the statuses that must pass:

```json
{ "verify": { "required": ["buildkite/test"], "minutes": 20 } }
```

## The webhook

Braid sends a `POST` with the header `X-Braid-Event: merge_group`. The header `X-Braid-Signature-256` is `sha256=` followed by the HMAC-SHA256 of the body, with your secret as the key.

```json
{
  "action": "checks_requested",
  "merge_group": { "head_sha": "…", "head_ref": "refs/heads/braid/land/b_…", "base_sha": "…", "base_ref": "refs/heads/main", "pull_requests": [{ "number": 13, "title": "…" }] },
  "repository": { "name": "…", "clone_url": "https://…", "default_branch": "main" },
  "clone": { "token": "…", "expires_at": "…" },
  "statuses_url": "https://<braid>/api/statuses/<repository>/<head_sha>"
}
```

Clone `clone_url` with `clone.token` as the password. Any username works. Then check out `head_sha`. The token can only read, and it expires after 10 minutes.

## Report the result

Send a `POST` with JSON to `statuses_url`. Sign it in the same way.

```json
{ "state": "success", "context": "buildkite/test", "description": "24 tests passed", "target_url": "https://ci.example/builds/7" }
```

- `state` is `pending`, `success`, `failure` or `error`.
- A failure sends the responsible pull request back, with your description and link.
- Braid merges when all required contexts succeed.
- If a required context does not arrive within `minutes` plus 5, Braid tries the batch again. Braid never merges a batch without it.
