# Dub — build contract (v0.3 + feedback)

The spec is `docs/spec-v0.3.md`; the review of it is `docs/spec-v0.3-feedback.md`.
This file records what the code actually does where the two had to be
reconciled. When this file and the spec disagree, this file wins.

## Decisions taken from the feedback

| # | Decision |
|---|---|
| 1 | **The deployed SHA is the PR head SHA.** The review-app job checks out `github.event.pull_request.head.sha` with `fetch-depth: 0` and passes it to the image as `GIT_SHA`. `dub.json.sha` is the head SHA. The merge SHA is not recorded anywhere; CI and code review cover the merge result. |
| 2 | **`previous`, `criteria_diff` and `rubric.hits` are computed by the Worker at intake** and stored in `meta.json` next to the bundle. `dub.json` is self-contained and never references Worker state. The CLI emits structured criteria (`brief.criteria[]`) so the Worker can diff without parsing markdown. |
| 3 | **Effects are split by credential.** The COMMENT review (as the human) is tried synchronously up to 3 times, then the App posts the same review body prefixed "on behalf of @reviewer". The status write, PR close and sticky comment are App-credentialed and go to the alarm reconciler. There is no separate verdict comment; the structured block lives in the review body. |
| 4 | **You push the branch as yourself; `dub pr` creates the PR as the App** through one Worker endpoint. Branch protection: "Require approval of the most recent reviewable push" OFF, "Require branches to be up to date" OFF, "Dismiss stale reviews" ON. |
| 5 | `fetch-depth: 0` is required for provenance; without full history `first_seen_sha` is `unknown`. |
| 6 | **`/__dub/version` sends CORS for `https://dubthee.dev`** (and `http://localhost:8787` in review apps) and sits outside every auth pipeline. **Every response also carries `x-dub-sha`**, set by one endpoint plug. Both read `GIT_SHA`, baked at build and read once at boot. |
| 7 | `synchronize` sets `dubbed: pending` on the new head immediately, description "Waiting for evidence bundle", target the review page (only when the head has a brief, decision 29). |
| 8 | `pull_request.closed` is subscribed; the DO marks pending deliveries `superseded` and cancels its alarm. |
| 9 | **Judgment specs never assert.** The runner reports any failed expectation in a `judgment` criterion as `error`, never `fail`. The skill says so. |
| 10 | Criterion ids are stable; the skill forbids renumbering. |
| 11 | `preview_moved` makes every status `error` but artifacts stay in the bundle and the page shows them under a banner. |
| 12 | Delivery state stores the GitHub `review_id`, `comment_id` so a retry edits rather than duplicates. |
| 13 | **Header and endpoint from one source.** The runner's fixture checks `x-dub-sha` on every document response; a mismatch turns the remaining criteria into `error` with `preview_moved`. |
| 14 | **Spec imports are copied verbatim.** Relative imports only, resolution stops at `node_modules`, and the bundle lists every inlined file with its sha256. |
| 15 | Reconciler backoff: 30s doubling, capped at 1h, give up after 24h. On give-up the delivery is `failed` and surfaced in the sticky comment and the page header. Status PUTs may retry forever within the window; close and comment use the stored ids. |
| 16 | **Pilot scope:** the data model supports many reviewers and bundles; the page shows one reviewer flow and the newest bundle per SHA only. No multi-bundle picker. (A rerun button was added later, decision 27.) |

The Missive workflow already has a workflow-level concurrency group; it stays.

### Added after the Worker code review

| # | Decision |
|---|---|
| 17 | **Bundle files are never active content.** The Worker serves every bundle file with `content-security-policy: sandbox; default-src 'none'` and `x-content-type-options: nosniff`. Only `png jpg jpeg gif webp webm mp4 json txt` are served inline; everything else (SVG and HTML included) is `content-disposition: attachment` as `application/octet-stream`. Intake keeps all files; serving decides. |
| 18 | **A `bundle_id` is immutable once seen.** Intake reserves the id in the DO with the sha256 of the uploaded `dub.json` before any R2 write. Same id + same digest is an idempotent retry (`200 {existing: true}`, R2 writes skipped if the first upload completed); same id + different digest is `409`. |
| 19 | **A verdict and all of its delivery intents are committed in one synchronous block** (`review`, `status`, `close` for a Reject, `sticky`). The human-credentialed review is attempted synchronously afterwards (3 tries); if that never completes, the reconciler posts it on the reviewer's behalf after a 60s grace period. |
| 20 | **The reconciler is serialised** per PR, and a `status` write re-checks the effective verdict after it lands, re-arming the effective seq if a newer verdict arrived while the request was in flight. |
| 21 | **Close asks GitHub first.** Before closing, the DO fetches the PR, requires `open` and `head.sha` equal to the verdict's SHA, and updates its stored row. `close_on_reject: false` in `.dub/config.yml` disables the close (default true). |
| 22 | **OAuth state is bound to the browser** by a `dub_oauth` nonce cookie (`Path=/auth`, 10 minutes) that must match the signed state at the callback. |
| 23 | **Verdict submissions carry an `idempotency_key`** (UUID per form submission, regenerated after a success). Required from the page (cookie sessions), optional from the API. A replay returns the original result with `replayed: true` and records no new event. |
| 24 | **The publishing workflow is enforced.** The OIDC `job_workflow_ref` must start with `<repository>/.github/workflows/`; if `.dub/config.yml` sets `publish_workflow: review-app.yml`, the file name must match. |

