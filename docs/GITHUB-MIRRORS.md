# GitHub mirrors

A mirror is a Braid copy of a GitHub repository, at the same address on Braid. This doc gives the rules for mirrors, claims and links.

## Address lookup

`GET /api/repos/{owner}/{repo}` resolves the address in this order:

1. A Braid repository at the address wins.
2. If there is none, and GitHub has an allowed source, the Directory reserves the address once. Artifacts imports the source in the background with `ARTIFACTS.import({ source: { depth: 1, ... } })`.
3. Visits at the same time share the reservation and the repository ID.

The tour at `example/relay` is separate from mirrors.

## Public and private sources

For a new public owner that nobody claimed, Braid reads GitHub only through anonymous Git smart HTTP:

```
https://github.com/{owner}/{repo}.git/info/refs?service=git-upload-pack
```

- The advertisement has a size limit. It must contain a HEAD and a default-branch symref that agree.
- Braid uses no anonymous REST call, no App token and no token of another person.
- Until Braid has verified identity data, the owner shows its login.
- The page of an unknown owner does not list GitHub repositories. It lists only the mirrors that people already opened in Braid.

A private source needs the visiting person's own GitHub token.

- Braid checks the person's access to the repository at each visit. The check is valid for 60 seconds or less, for one person, one token and one repository.
- Membership of the Braid owner does not replace this check.
- Private mirrors have no shared edge cache. They are not in Explore, cross-repository search, social previews or anonymous MCP and Git reads.
- No mirror, public or private, is in bulk public discovery.
- Owner and account lists show a mirror only if the current access check succeeds.

## API

A successful lookup returns the `RepositoryAddress`, with this optional field:

```ts
mirror?: {
  source: string; // https://github.com/{owner}/{repo}
  syncedAt: string | null; // ISO timestamp
  startedAt?: string; // ISO time Braid reserved the mirror
  importing: boolean;
  claimable: boolean;
}
```

- The first accepted lookup returns HTTP 200 with `importing: true`, `syncedAt: null` and `canWrite: false`.
- `mirror.startedAt` is present during the first copy, including preparation.
- `/api/state` shows the import while it runs. Repository content returns HTTP 503 until the first copy is ready.
- Then the history copies below the imported tip, newest first, as far as the storage of the repository allows.
- While Artifacts cannot resolve the branch by name, readers use the known head.

### Errors

| Status | Code | Message |
|---|---|---|
| 404 | `github_not_found_or_private` | Signed out: "Not found on GitHub. If it's private, sign in with GitHub to see it." Signed in without access: "Not found on GitHub, or you don't have access." |
| 413 | `mirror_too_large` | "Too large to mirror." |
| 409 | `github_namespace_changed` | "The GitHub account behind this name changed. This mirror is frozen." |
| 429 | | A plain reason for the admission limit. |
| 502 | | A failed import. Later lookups return its plain error. |

A missing repository and a private repository give the same 404 on purpose.

### Claims and links

- `claimable` is computed for the signed-in person. It is cached for 3 minutes for each person, identity and owner.
- `GET /api/owners/{slug}/claim` returns `{ claimable: boolean, link?: true, reason?: string }`. `link` means that the claim links a Braid organization that exists, instead of creating an owner.
- `POST /api/owners/{slug}/claim` always checks new proof. It returns `{ ok: true, role: "owner" | "member" }`, or an HTTP error with `{ error: string }`.
- `GET /api/owners/{slug}` adds `mirror: true` for a mirror owner that nobody claimed.

## Claims

An owner that nobody claimed has no members and no write access.

- **Personal claim.** A new `/user` response must match the immutable ID of the stored GitHub identity and the requested login. Case does not matter.
- **Organization claim.** The person's own `/user/memberships/orgs/{org}` response must have `state: "active"` and `role: "admin"`. If GitHub does not allow this check, the claim fails with a plain reason.
- An installation of the GitHub App is not proof of admin. There is no fallback to an installation token.

A claim pins the immutable ID of the GitHub account.

