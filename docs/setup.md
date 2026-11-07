# Dub — one-time setup

What has to exist before the Missive pilot can run end to end. Everything here
is manual; none of it is needed for step 0 (hand-made bundles).

## 1. GitHub organisation and image name

`ghcr.io/dubtheedev/runner` and `github.com/dubtheedev/dub` assume a
`dubtheedev` GitHub organisation (`dubthee` itself is taken). **Create it
before the first push**, then create the `dub` repo inside it and push this
tree; the runner workflow publishes the image to that org's GHCR. The Worker
never references the image, so it needs no change either way.

## 2. The GitHub App

Register one App (Settings → Developer settings → GitHub Apps → New), owned by
the org that owns `deeptreecorp/missive` so it can be installed there.

| Field | Value |
|---|---|
| Name | `Dub` (the slug becomes the `dubbed` status author and the PR author for `dub pr`) |
| Homepage | `https://dubthee.dev` |
| Callback URL | `https://dubthee.dev/auth/callback` |
| Request user authorization (OAuth) during installation | off |
| Webhook | active, URL `https://dubthee.dev/webhooks/github`, a fresh secret |
| Repository permissions | Pull requests **R/W**, Commit statuses **R/W**, Contents **R**, Metadata **R** |
| Subscribe to events | **Pull request** |
| Where can this App be installed | Only on this account |

Then:

1. Generate a private key. GitHub downloads it as PKCS#1 (`BEGIN RSA PRIVATE KEY`). The Worker's `jose` needs PKCS#8:
   ```sh
   openssl pkcs8 -topk8 -nocrypt -in dub.YYYY-MM-DD.private-key.pem -out dub-app.pkcs8.pem
   ```
2. Note the App ID, the Client ID, and generate a client secret (user-to-server OAuth).
3. Install the App on `deeptreecorp/missive`.

## 3. Cloudflare

```sh
cd worker
npm install --legacy-peer-deps
npx wrangler login
npx wrangler r2 bucket create dub-bundles        # private; the Worker is its only reader

npx wrangler secret put GITHUB_APP_ID              # e.g. 123456
npx wrangler secret put GITHUB_APP_PRIVATE_KEY     # paste the PKCS#8 PEM; newlines may be \n, the Worker restores them
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID     # Iv1.…
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET             # openssl rand -hex 32

npx wrangler deploy
```

DNS: add `dubthee.dev` as a zone in the same Cloudflare account; `wrangler.toml`
declares it as a custom domain, so the first deploy creates the record.

`GITHUB_OIDC_AUDIENCE`, `ALLOWED_ORIGINS` and `PUBLIC_URL` are plain vars in
`wrangler.toml`. The review-app job requests its OIDC token with
`audience: dubthee.dev`.

### Running locally

```sh
cp .dev.vars.example .dev.vars   # fill in the same six secrets
npx wrangler dev                 # http://localhost:8787
npm test                         # vitest inside workerd; no network
```

With `PUBLIC_URL=http://localhost:8787` in `.dev.vars` the OAuth callback must
also be registered on the App as `http://localhost:8787/auth/callback`
(GitHub allows several). Webhooks need a tunnel (`cloudflared tunnel --url
http://localhost:8787`) or can be replayed from the App's "Recent deliveries".

## 4. The repo (`deeptreecorp/missive`, on `main`)

`.dub/config.yml`:

```yaml
reviewers: [ryanwsnow]          # GitHub logins allowed to write `dubbed`
base: main
preview_origin_allowlist: [https://dubthee.dev]
# A Reject closes the PR, as the spec says. Set false to record Rejects
# without closing (the status still goes red).
close_on_reject: true
# Only tokens minted by this workflow file may upload bundles. Leave it out
# to accept any workflow in the repo's own .github/workflows/.
publish_workflow: review-app.yml
```

Bundle files are served from the Worker under a sandboxing CSP; only
images, video, JSON and plain text are shown inline, everything else (SVG,
HTML, traces) downloads. Nothing in a bundle can run script against a
reviewer's session.

`.dub/areas.yml` maps area names to path globs (the CLI turns a diff into
`diff.areas`):

```yaml
email:
  - lib/missive/mailer/**
  - lib/missive_web/emails/**
invoices:
  - lib/missive/invoices/**
```

`.dub/rubric.md` is editorial; the Worker reads it from the base branch at
intake and records the rules whose scope intersects the bundle's areas:

```markdown
# Rubric

## Plain tone, no exclamation marks
Scope: email, broadcasts
Source: https://github.com/deeptreecorp/missive/pull/120#issuecomment-1
Customers found "!" pushy. Applies to anything a customer reads.

## Every list has an empty state
Scope: *
```

Format: one `## heading` per rule (the heading *is* the rule), an optional
`Scope:` line of comma-separated area names (`*` or no line means every area),
an optional `Source:` line, then free-text rationale. Matching is
case-insensitive.

## 5. Branch protection on `main`

Intended settings, from the contract (decision 4):

| Setting | Value | Why |
|---|---|---|
| Require status checks: `dubbed` | on | the product gate |
| Require 1 approving review | on | the code gate |
| Dismiss stale reviews | **on** | the approval is the code gate; `dubbed` is pinned separately |
| Require approval of the most recent reviewable push | **off** | you push the branch yourself; on, your own pushes would block your own code-review approval |
| Require branches to be up to date | **off** | otherwise every merge from main mints a new SHA and resets `dubbed` |

**Caveat: these cannot be set today.** `deeptreecorp/missive` is a private
repository in an organisation on GitHub Free, where protected branches and
rulesets are unavailable (the API answers "Upgrade to GitHub Pro or make this
repository public"). Until that changes, the `dubbed` status and the approving
review are **advisory**: they post to the PR, show in the checks list, but do
not block the merge button. Three options:

1. **Move the org to GitHub Team.** Protected branches and rulesets become available on private repos; apply the table above.
2. **Make the repo public.** Same settings become available on Free. Probably not, given the review-app comments carry seeded credentials.
3. **Run the pilot advisory.** Agree that nobody merges an agent PR without a green `dubbed` and an approval, and measure as planned. Enforcement can be added later without changing anything in Dub.

The Worker needs no change for any of the three: it writes the status and the
review the same way whether or not GitHub enforces them.

## 6. The Missive workflow

Owned by the Missive side (see `docs/contract.md`, "Preview contract" and the
review-app job). The Worker expects, per deploy: `permissions: id-token: write`
on the job, a checkout of `github.event.pull_request.head.sha` with
`fetch-depth: 0`, `GIT_SHA` passed to the image, then `dub pack` and `dub
publish` after `flyctl deploy`.

## 7. First run checklist

- [ ] App installed; `GET https://dubthee.dev/healthz` answers `{"ok":true}`
- [ ] Ryan signs in at `https://dubthee.dev/auth/login`; `/r/deeptreecorp/missive/pull/<n>` shows "waiting for a bundle" rather than 403
- [ ] Push to an open PR → the PR shows a pending `dubbed` with "Waiting for evidence bundle" and a sticky Dub comment
- [ ] Review-app job uploads → status description becomes "Awaiting product acceptance", page renders the bundle
- [ ] Verdict from the page → COMMENT review by Ryan, status success/failure, sticky updated
- [ ] `dub login` → `/auth/login?cli=1` → token pasted; `dub pr` opens a PR authored by the App