### Added after the first pilot review (the page)

| # | Decision |
|---|---|
| 25 | **The page leads with a summary written from the diff, not with the agent's criteria.** On the first view of a bundle the Worker asks Claude (`claude-opus-5-5`, structured output) for `what_changed`, `key_changes[]`, `test_plan[]` (steps with an app path each) and `worth_a_look[]`, from the PR title and body, the brief, and the PR's file patches (small files first, 160k characters of patch at most). It is stored as `summary.json` next to the bundle and never regenerated unless a viewer asks after an error. The agent's criteria and evidence stay on the page as a collapsed "Agent's checks" panel with a line saying who wrote them. Without `ANTHROPIC_API_KEY` the page shows the diff stats and a link instead. |
| 26 | **The preview opens in a side drawer** (an iframe of `preview.url`, which must be `https`), with a path box, reload and open-in-tab. Each test-plan step with a path opens the drawer there. The host app has to allow framing from `https://dubthee.dev` (`frame-ancestors`) and send its session cookie with `SameSite=None; Secure` on review apps, or the drawer shows the app's own refusal and the viewer uses the tab link. Nothing on the page depends on the drawer working. |
| 27 | **"Run checks again" re-runs the capture workflow.** `POST /api/reruns` finds the newest completed `pull_request` run of the publishing workflow on the bundle's head SHA and asks GitHub to re-run it; the page then polls `/api/prs/…` and reloads when a newer complete bundle for that SHA arrives. Needs the App permission **Actions: R/W**; without it GitHub answers 403 and the page says which permission is missing. Reviewers only. |
| 28 | **`allow_self_review: true` in `.dub/config.yml` lets the PR author record the verdict.** Off by default; on for dogfooding a repo where one person writes the briefs and reviews them. |
| 29 | **A PR without a brief is not a Dub PR.** On `opened`, `synchronize` and `reopened` the Worker lists `.dub/briefs/` at the head SHA; when there is no `*.md` there it records the head but writes no pending `dubbed` and no sticky comment, so a plain human PR never shows a status that cannot resolve. A later push that adds a brief, or a bundle arriving, turns the PR into a Dub PR as before. If the check itself fails the Worker assumes a brief. |
| 30 | **Repo admins are always reviewers.** `reviewers:` grants the verdict to people with write access; anyone with admin on the repo has it without being listed, since they could edit the list anyway. The page tells a non-reviewer why the controls are hidden. |

## Layout of this repo

```
cmd/dub/            Go CLI: init, pack, publish, pr, login
internal/           brief, bundle, inline, provenance, preview, runner, publish, gh
runner/             ghcr.io/dubtheedev/runner — Playwright harness image
worker/             Cloudflare Worker + Durable Object (TypeScript)
skill/dub/          Claude Code skill for agents writing briefs and specs
docs/               spec, feedback, this contract, setup
.dub-out/           default `dub pack` output in a host repo (gitignored by `dub init`)
```

## Preview contract (host app, Missive)

- `GET /__dub/version` → `200 application/json` `{"sha":"<40 hex>"}`; `{"sha":null}` when unset. Headers: `access-control-allow-origin: <origin>` for allowed origins, `cache-control: no-store`.
- Every response carries `x-dub-sha: <40 hex>` (omitted when unset).
- `POST /dev/reset` (review apps only, 404 elsewhere) truncates every table except `schema_migrations` and re-runs the review seed. Returns `200 {"ok":true}`. Idempotent. POST only.
- Existing: `/dev/mailbox`, `/dev/deliver`, four accounts with `review_password_123`.
- Review apps may be framed by the review page (decision 26): `content-security-policy` says `frame-ancestors 'self' https://dubthee.dev` (plus `http://localhost:8787` on review apps) and the session cookie is `SameSite=None; Secure`, so signing in inside the drawer works where the browser allows third-party cookies. Production keeps `frame-ancestors 'self'` and `SameSite=Lax`.

