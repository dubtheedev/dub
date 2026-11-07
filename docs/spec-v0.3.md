
# Dub — Spec v0.3 (Missive pilot)

*Project Babylon · dubthee.dev · CLI: `dub` · Nov 2026*

> *"I dub thee merged."*

**Changelog**
- **v0.3:**
  - Verdicts move out of R2 into a **per-PR Durable Object** (transactional, serialised). Verdict events are immutable; sync state is separate and mutable.
  - The reconciler applies only the **effective** verdict.
  - Every PR-wide side effect gets a fresh eligibility check, and a reopen boundary is defined.
  - Bundles get a `bundle_id`; there can be several per SHA; verdicts reference both. A rerun doesn't invalidate an acceptance.
  - One concurrency boundary covers deploy and capture; Playwright runs with one worker.
  - Authority and read-access boundary written down.
  - Hand-made experiment is now step 0.
  - Leave-the-bundle reasons are multi-select; "bundle-page time" renamed; brief provenance can be `unknown`; spec dependencies inlined; every criterion edit flagged; Bag claim softened.
- **v0.2:**
  - Product-acceptance positioning; code review stays a separate gate.
  - SHA pinning; verdict transaction rules; brief provenance; softer evidence semantics; editorial rubric.
  - Pilot scope cut; narrow experiment first.
- **v0.1:** reconciled with Missive's review-app setup.

## One line
**Product acceptance for agent-written work.** Every change arrives as a **dub request**: the brief, evidence against each acceptance criterion, a live preview, and the diff. A **human** decides whether it's what we asked for and the product we want: Dub it, Revise, or Reject.

## What a dub does and doesn't guarantee
- **A dub means:** an authorised human saw the brief and a specific evidence bundle for a specific SHA, and accepts it as the product we wanted.
- **A dub does not mean:** the code is correct, secure or well-built. Evidence shows intended behaviour; it misses authorization holes, migration hazards and poor implementation.
- **Code review is a separate required gate.** `dubbed` is the product gate; a normal approving review is the code gate. Dub posts its verdict as a **COMMENT** review, never APPROVE.
- **Pilot:** Ryan does product acceptance, Anson does code review. These are logged as separate acts.

## Thesis
Capture is commoditising (ProofShot, provepr, Builder QA agent, Plannotator galleries). Nobody owns the **judgment**. Reviewing *organised around what was requested*, with evidence and uncertainty next to each criterion, is the product. Taste written down as rules is the hoped-for compounding asset, to be proven after the review surface earns regular use.

## Naming
- **CLI:** `dub`. **Unit:** dub request. **Verdicts:** **Dub it** / Revise / Reject. **Status check:** `dubbed`.
- **Domain:** dubthee.dev. Keep it distinct from dub.co.

## Principles
1. **Agent declares, CI captures, human judges.** CI can never judge (see Authority).
2. **The agent never grades itself.** Evidence is always shown with what was actually asserted, including helper code.
3. **Humans confirm criteria, not just verdicts.** Every criterion edit is flagged.
4. **Every criterion has evidence or says it has none.**
5. **Verdicts are pinned to a SHA and a bundle.**
6. **Fast to tell.**
7. **GitHub-native, zero footprint on the host toolchain.**

## Core objects

| Object | Identity | What it is | Lives in |
|---|---|---|---|
| **Brief** | path on the branch | What we want, why, and 3–6 criteria. Same SHA means the same brief, because it's committed. | `.dub/briefs/<slug>.md`; inlined into the bundle |
| **Bundle** | `bundle_id` (ULID), linked to `sha` | One immutable capture. **Several can exist per SHA** (reruns, a runner or rubric change). | R2, `<repo>/<pr>/<sha>/<bundle_id>/` |
| **Evidence** | inside the bundle | Artifacts and assertion results for one criterion | R2 |
| **Verdict event** | `seq`, allocated per PR | Immutable: `{seq, sha, bundle_id, reviewer, verdict, reason, note, left_bundle, at}` | **Durable Object per PR** (SQLite storage) |
| **Delivery state** | per `(seq, effect)` | Mutable: status / comment / review / close. Pending, done or superseded. | same Durable Object |
| **Rubric** | base-branch SHA | Reusable rules with scope and rationale | `.dub/rubric.md` on the **base branch** |

