# Dub spec v0.3 — feedback

Overall: the hard problems (verdict ordering, SHA pinning, authority) are now solved on paper, and step 0 before any build is the right call. What follows is mostly places where the spec assumes a fact that isn't true of the Missive pipeline or of GitHub, plus the three engineering questions.

## Will bite during build

1. **Which SHA is deployed?** On `pull_request`, `actions/checkout` checks out the **merge commit** (`refs/pull/N/merge`), and `github.sha` is that merge SHA, not the head. So the preview today runs head+main, while `dubbed` and the bundle are pinned to head. Decide one: check out `github.event.pull_request.head.sha` explicitly in the review-app job and bake that into the image (recommended; code review and CI cover the merge result), or record both `head_sha` and `merge_sha` everywhere. Otherwise `/__dub/version` will "differ" from every bundle.
2. **`previous` and `criteria_diff` can't be computed in CI.** The runner doesn't know the previous bundle's `bundle_id`, its brief text, or `seq`; that's Worker state. Have the Worker compute `previous` and `criteria_diff` at intake and store them in a sidecar (`meta.json`), keeping the uploaded bundle self-contained. Same for `rubric.hits` if the rubric is read from the base branch rather than the checkout.
3. **Human-credentialed effects can't be retried later.** The COMMENT review "as the human" needs the reviewer's user-to-server token at delivery time. If it fails and waits for the alarm reconciler, the token may be expired and the refresh token would have to live in the DO. Split effects by credential: human-credentialed ones get a short synchronous retry, then fall back to the App posting "on behalf of @reviewer". App-credentialed ones (status, close, sticky comment) go to the reconciler. Also: a review body is already a comment. Drop the separate verdict comment and put the structured block in the review body.
4. **"Agent PRs open as the App" is more machinery than step 1 implies.** Pushing as an App needs a 1-hour installation token minted somewhere a local Claude Code run can reach, i.e. the Worker mints tokens for OAuth'd users. Cheaper: push the branch as yourself, and only **create the PR** via the App (`dub pr`, one Worker endpoint). GitHub's self-approval block is on the PR author, not the committer. Corollary: keep "Require approval of the most recent reviewable push" **off**, or your own pushes block your own code-review approval.
5. **Provenance needs history.** `first_seen_sha` requires `fetch-depth: 0` in the job. Say so, or `unknown` will be the only value you ever see.
6. **CORS on `/__dub/version`.** The review page polls it cross-origin from the Worker's domain. The endpoint needs `Access-Control-Allow-Origin` for dubthee.dev, and it must be excluded from any auth plug.

## Smaller gaps

- **`synchronize` should set `dubbed: pending` immediately** on the new head with a "waiting for bundle" description. A missing status also blocks, but a pending one with a link tells the human what's happening during the deploy window.
- **Add `pull_request.closed`** to the webhooks so the DO can stop reconciling and mark remaining deliveries superseded.
- **"Require branches to be up to date" must be off**, or every merge from main mints a new SHA and resets `dubbed`.
- **Concurrency group at the workflow level**, not the deploy job. Then a `closed` destroy cancels an in-flight deploy instead of racing it and recreating the app.
- **Judgment specs must not assert.** A failed `expect` in a judgment spec should surface as `error`, never `fail`. Put "no expects in judgment specs" in the skill and enforce it in the runner.
- **Stable criterion ids** belong in the skill. If the agent renumbers, `criteria_diff` flags everything and the signal is gone.
- **`preview_moved` → every status `error`:** keep the artifacts visible with a banner. They may still be useful even when they can't be trusted.
- **Idempotent deliveries:** store the comment id and review id per effect in delivery state so a retry edits rather than duplicates.

## Engineering open questions

- **`/__dub/version`: endpoint vs header.** Both, from one source. A plug sets `x-dub-sha` on every response (impossible to forget, and `dub pack` can verify the SHA on *every* page load, not just before/after). The endpoint returns the same value as JSON for the page's poll. Source: `GIT_SHA` baked at build from a Dockerfile `ARG`, read once at boot into app env.
- **Inlining spec imports.** Copy verbatim. Resolve relative imports only, stop at `node_modules`, and emit a file list with hashes. Faithfulness is already guaranteed by the committed SHA plus the pinned runner digest; readability on the review page is the only reason to inline at all. esbuild output defeats that reason.
- **Reconciler backoff and give-up.** Exponential from 30s, capped at 1h, give up after 24h. On give-up, mark the delivery `failed` and surface it in two places: the sticky PR comment (where humans look) and the review page header. Status writes are safe to retry forever since they're idempotent PUTs; close and comment are the ones that need the stored ids above.

## One framing note

Half of v0.3's additions (serialised seq, reopen boundary, superseded effects) only matter with concurrent reviewers, and the pilot has one product reviewer. The spec is right that a per-PR DO is the simplest *correct* substrate on Cloudflare, so keep the data model. But resist implementing anything the two-week pilot can't exercise: one reviewer, no rerun-after-dub UI, no multi-bundle picker. Let step 0 and week 1 tell you which edge cases are real.