## Brief (`.dub/briefs/<slug>.md`)

Front matter `id` (required, equals the slug), optional `issue`. First `#` heading is the title. A `**Why:**` paragraph. An `## Acceptance` section with lines:

```
- [ac-1] Criterion text   {kind: visual}
```

Kinds: `visual | behaviour | check | judgment`. Ids match `^[a-z][a-z0-9-]*$` and are never reused or renumbered. `dub pack` refuses a brief with zero criteria, a duplicate id, or an unknown kind.

## Evidence specs (`.dub/evidence/*.spec.ts`)

One `test('<criterion id>', …)` per criterion. Title is the id exactly. Specs import `test` and `expect` from **`@dub/test`** (never `@playwright/test` directly): the runner image provides it as Playwright's `test`/`expect` extended with an auto fixture that checks `x-dub-sha` on every document response. Specs may import relative modules under `.dub/`. Fixtures are in the spec, idempotent and safe from a half-mutated state; a clean slate is `/dev/reset` in `beforeAll`. Judgment criteria may have a spec for *supporting* artifacts but it must not `expect` anything.

## Runner interface (`ghcr.io/dubtheedev/runner`)

```
docker run --rm \
  -v <repo>/.dub:/work/.dub:ro \
  -v <out>:/out \
  -e DUB_PREVIEW_URL=https://pr-87-misiva.fly.dev \
  -e DUB_SHA=<head sha> \
  -e DUB_CRITERIA='[{"id":"ac-1","kind":"visual"}, …]' \
  ghcr.io/dubtheedev/runner@sha256:…
```

Inside: `workers: 1`, `retries: 0`, `baseURL=DUB_PREVIEW_URL`, trace `on`, video `on`, screenshots to `/out/<id>/`. `/work/node_modules` is a symlink to the image's own install, so `@dub/test` and `@playwright/test` resolve from `/work/.dub/evidence` without the host repo installing anything. The `@dub/test` fixture asserts `x-dub-sha == DUB_SHA` on every document response; mismatch throws `DubPreviewMoved`. Output `/out/results.json`:

```json
{ "preview_moved": false,
  "tests": [ { "id": "ac-1", "status": "passed|failed|timedOut|skipped|interrupted",
               "error": "…", "steps": ["goto /invoices", "expect badge visible"],
               "attachments": [ {"name":"screenshot","path":"ac-1/list.png","contentType":"image/png"} ] } ] }
```

Status mapping in the CLI: `passed→pass`; `failed→fail` unless kind is `judgment`, then `error`; `timedOut|interrupted|DubPreviewMoved→error`; no test for the id → `none`; `preview_moved → error` for all.

## `dub.json` (version 0)

As in the spec, with these clarifications:

- `sha` is the head SHA. `preview.preview_sha` is what `/__dub/version` returned before the run; `preview.moved` true if the after-check or any page-load check differed.
- `brief.criteria`: `[{id, kind, text}]` in brief order, parsed by the CLI. `brief.text` is the whole file.
- `brief.first_seen_sha`: first commit on the PR branch (relative to `merge-base` with the base) that adds the brief path, or `null`. `before_implementation`: `true` when every other changed file first appears at or after that commit, `false` when at least one appears earlier, `unknown` when history is shallow or the brief was never added on the branch.
- `criteria[].spec.files`: `[{path, sha256}]` for the spec and each inlined relative import; `spec.source` is those files concatenated with `// ---- <path>` separators. `spec.external_imports` lists bare specifiers.
- No `previous`, no `criteria_diff`, no `rubric.hits` in `dub.json`. `rubric.base_sha` is omitted; `diff.areas` comes from `.dub/areas.yml` on the checkout.
- `runner` is the image digest, resolved from the local image.

## `meta.json` (written by the Worker at intake)

```json
{ "bundle_id": "…", "sha": "…", "received_at": "…", "head_at_intake": true,
  "previous": { "sha": "…", "bundle_id": "…", "verdict": "revise", "seq": 3 } | null,
  "criteria_diff": [ { "id": "ac-2", "change": "added|removed|edited", "from": "…", "to": "…" } ],
  "criteria": [ { "id": "ac-1", "spec_changed": false,
                  "evidence": [ { "path": "ac-1/list.png", "artifact_changed": true } ] } ],
  "rubric": { "base_sha": "…", "hits": ["…"] } }
```

`previous` is the newest *complete* bundle of the most recent *earlier* SHA that has a verdict, else the newest earlier bundle, else null. `criteria_diff` compares `brief.criteria` by id against that bundle. `criteria[]` compares evidence hashes per path and `spec.files` fingerprints per criterion against `previous`; `null` means the previous bundle had nothing at that id/path. **The page shows "artifact changed" and "spec changed" from `meta.json`, never from `dub.json`.** `rubric.hits` are the rules in the base branch's `.dub/rubric.md` whose scope intersects `diff.areas`.