### Brief format
```markdown
---
id: invoice-reminders
issue: MIS-142            # optional
---
# Send a reminder when an invoice is 7 days overdue

**Why:** customers forget; we chase manually.

## Acceptance
- [ac-1] Overdue invoice (7d) shows "Reminder sent" badge in the invoice list   {kind: visual}
- [ac-2] Reminder email renders with invoice link and amount                     {kind: visual}
- [ac-3] No reminder sent twice for the same invoice                            {kind: behaviour}
- [ac-4] Copy tone matches existing emails                                       {kind: judgment}
```
- **visual / behaviour / check**: automated evidence.
- **judgment**: a human decides; it may carry *supporting* evidence that never grades.

**Brief provenance (a heuristic, not proof):**
- `first_seen_sha` and `before_implementation`: `true | false | unknown`.
  - It's `unknown` when history is shallow, squashed or rebased in a way that hides the order.
  - Even `true` only means the brief was committed first. It doesn't mean a human confirmed it.
- **`criteria_diff` against the previous bundle's SHA:** every added, removed or edited criterion is flagged for human attention. There's no automated "weakening" detection in the pilot.

### Evidence specs
- **Location:** `.dub/evidence/*.spec.ts`, one `test()` per criterion id. Runner owned by Dub; host repo untouched.
- **Fixtures:** in the spec, using the preview's dev endpoints. Specs must be idempotent **and safe to start from a half-mutated state**, because an interrupted run doesn't undo its fixtures. Specs that need a clean slate call `/dev/reset` in setup, not teardown.
- **Playwright runs with one worker by default** (`workers: 1`), since tests share resettable state.
- **What was asserted is self-contained:** `dub pack` bundles each spec together with the **local modules it imports** (helpers, page objects) into the bundle's `spec.source`. Anything imported from outside the repo is listed by name.

**Status semantics (operational):**

| Status | Meaning | Shown as |
|---|---|---|
| `pass` | Every declared assertion completed | "Assertions passed", with the assertions listed |
| `fail` | A declared assertion failed | "Assertion failed: …" |
| `error` | Execution stopped before completing | "Couldn't complete" (could be a product defect or a capture problem) |
| `none` | No automated evidence | "No automated evidence" |

**Change tracking**, kept as separate facts:
- **Artifact:** identical or changed (by hash).
- **Criterion text:** changed (flagged).
- **Spec source:** changed, including inlined helpers.

## SHA-pinning contract
1. **The preview exposes its deployed SHA** at `GET /__dub/version`.
2. **Capture verifies it.** `dub pack` reads the deployed SHA before the run and refuses if it differs from the commit being packed. It reads it again after the run; if it changed, the bundle is marked `preview_moved` and every status becomes `error`.
3. **The review page shows "preview SHA differs".** It polls `/__dub/version` and shows *"Live preview runs b4c5d6e; this bundle is a1b2c3d"* whenever the two differ. It says "differs", not "ahead", because force-pushes and rollbacks have no order.
4. **The verdict keeps the SHA it was submitted against,** always. Status writes target **that SHA** only.
5. **PR-wide side effects** (closing the PR, upserting the sticky comment) **need a fresh eligibility check at the moment they run**, not only at submission.
6. **The UI finds out when a verdict went historical.** After submitting, the page reads back the effective state. If the head moved during submission, it says: *"Recorded for a1b2c3d. The PR has moved on to b4c5d6e, which has no verdict yet."*

Known limit: the persistent Neon DB means preview data can change between capture and review. The bundle is the record; the preview is for exploring.

## Verdicts: storage, ordering, reconciliation

