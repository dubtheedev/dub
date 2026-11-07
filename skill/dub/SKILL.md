---
name: dub
description: Write a dub request for agent-written work — the brief with stable acceptance criteria, Playwright evidence specs under .dub/evidence, the did/didn't/unsure notes — then pack it against a preview and open the PR with `dub pr`. Use whenever you start a task in a repo that has a .dub/ directory.
---

# Dub: brief first, evidence per criterion, human verdict

A human product-accepts your PR from a review page that shows the brief, one
piece of evidence per acceptance criterion, the live preview and the diff. Your
job is to make that page tell the truth. You never grade yourself.

## 1. Before you write code

- Read `.dub/rubric.md` **on the base branch** (`git show origin/main:.dub/rubric.md`).
  Rules there apply to your change if its area (see `.dub/areas.yml`) matches.
- Read `.dub/config.yml` for the base branch and reviewers.
- Write the brief **now**, before the implementation, and commit it on its own.
  Git history is how the reviewer sees the brief came first.

## 2. The brief: `.dub/briefs/<slug>.md`

```markdown
---
id: invoice-reminders        # must equal the file slug
issue: MIS-142               # optional
---
# Send a reminder when an invoice is 7 days overdue

**Why:** customers forget; we chase manually.

## Acceptance
- [ac-1] Overdue invoice (7d) shows a "Reminder sent" badge in the invoice list   {kind: visual}
- [ac-2] Reminder email renders with the invoice link and amount                   {kind: visual}
- [ac-3] No reminder is sent twice for the same invoice                             {kind: behaviour}
- [ac-4] Copy tone matches existing emails                                           {kind: judgment}

## Notes
**Did:**
- Added the badge and the daily reminder job
**Didn't:**
- Timezone handling for the cutoff; it uses UTC
**Unsure:**
- Whether "7 days" should count from due date or from send date
```

Rules:
- 3–6 criteria. Each is one observable thing the human can accept or refuse.
- Kinds: `visual` (a screenshot shows it), `behaviour` (a flow asserts it),
  `check` (a cheap automated check), `judgment` (only a human can decide).
- **Ids are stable.** `ac-1` keeps its id for the life of the PR. Never renumber,
  never reuse an id for a different criterion. Add `ac-7` for a new one; delete
  a line to drop one. Every edit is flagged to the reviewer, so edit on purpose.
- Fill `## Notes` honestly as you go. "Unsure" is the most useful list.
- `dub pack` refuses a brief with zero criteria, a duplicate id, an unknown kind,
  or an id that doesn't match `^[a-z][a-z0-9-]*$`.

## 3. Evidence specs: `.dub/evidence/<slug>.spec.ts`

One `test('<criterion id>', …)` per criterion. The title **is** the id. Import
from `@dub/test`, never `@playwright/test`; the runner provides it, the repo
installs nothing.

```ts
import { test, expect } from '@dub/test';
import { signIn } from './helpers';   // relative imports are inlined into the bundle

test.beforeAll(async ({ request }) => {
  // Only when you need a clean slate. The re-seed takes 20–30s on a review
  // app, longer than Playwright's default 30s hook timeout.
  test.setTimeout(120_000);
  await request.post('/dev/reset', { timeout: 120_000 });
});

test('ac-1', async ({ page }) => {
  await signIn(page, 'amackera@gmail.com');
  await test.step('open the invoice list', async () => {
    await page.goto('/invoices');
  });
  await test.step('the overdue invoice shows the badge', async () => {
    await expect(page.getByRole('row', { name: /INV-7/ }).getByText('Reminder sent')).toBeVisible();
  });
  await page.screenshot({ path: test.info().outputPath('list.png'), fullPage: true });
  await test.info().attach('list', { path: test.info().outputPath('list.png'), contentType: 'image/png' });
});

test('ac-3', async ({ page, request }) => {
  await test.step('run delivery twice', async () => {
    await request.get('/dev/deliver');
    await request.get('/dev/deliver');
  });
  await page.goto('/dev/mailbox');
  await expect(page.getByText('Reminder: INV-7')).toHaveCount(1);
});

// Judgment: supporting artifact only. NO expect() here — a failed expect in a
// judgment spec is reported as `error`, never as evidence.
test('ac-4', async ({ page }) => {
  await page.goto('/dev/mailbox');
  await page.screenshot({ path: test.info().outputPath('email.png') });
  await test.info().attach('email', { path: test.info().outputPath('email.png'), contentType: 'image/png' });
});
```

Rules:
- **Judgment specs never assert.** Capture; don't `expect`.
- Use `test.step` for every meaningful action. Step titles are the "assertions"
  list the reviewer reads next to the screenshot. Make them sentences.
- Attach what the reviewer should see with `test.info().attach(...)`. Video and
  trace are recorded automatically.
- Specs must be **idempotent and safe from a half-mutated state**: the preview
  database persists across pushes and an interrupted run doesn't undo its
  fixtures. Create what you need in the spec; reset in `beforeAll`, never in an
  `afterAll` you may never reach.
- One worker, no retries. A flaky spec is a finding, not a retry.
- Don't assert on anything a human needs to judge; put it under a `judgment`
  criterion instead.

Missive previews: accounts `amackera@gmail.com`, `ryanwsnow@gmail.com`,
`anson@deeptree.com`, `ryan@deeptree.com`, password `review_password_123`.
Dev endpoints: `/dev/mailbox` (sent mail), `/dev/deliver` (force delivery),
`/dev/reset` (truncate and re-seed), `/__dub/version` (deployed SHA).

## 4. Dry run and PR

```sh
dub pack --preview https://pr-<n>-misiva.fly.dev --repo deeptreecorp/missive --pr <n>
```

It refuses if the preview isn't running HEAD. Read the per-criterion statuses it
prints; `error` means the spec couldn't complete, which is your bug or a
capture problem, not evidence either way. Fix and rerun. CI runs the same
command after every deploy and publishes the bundle; you don't publish by hand.

Push the branch as yourself, then open the PR as the Dub App so either human
can approve the code:

```sh
git push -u origin HEAD
dub pr --title "Send invoice reminders at 7 days" --body "Brief: .dub/briefs/invoice-reminders.md"
```

## 5. After a Revise

Read the reviewer's note on the PR review. Keep the criterion ids. Update the
brief only if what was asked changed, and say so in `## Notes`. Push; the next
bundle is captured automatically.