## Worker API

| Method, path | Auth | Does |
|---|---|---|
| `POST /api/bundles` | Actions OIDC bearer (`aud=dubthee.dev`) | Body: multipart `dub.json` + `evidence.tar`. Checks `repository`, `event_name=pull_request`, `ref=refs/pull/<n>/merge`, `job_workflow_ref` (decision 24), and that `sha` belongs to PR `<n>`. Reserves `bundle_id` (decision 18), stores to R2 `<owner>/<repo>/<n>/<sha>/<bundle_id>/`, writes `meta.json`, sets `dubbed: pending` on `sha` if that SHA has no verdict. `201 {bundle_id, url}`; `200 {…, existing: true}` on an identical retry; `409` on a different payload under a known id. |
| `GET /r/:owner/:repo/pull/:n` | App OAuth session | Review page (newest bundle for head, or `?sha=`). |
| `GET /api/prs/:owner/:repo/:n` | session, repo read | `{head_sha, bundles:[…], verdicts:[…], deliveries:[…], reopen_seq}` |
| `GET /api/bundles/:owner/:repo/:n/:sha/:bundle_id/*` | session, repo read | Bundle files from R2, sandboxed (decision 17). |
| `POST /api/verdicts` | session, reviewer | `{owner, repo, pr, sha, bundle_id, verdict: dub|revise|reject, note, suggest_rule, used: [...], because: [...], idempotency_key}` → appends event, runs effects, returns effective state (`201`; `200` with `replayed: true` on a replay). |
| `POST /api/summaries` | session, repo read | `{owner, repo, pr, sha, bundle_id, force?}` → writes `summary.json` for the bundle if missing (decision 25) and returns it; `pending` while another request is writing it, `502` with `status: error` when the model failed. |
| `POST /api/reruns` | session, reviewer | `{owner, repo, pr, sha}` → re-runs the newest completed capture run for that SHA (decision 27). `202 {run_id, html_url}`; `409` if one is in progress; `403` naming the missing App permission. |
| `POST /api/prs` | session (`dub pr`) | `{owner, repo, head, base, title, body}` → PR created by the App. Returns `{number, url}`. |
| `POST /webhooks/github` | HMAC | `pull_request` `opened|synchronize|reopened|closed`. |
| `GET /auth/login`, `/auth/callback`, `GET /auth/token` | — | App user-to-server OAuth; `/auth/token` issues a CLI token for the signed-in user. |

Status context: `dubbed`. States: `pending` (bundle awaited or awaiting verdict), `success` (dub), `failure` (revise or reject). Description carries the verdict and reviewer. `target_url` is the review page for that SHA.

## Durable Object (one per `owner/repo/n`)

Tables: `verdicts(seq PK, sha, bundle_id, reviewer, verdict, reason, note, used, because, at, on_behalf, idempotency_key UNIQUE, result)`, `deliveries(seq, effect, sha, state pending|done|superseded|failed, attempts, next_at, first_at, gh_id, last_error)`, `bundles(bundle_id PK, sha, received_at, criteria, digest, complete)`, `pr(head_sha, author, open, reopen_seq, closed_at, sticky_comment_id)`.

Effective verdict for a SHA = highest `seq` for that SHA. Effects per event: `review` (human, sync, App fallback on behalf), `status` (App, effective only, re-checked after the write), `close` (App, reject only, eligibility re-checked at run and against a fresh `getPR`), `sticky` (App, head only). `pending_status` (seq 0) is the App-credentialed pending write on a new head. Alarm: next `min(next_at)` among pending; one reconciler pass runs at a time.

## GitHub App

Permissions: Pull requests R/W, Commit statuses R/W, Contents R (rubric, PR creation needs Contents R only; the branch is already pushed), Actions R/W (re-runs), Metadata R. Events: `pull_request`. OAuth user-to-server enabled, callback `https://dubthee.dev/auth/callback`. Secrets in the Worker: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, and optionally `ANTHROPIC_API_KEY` for the summaries.

## Repo config (`.dub/config.yml` on the base branch)

```yaml
reviewers: [ryanwsnow]      # GitHub logins allowed to write dubbed (repo admins always can)
base: main
preview_origin_allowlist: [https://dubthee.dev]
close_on_reject: true       # a Reject closes the PR (default); false records it only
publish_workflow: review-app.yml   # optional: only this workflow may upload bundles
allow_self_review: false    # true lets the PR author record the verdict (dogfooding)
```