- After the first admin claims an organization, other active GitHub members can get member access on Braid. A second admin does not replace the first owner.
- Automatic membership sync compares the pinned organization ID.
- A claim pauses each mirror before it turns on writes. If the claim fails, the mirrors resume. A pause expires if the object restarts or an RPC response is lost.
- To write to GitHub, the owner still needs a GitHub link with push permission.

## Names that Braid owners hold

Braid owners keep the names that they had before Braid checked names against GitHub.

- A personal owner whose stored GitHub identity matches the name can get read-only mirrors. An owner that is not verified, or that does not match, cannot.
- To create or rename a Braid owner, Braid checks GitHub with the person's token. A name that GitHub uses needs the same proof as a claim.
- Braid does not move or rename owners that exist.

A Braid organization holds its name, and nobody can mirror into it, until one of its owners links it.

1. The owner sends the claim POST.
2. GitHub must confirm that the owner is an admin of the GitHub organization with that name.
3. Braid pins the immutable ID of that GitHub organization.
4. From then on, mirrors under the name follow the rules for pinned owners below.

Only an organization can be linked. Only its own owner can link it, and only once.

## Pinned owners

- A new mirror under a pinned owner needs the visiting person's own repository response, with `repo.owner.id` equal to the pin. An anonymous visitor gets the normal "not found" answer.
- Anyone can read a public copy that exists. Its automatic refresh needs new proof of the owner ID from a signed-in visitor.
- The import bridge and the background transfer do the same check again.
- If the ID does not match, Braid freezes the mirror. It stops maintenance and new transfers. A late successful update cannot clear the freeze or change its recorded head.
- Braid does not unfreeze or reassign a mirror automatically.

## Sync

- A read schedules a refresh after about 5 minutes. It does not wait for the Git transfer.
- Public data comes through anonymous Git. Private data comes with the token of the person who started the refresh.
- The default branch refreshes with compare-and-swap.
- The first history copy includes up to 300 branches. Braid does not refresh the other branches periodically.
- After a claim, Braid's normal repository and GitHub-link workflows replace the automatic mirror maintenance.

### Full copies

Artifacts holds 1 GB for each repository. It counts objects one by one, and it refuses all pushes after the limit. If a copy becomes full, Braid replaces it:

1. A new import starts beside the full copy.
2. The full copy serves reads until the new copy is ready. Then Braid deletes the full copy.
3. The new copy keeps only its default branch. It copies history to 60% of the depth that the full copy reached.

## Limits

Braid charges each attempt before it contacts GitHub, also when the source is not available:

- 20 attempts for each network in each hour, with the network key of the tour.
- 200 attempts for each UTC day, for all networks.
- 1,000 mirrors in total.
- First visits at the same time share one attempt.

Transfer limits:

- An advertisement for admission or for the import bridge: 1 MiB. The background branch reader: 4 MiB.
- Each pack transfer: 64 MiB.
- All imported and transferred data for one mirror: 2 GiB. A replacement copy starts with the full budget.
- Braid refuses a source before the import if GitHub reports a size above 2 GiB.
- After a crash, transfer reservations stay counted.
- These limits measure transfers. They do not measure the size of a working tree.

Imports use a Braid bridge capability that cannot be read and that expires, so tokens never go into source URLs. The bridge, the refresh and the history copy all enforce the pack limits. Reads during an import use leases in memory, and they do not write to the repository's SQLite storage.

Braid does not support these cases:

- An empty repository without an advertised HEAD.
- A name that GitHub uses, without proof.
- Automatic unfreezing.
- Writes to GitHub without a link that has push permission.
- Automatic cleanup of mirror storage.

## Local verification

`worker/test/mirror.ts` combines the GitHub fake, real local Git servers, the real Directory, Security and Workspace objects, and a fake with the shape of Artifacts.

- Its RPC methods refuse `.bind`. Its reader refuses `refs/...` names.
- It holds the first import, to test admission at the same time and reads during the import.
- Its private fixture tells people with access from people without it. Anonymous GitHub smart HTTP cannot tell a missing repository from a private one.
- The public lifecycle test makes every REST request return 403. It requires zero REST requests in admission, import, history copy and refresh.

The Cloudflare SDK has no local Artifacts simulator. A development server with `remoteBindings: false` can check admission and refusals, but it cannot complete a real import. Check real imports, reads and pages in production after a deploy.