**Storage:** one **Cloudflare Durable Object per PR**, using its SQLite storage.
- Every write for a PR goes through one single-threaded object, so sequence numbers come from one counter and concurrent submissions can't lose each other.
- **Verdict events** are append-only rows.
- **Delivery state** is a separate mutable table.
- Durable Object alarms drive the reconciler.
- R2 holds bundles only.

**Ordering:** for a SHA, the **effective verdict** is the event with the highest `seq` for that SHA.

**Submitting a verdict** (inside the PR's Durable Object):
1. Authenticate the reviewer (see Authority) and check `bundle_id` belongs to `sha`.
2. **Append the verdict event.** This is the commit point.
3. Enqueue delivery effects for this event.
4. Run the effects (below) right away; anything that fails stays pending for the alarm-driven reconciler.
5. Return the effective state to the page (contract step 6).

**Delivery effects and the rules they follow:**

| Effect | Applied when | Rule |
|---|---|---|
| `dubbed` status on `sha` | **Only from the current effective verdict for that SHA.** | The reconciler recomputes the effective verdict and writes *its* status. Superseded events never write status, so a delayed retry of an earlier Dub it can't reopen the gate after a Revise. |
| Verdict comment + COMMENT review (as the human) | For any event, including superseded ones | Historical record. Safe to deliver late; it's marked as superseded if a later event exists. |
| Close the PR (Reject) | Only if, **at execution time**: this event is still the effective verdict for its SHA, that SHA is still the PR head, the PR is open, and **no reopen happened after this event's `seq`** | **Reopen boundary:** a `reopened` webhook records a reopen marker with the current `seq`. A Reject with `seq` ≤ the last reopen marker never closes. A delayed Reject never undoes a deliberate reopen. If the conditions fail, the close is marked `superseded`, not retried. |
| Sticky PR comment upsert | Only for the head SHA's newest bundle | Fresh head check at execution. |

**Edge cases:**

| Case | Behaviour |
|---|---|
| Dub it recorded, status write fails, then Revise recorded | The reconciler computes the effective verdict = Revise and writes failure. The Dub it's status effect is marked `superseded`. |
| Two reviewers submit at once | Serialised by the Durable Object; the later `seq` wins; the page shows the sequence. |
| A push arrives during submission | The verdict stays bound to its SHA; the status goes to that SHA (harmless); the close re-checks the head and is skipped if it moved; the UI reports that the verdict is now historical. |
| An older workflow finishes after a newer one | Its bundle is stored. It can't take over the sticky comment or pending status unless its SHA is the current head. |
| Publish retried or rerun for an already-dubbed SHA | Creates a new `bundle_id`. **Doesn't touch `dubbed`.** See "Bundles and acceptance". |

### Bundles and acceptance
- A verdict accepts a **specific `bundle_id`** for a SHA.
- **A newer bundle for the same SHA doesn't invalidate the acceptance.** The code and criteria are identical (the brief is committed), so acceptance stands. *(This is an explicit choice.)*
- The page and the PR comment show it plainly: *"Dubbed on bundle 01HX… · a newer capture exists for this SHA (rerun after a capture error)."*
- If the newer bundle has a `fail` where the accepted one had `pass`, it's flagged loudly to the reviewer, but **the status isn't changed automatically**. A human decides whether to Revise.
- With no verdict yet for the SHA, the page always shows the newest bundle, and older ones are reachable.

## Authority and access
- **Evidence specs run without verdict-writing credentials.** The CI job has no token that can set `dubbed` to success or failure, post reviews, or close PRs.
- **CI can upload bundles but can't approve them.**
  - `dub publish` sends the bundle to the Worker, authenticated with the job's **GitHub Actions OIDC token**. The Worker checks the repo, the workflow and the PR.
  - The Worker stores the bundle and sets `dubbed: pending` (if there's no verdict for that SHA).
  - CI never holds the App's private key.
- **Only the Worker writes `dubbed`,** and only success or failure from an effective verdict by an **authorised reviewer**:
  - The reviewer is authenticated through the App's user-to-server OAuth.
  - Authorised means they have write access to the repo **and** are on the repo's reviewer list in `.dub/config.yml` on the base branch.
  - The PR author (the agent's App identity) can never be a reviewer.
- **Bundles are as private as the repo.**
  - The R2 bucket is private, with no public or presigned links in PR comments.
  - The Worker serves bundle assets only to a signed-in user who currently has **read access to the repo**, re-checked per session.
  - Screenshots, traces and mailbox output can contain real-looking data. Treat them like source.

## `dub.json` (sketch)
```json
{
  "version": 0,
  "bundle_id": "01HX7Q…",
  "repo": "ryan-anson/missive", "pr": 87, "sha": "a1b2c3d",
  "runner": "ghcr.io/dubtheedev/runner@sha256:…",
  "preview": { "url": "https://missive-pr-87.fly.dev", "preview_sha": "a1b2c3d", "moved": false },
  "previous": { "sha": "9f8e7d6", "bundle_id": "01HX6…", "verdict": "revise", "seq": 3 },
  "brief": {
    "path": ".dub/briefs/invoice-reminders.md",
    "text": "# Send a reminder when an invoice is 7 days overdue\n…",
    "first_seen_sha": "7a6b5c4",
    "before_implementation": "unknown",
    "criteria_diff": [{ "id": "ac-2", "change": "edited", "from": "…", "to": "…" }]
  },
  "author": { "kind": "agent", "agent": "claude-code", "session": "…" },
  "notes": { "did": ["…"], "didnt": ["…"], "unsure": ["Timezone of the 7-day cutoff"] },
  "criteria": [
    { "id": "ac-1", "kind": "visual", "status": "pass",
      "assertions": ["goto /invoices", "expect badge 'Reminder sent' visible"],
      "spec": { "source": "/* spec + inlined helpers */ …", "external_imports": ["@playwright/test"], "changed": false },
      "evidence": [{ "type": "image", "path": "ac-1/list.png", "hash": "sha256:…", "artifact_changed": true }] },
    { "id": "ac-3", "kind": "behaviour", "status": "error", "error": "Timeout 30000ms waiting for /dev/mailbox",
      "spec": { "source": "…", "changed": true },
      "evidence": [{ "type": "video", "path": "ac-3/flow.webm", "hash": "sha256:…" }] },
    { "id": "ac-4", "kind": "judgment", "status": "none",
      "evidence": [{ "type": "image", "path": "ac-4/email-vs-existing.png", "role": "supporting" }] }
  ],
  "rubric": { "base_sha": "…", "hits": ["…"], "branch_proposals": [] },
  "diff": { "files": 9, "additions": 312, "deletions": 40, "areas": ["email", "invoices"] }
}
```

## Rubric (editorial, not automatic)
- **The base branch is authoritative.** Edits on a PR branch show up as proposals only.
- **Rule format:** the rule, its scope (areas), the rationale, and a source link.
- **Areas** come from explicit path globs in `.dub/areas.yml`.
- **A rejection note isn't a rule.** "Suggest as rule" captures it; a human generalises it before merging.
- **Pilot:** edit the rubric by hand.

## Components (pilot scope)
1. **`dub` CLI** (Go)
   - `dub init`
   - `dub pack --preview <url>`: warm-up, SHA verify before and after, runner with `workers: 1`, inline the brief, provenance, specs **with local imports**, and rubric hits; hashes and diffs; new `bundle_id`
   - `dub publish`: upload through the Worker, authenticated with OIDC
2. **Runner:** a CI container image only (`ghcr.io/dubtheedev/runner`), with its pinned digest recorded in the bundle.
3. **Agent skill:** read the base-branch rubric; write the brief (early is encouraged); idempotent, interruption-safe specs; did / didn't / unsure.
4. **CI integration (Missive):**
   - Deploy and capture run in **the same job**, under one concurrency group: `concurrency: { group: dub-pr-${{ github.event.pull_request.number }}, cancel-in-progress: true }`. The next deploy can't change the preview while a capture is running in the same pipeline.
   - Cancellation isn't instant and doesn't stop a Fly deploy that's already underway, so the before/after SHA checks stay as the backstop.
5. **Review Worker + one Durable Object per PR + one GitHub App:**
   - serves the page and bundles (access-checked)
   - accepts bundle uploads (OIDC)
   - holds verdict events and delivery state
   - reconciler on alarms
   - webhooks: `pull_request.reopened` and `synchronize`
   - **only Reject can close a PR**, and only under the eligibility rules
6. **Review page:** Ryan's.

## Review page (starting sketch, for Ryan to blow up)

```
┌──────────────────────────────────────────────────────────────────────┐
│ #87 Invoice reminders  a1b2c3d · bundle 01HX7Q  prev: revise   [Preview ↗]│
│ ⚠ Live preview runs b4c5d6e (differs from this bundle)               │
│ ✎ Criteria edited since last verdict: ac-2 · brief order: unknown   │
├───────────────────────────┬──────────────────────────────────────────┤
│ BRIEF                     │ ac-1 Badge in invoice list     [visual] │
│ Why: customers forget…    │  [ screenshot ]  artifact changed        │
│                           │  ✓ Assertions passed ▸ 2 assertions      │
│ Agent says:               │ ac-2 Reminder email            [visual] │
│  did / didn't …           │  ✎ criterion edited  ▸ diff              │
│  unsure: timezone cutoff  │ ac-3 No double send         [behaviour] │
│                           │  ⚠ Couldn't complete: timeout ▸ spec     │
│ Rubric (email):           │ ac-4 Copy tone               [judgment] │
│  · plain tone, no "!"     │  [ new vs existing email ] supporting    │
├───────────────────────────┴──────────────────────────────────────────┤
│ ▸ Diff (9 files, +312 −40) — collapsed · code review is separate     │
├──────────────────────────────────────────────────────────────────────┤
│ [ Dub it ]  [ Revise ▾ ]  [ Reject ▾ ]   note: ___  ☐ suggest as rule│
│ Also used (any):  ☐ preview  ☐ local checkout  ☐ other tool (logs, DB…)│
│ Because (any):    ☐ couldn't judge product here  ☐ checked implementation│
│                   ☐ evidence/preview broken                          │
└──────────────────────────────────────────────────────────────────────┘
```
- **Pilot:** one overall verdict plus optional notes per criterion.
- **Opening the preview is an intended flow, not a failure.** It's recorded so you can see how much the bundle alone carries.
- Criterion edits and provenance sit at the top. Provenance can say "unknown".

## Missive specifics
- **Previews:** `flyctl deploy` in a `pull_request` job; Fly + Neon; the Neon branch persists per PR.
- **New Missive endpoints:** `/__dub/version` (the deployed SHA) and `/dev/reset`. Existing: four seeded accounts, `/dev/mailbox`, `/dev/deliver`.
- Fly machines scale to zero, so `dub pack` warms up first.
- Agent PRs open as the Dub GitHub App, so either human can do the code-review approval.

## Branch protection
- **Required:** `dubbed` (source: the Dub App) **and** 1 approving review (code review).
- **Dismiss stale reviews: ON.** The approval is the code gate; `dubbed` is SHA-pinned separately. Revisit if the friction is bad.

## The pilot

**Step 0: hand-made review sessions, before any integration work.**
- Take one real agent PR on Missive.
- Hand-assemble a bundle (brief, screenshots, a video, assertion lists with helper code, agent notes) and a static review page. Use the existing preview as-is.
- Ryan reviews it while Anson watches. Record:
  - whether he could confidently decide product acceptance
  - what else he opened, and why (same categories as the page)
- Repeat on 2–3 PRs. **The build plan comes from what makes him leave.**
- None of the endpoints, the runner image, the App or the authorship change are needed for this.

**Then, two weeks of real use** (if step 0 holds up):
- **Rule:** every agent PR gets a bundle; product acceptance happens from the page.
- **Measure:**
  - **Product checkout rate:** verdicts where *local checkout* or *other tool* was used **because** *"couldn't judge product here"* ÷ verdicts. This is the core promise; target under 30%.
  - **Preview reliance:** share of verdicts that used the preview. Expected; it shows how much the bundle carries alone.
  - **Other reasons:** "checked implementation" (expected; that's code review) and "evidence/preview broken" (a reliability bug).
  - **Active bundle-page time,** plus a one-tap self-report of total review time (preview time isn't tracked reliably).
  - Revise rounds per PR; error rate per criterion; capture reruns per SHA.
  - **Rule recurrence:** how often a specific merged rule is cited again.
  - **Gut check:** would we be annoyed if it went away?
- **Two weeks can show whether the review surface is useful. It can't show a moat.**
- **Kill if:** the product checkout rate stays high after fixing what step 0 surfaced.

## Build order
0. **Hand-made bundle and review sessions with Ryan.**
1. **Unblockers:** Missive `/__dub/version` and `/dev/reset`; runner container image; register the GitHub App; move agent PR authorship to it; `.dub/config.yml` reviewer list.
2. `dub pack` and `dub publish` (OIDC), wired into the review-app job with one concurrency group.
3. Worker + Durable Object: bundle intake, access-checked serving, verdict events, delivery state, reconciler, webhooks, App OAuth.
4. Review page v1 (Ryan; it grows out of the step 0 static page).
5. Manual rubric workflow plus "suggest as rule".

**Budget:** step 0 is an evening or two. Step 1 is a weekend. Steps 2–4 are realistically 2–3 more weekends; the Durable Object and delivery rules are the part not to rush.

## Out of scope (pilot)
- Local runner distribution
- Automated rubric-PR management
- Per-criterion verdicts
- Multiple reviewer identities in practice (the model supports them)
- A generic Action
- Automated "weakening" detection
- Hosted multi-tenant SaaS
- AI pre-review
- Non-web projects
- Linear integration
- Non-GitHub hosts
- A `dub seed` hook

## Later / sequence
- **Bag of Holding as "try it":** a workspace snapshot pins the *code and workspace* the agent ran. It cuts preview drift a lot but doesn't pin the database or external services, which would still need fixtures or snapshots of their own.
- Open bundle format plus CLI as the open-source wedge; the hosted review surface, team rubrics and audit trail are paid. Distribution through the GitHub Marketplace.
- "Brief confirmed by a human before implementation" as an explicit act, not inferred from git.
- Rubric analytics per rule.

## Decisions log
- **Product acceptance, not merge assurance.** Dub posts COMMENT, never APPROVE.
- **Bundles live in R2; verdicts and delivery state live in a per-PR Durable Object.** Verdict events are immutable; delivery state is mutable.
- **Effective verdict:** the highest `seq` for the SHA. **Status only ever comes from the effective verdict.**
- **PR-wide effects** get fresh eligibility checks; a **Reject never closes a PR that was reopened after it.**
- **Bundles have their own identity,** with several per SHA. **A newer bundle doesn't invalidate an existing acceptance;** a regression is flagged, not acted on.
- **Deploy and capture share one concurrency group;** Playwright uses one worker; specs are interruption-safe; the before/after SHA checks stay.
- **CI uploads, never approves;** OIDC to the Worker. Only the Worker, for an authorised reviewer, writes success or failure on `dubbed`.
- **Bundles are as private as the repo.**
- **Dismiss stale reviews: ON.**
- **Brief provenance is a heuristic** with an `unknown` state. Every criterion edit is flagged.

## Open questions
**For Ryan (design):**
- First screen: criteria grid, preview-first, or a "story" scroll?
- How loud should "criteria edited", "preview SHA differs" and "newer capture exists" be?
- How much assertion and helper detail to show by default?
- The leave-the-bundle checkboxes: how do you capture them without them becoming a chore on every verdict?

**For Anson (engineering):**
- `/__dub/version` as an endpoint vs a header in Phoenix: which is easiest to keep correct?
- Inlining spec imports: bundle them with esbuild, or copy the files verbatim (easier to read, less faithful)?
- Durable Object reconciler backoff and the give-up policy (when does a stuck delivery alert a human?).
