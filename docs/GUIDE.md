# Pull request guide

The guide divides a pull request into chapters, in a reading order. A Workers AI model writes it. The TypeScript contract is `shared/guide.ts`, and `shared/types.ts` exports it too.

## API

`GET /api/changes/{id}/guide?revision=N` uses the read authorization of the pull request. Without `revision`, it returns the guide of the current revision.

The response has these fields:

- `status`: `"pending"`, `"ready"` or `"failed"`.
- `revision`, `chapters`, `generatedBy` (the Workers AI model ID) and `attributes`.
- `before` and `after`, when the status is `ready`.
- `error`, when the status is `failed`.

A pending or failed guide has no chapters. A failed revision stays in the cache. A new request does not start it again.

## Chapters

Each chapter has `id`, `title`, `summary`, `kind` and `files: [{path, hunks: [{oldStart, oldLines, newStart, newLines}]}]`.

- The model selects the kind and the order of each chapter. Tests and generated files come last.
- Hunk coordinates follow unified diffs with three lines of context. A side with zero length gives the line before it.
- A file with only metadata, or with empty content, has the anchor `0,0` on both sides.

## Attributes

`attributes: [{path, generated?: boolean, vendored?: boolean}]` come only from explicit `linguist-generated` and `linguist-vendored` lines in the `.gitattributes` files of the revision.

- `false` means an explicit unset. A missing value means unknown.
- Attributes can arrive while the model works, and they stay if the model fails.
- Braid does not classify files by their names or comments. Other attribute syntax has no defined result.

## Jobs

A submission saves a job and returns at once. It does not wait for Git reads or for the model.

- The change shard runs two guide jobs at a time.
- Each attempt has a limit of 90 seconds. A job has at most two attempts.
- If the model's answer fails validation, the next attempt gets the failure as a correction.
- The hunks must match the diff exactly. Braid does not repair chapters or fill in missing ones.
- A leased attempt continues after a restart. A late answer cannot replace the answer of a newer attempt.
- Braid does not send a revision that contains a secret to the model, and it does not show that revision publicly.

## Model and input

The model is `@cf/zai-org/glm-5.3`. The input has the title, the summary, the author's description, the full diff and the explicit attributes.

- The input has an upper limit of 96,000 tokens, counted as UTF-8 bytes.
- The diff has an upper limit of 200 files and 600 hunks.
- If the input is too large, the guide fails with an error. Braid never omits hunks.

## Guides in the tour

The tour reads only the `guides` in `worker/changes/recorded.json`. Recording needs Cloudflare sign-in and Workers AI access. Model calls can incur charges.

1. Complete [Cloudflare sign-in](../README.md#live-development).
2. Run the recorder through the installed `cf` CLI.

   ```sh
   BRAID_RECORD_GUIDES=1 npm test -- worker/changes/guide-record.test.ts
   ```

- The normal test suite never runs this inference.
- The test writes the raw answers and the validated guides to a temporary directory. It prints the path.
- `BRAID_GUIDE_RECORD_DIR` continues from that directory.
- `BRAID_GUIDE_FEEDBACK_FILE` names a JSON map from `changeId:revision` to a reviewer's correction. Only those revisions are recorded again.
- The recorder reads the source again before it writes. If another process changed the recorded diffs, it stops.
