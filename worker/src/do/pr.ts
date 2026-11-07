// One Durable Object per pull request. Every write for a PR goes through this
// single-threaded object: seq comes from one counter, verdict events are
// append-only, delivery state is mutable, alarms drive the reconciler.
import { DurableObject } from 'cloudflare:workers';
import type { BundleRow, Delivery, DeliveryState, Effect, Env, PRState, Verdict, VerdictEvent } from '../types';
import { AppAuth, GitHub, GitHubError } from '../lib/github';
import {
  PENDING_BUNDLE_DESCRIPTION,
  STICKY_MARK,
  closeEligible,
  effectiveVerdict,
  nextBackoff,
  reviewBody,
  shouldGiveUp,
  statusFor,
  stickyBody,
} from '../lib/verdicts';

export interface PRId {
  owner: string;
  repo: string;
  number: number;
}

export interface WebhookInput {
  action: 'opened' | 'synchronize' | 'reopened' | 'closed' | 'edited' | string;
  head_sha: string;
  author: string;
  open: boolean;
}

export interface BundleInput {
  bundle_id: string;
  sha: string;
  received_at: string;
  criteria: { id: string; status: string }[];
}

export interface VerdictInput {
  sha: string;
  bundle_id: string;
  reviewer: string;
  verdict: Verdict;
  note?: string;
  suggest_rule?: boolean;
  used: string[];
  because: string[];
  /** The reviewer's user-to-server token, for the human-credentialed review. */
  user_token: string;
}

export interface SubmitResult {
  seq: number;
  effective: { sha: string; verdict: Verdict; seq: number } | null;
  head_sha: string | null;
  historical: boolean;
  review: 'posted' | 'on_behalf_pending';
}

export interface FullState {
  pr: PRState;
  verdicts: VerdictEvent[];
  deliveries: (Delivery & { sha: string })[];
  bundles: (BundleRow & { criteria: { id: string; status: string }[] })[];
}

type InternalEffect = Effect;

interface DeliveryRow {
  seq: number;
  effect: InternalEffect;
  sha: string;
  state: DeliveryState;
  attempts: number;
  next_at: number | null;
  first_at: number;
  gh_id: number | null;
  last_error: string | null;
}

const REVIEW_ATTEMPTS = 3;

export class PullRequest extends DurableObject<Env> {
  private gh: GitHub;
  private app: AppAuth;
  /** Overridable for tests. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gh = new GitHub();
    this.app = new AppAuth({ appId: env.GITHUB_APP_ID ?? '', privateKey: env.GITHUB_APP_PRIVATE_KEY ?? '' });
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pr (
      k INTEGER PRIMARY KEY CHECK (k = 1),
      owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      head_sha TEXT, author TEXT, open INTEGER NOT NULL DEFAULT 1,
      reopen_seq INTEGER NOT NULL DEFAULT 0, closed_at TEXT, sticky_comment_id INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS verdicts (
      seq INTEGER PRIMARY KEY, sha TEXT NOT NULL, bundle_id TEXT NOT NULL, reviewer TEXT NOT NULL,
      verdict TEXT NOT NULL, reason TEXT, note TEXT, used TEXT NOT NULL, because TEXT NOT NULL,
      at TEXT NOT NULL, on_behalf INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      seq INTEGER NOT NULL, effect TEXT NOT NULL, sha TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, first_at INTEGER NOT NULL,
      gh_id INTEGER, last_error TEXT, PRIMARY KEY (seq, effect, sha))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS bundles (
      bundle_id TEXT PRIMARY KEY, sha TEXT NOT NULL, received_at TEXT NOT NULL, criteria TEXT NOT NULL)`);
  }

  // ---- identity -----------------------------------------------------------

  private ensurePR(id: PRId): PRState {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO pr (k, owner, repo, number) VALUES (1, ?, ?, ?) ON CONFLICT (k) DO NOTHING`,
      id.owner,
      id.repo,
      id.number,
    );
    return this.pr();
  }

  private pr(): PRState {
    const row = this.ctx.storage.sql.exec(`SELECT * FROM pr WHERE k = 1`).toArray()[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('PR not initialised');
    return {
      owner: row.owner as string,
      repo: row.repo as string,
      number: row.number as number,
      head_sha: (row.head_sha as string | null) ?? null,
      author: (row.author as string | null) ?? null,
      open: Boolean(row.open),
      reopen_seq: row.reopen_seq as number,
      closed_at: (row.closed_at as string | null) ?? null,
    };
  }

  private stickyCommentId(): number | null {
    const row = this.ctx.storage.sql.exec(`SELECT sticky_comment_id FROM pr WHERE k = 1`).toArray()[0];
    return (row?.sticky_comment_id as number | null) ?? null;
  }

  // ---- reads --------------------------------------------------------------

  private verdicts(): VerdictEvent[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM verdicts ORDER BY seq`)
      .toArray()
      .map((r) => ({
        seq: r.seq as number,
        sha: r.sha as string,
        bundle_id: r.bundle_id as string,
        reviewer: r.reviewer as string,
        verdict: r.verdict as Verdict,
        reason: (r.reason as string | null) ?? undefined,
        note: (r.note as string | null) ?? undefined,
        used: JSON.parse(r.used as string),
        because: JSON.parse(r.because as string),
        at: r.at as string,
        on_behalf: Boolean(r.on_behalf),
      }));
  }

  private bundles(): (BundleRow & { criteria: { id: string; status: string }[] })[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM bundles ORDER BY received_at DESC`)
      .toArray()
      .map((r) => ({
        bundle_id: r.bundle_id as string,
        sha: r.sha as string,
        received_at: r.received_at as string,
        criteria: JSON.parse(r.criteria as string),
      }));
  }

  private deliveries(where = '', ...args: unknown[]): DeliveryRow[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM deliveries ${where} ORDER BY first_at, seq`, ...(args as SqlStorageValue[]))
      .toArray()
      .map((r) => ({
        seq: r.seq as number,
        effect: r.effect as InternalEffect,
        sha: r.sha as string,
        state: r.state as DeliveryState,
        attempts: r.attempts as number,
        next_at: (r.next_at as number | null) ?? null,
        first_at: r.first_at as number,
        gh_id: (r.gh_id as number | null) ?? null,
        last_error: (r.last_error as string | null) ?? null,
      }));
  }

  async state(id: PRId): Promise<FullState> {
    this.ensurePR(id);
    return { pr: this.pr(), verdicts: this.verdicts(), deliveries: this.deliveries(), bundles: this.bundles() };
  }

  // ---- writes -------------------------------------------------------------

  async recordWebhook(id: PRId, w: WebhookInput): Promise<void> {
    this.ensurePR(id);
    const sql = this.ctx.storage.sql;
    const now = this.now();
    switch (w.action) {
      case 'opened':
      case 'synchronize': {
        sql.exec(`UPDATE pr SET head_sha = ?, author = ?, open = 1 WHERE k = 1`, w.head_sha, w.author);
        // The head moved: a pending status with a link tells the human what's
        // happening during the deploy window (feedback: smaller gaps, 1).
        this.enqueue(0, 'pending_status', w.head_sha, now);
        this.enqueue(0, 'sticky', w.head_sha, now);
        await this.runPending(now);
        break;
      }
      case 'reopened': {
        const maxSeq = this.maxSeq();
        sql.exec(
          `UPDATE pr SET head_sha = ?, author = ?, open = 1, closed_at = NULL, reopen_seq = ? WHERE k = 1`,
          w.head_sha,
          w.author,
          maxSeq,
        );
        this.enqueue(0, 'pending_status', w.head_sha, now);
        await this.runPending(now);
        break;
      }
      case 'closed': {
        sql.exec(`UPDATE pr SET open = 0, closed_at = ? WHERE k = 1`, new Date(now).toISOString());
        sql.exec(`UPDATE deliveries SET state = 'superseded' WHERE state = 'pending'`);
        await this.ctx.storage.deleteAlarm();
        break;
      }
      default: {
        if (w.head_sha) sql.exec(`UPDATE pr SET head_sha = ?, author = ?, open = ? WHERE k = 1`, w.head_sha, w.author, w.open ? 1 : 0);
      }
    }
  }

  async recordBundle(id: PRId, b: BundleInput): Promise<{ head_at_intake: boolean; has_verdict: boolean }> {
    const pr = this.ensurePR(id);
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO bundles (bundle_id, sha, received_at, criteria) VALUES (?, ?, ?, ?)
       ON CONFLICT (bundle_id) DO UPDATE SET criteria = excluded.criteria`,
      b.bundle_id,
      b.sha,
      b.received_at,
      JSON.stringify(b.criteria),
    );
    const hasVerdict = effectiveVerdict(this.verdicts(), b.sha) !== null;
    const now = this.now();
    // Sets `dubbed: pending` if there's no verdict for that SHA; the effect
    // itself re-checks, so a verdict landing in between is not overwritten.
    if (!hasVerdict) this.enqueue(0, 'pending_status', b.sha, now);
    // Only the head's newest bundle may take over the sticky comment.
    if (pr.head_sha === b.sha || pr.head_sha === null) this.enqueue(0, 'sticky', b.sha, now);
    await this.runPending(now);
    return { head_at_intake: pr.head_sha === b.sha, has_verdict: hasVerdict };
  }

  /** Returns `{error}` (not a rejection) when the bundle doesn't match the SHA. */
  async submitVerdict(id: PRId, v: VerdictInput): Promise<SubmitResult | { error: string }> {
    const pr = this.ensurePR(id);
    const sql = this.ctx.storage.sql;
    const bundle = sql.exec(`SELECT sha FROM bundles WHERE bundle_id = ?`, v.bundle_id).toArray()[0];
    if (!bundle) return { error: `unknown bundle ${v.bundle_id}` };
    if (bundle.sha !== v.sha) return { error: `bundle ${v.bundle_id} belongs to ${bundle.sha}, not ${v.sha}` };

    const now = this.now();
    const seq = this.maxSeq() + 1;
    const event: VerdictEvent = {
      seq,
      sha: v.sha,
      bundle_id: v.bundle_id,
      reviewer: v.reviewer,
      verdict: v.verdict,
      reason: v.suggest_rule ? 'suggest_rule' : undefined,
      note: v.note,
      used: v.used ?? [],
      because: v.because ?? [],
      at: new Date(now).toISOString(),
    };
    // Commit point.
    sql.exec(
      `INSERT INTO verdicts (seq, sha, bundle_id, reviewer, verdict, reason, note, used, because, at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      seq,
      event.sha,
      event.bundle_id,
      event.reviewer,
      event.verdict,
      event.reason ?? null,
      event.note ?? null,
      JSON.stringify(event.used),
      JSON.stringify(event.because),
      event.at,
    );

    // Human-credentialed effect: short synchronous retry, then the App posts
    // on the reviewer's behalf (contract decision 3).
    let review: SubmitResult['review'] = 'posted';
    const body = reviewBody(event, this.pageUrl(pr, event.sha));
    let reviewId: number | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= REVIEW_ATTEMPTS && reviewId === null; attempt++) {
      try {
        const r = await this.gh.createReview(v.user_token, pr.owner, pr.repo, pr.number, body, event.sha);
        reviewId = r.id;
      } catch (e) {
        lastErr = String((e as Error).message ?? e);
        if (e instanceof GitHubError && e.status >= 400 && e.status < 500 && e.status !== 429) break;
        if (attempt < REVIEW_ATTEMPTS) await this.sleep(500 * attempt);
      }
    }
    if (reviewId !== null) {
      sql.exec(
        `INSERT INTO deliveries (seq, effect, sha, state, attempts, next_at, first_at, gh_id, last_error) VALUES (?,?,?,'done',1,NULL,?,?,NULL)`,
        seq,
        'review',
        event.sha,
        now,
        reviewId,
      );
    } else {
      review = 'on_behalf_pending';
      sql.exec(`UPDATE verdicts SET on_behalf = 1 WHERE seq = ?`, seq);
      sql.exec(
        `INSERT INTO deliveries (seq, effect, sha, state, attempts, next_at, first_at, gh_id, last_error) VALUES (?,?,?,'pending',0,?,?,NULL,?)`,
        seq,
        'review',
        event.sha,
        now,
        now,
        lastErr || 'human review failed',
      );
    }

    // App-credentialed effects go through the reconciler.
    this.enqueue(seq, 'status', event.sha, now);
    if (event.verdict === 'reject') this.enqueue(seq, 'close', event.sha, now);
    this.enqueue(seq, 'sticky', event.sha, now);
    await this.runPending(now);

    const after = this.pr();
    const eff = effectiveVerdict(this.verdicts(), event.sha);
    return {
      seq,
      effective: eff ? { sha: eff.sha, verdict: eff.verdict, seq: eff.seq } : null,
      head_sha: after.head_sha,
      historical: after.head_sha !== null && after.head_sha !== event.sha,
      review,
    };
  }

  // ---- reconciler ---------------------------------------------------------

  async alarm(): Promise<void> {
    await this.runPending(this.now());
  }

  private maxSeq(): number {
    const r = this.ctx.storage.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS m FROM verdicts`).toArray()[0];
    return (r?.m as number) ?? 0;
  }

  /**
   * Seq-0 effects (pending_status, sticky) are idempotent refreshes and are
   * re-armed even when an earlier run finished; a pending one keeps its
   * backoff window.
   */
  private enqueue(seq: number, effect: InternalEffect, sha: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO deliveries (seq, effect, sha, state, attempts, next_at, first_at, gh_id, last_error)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, NULL)
       ON CONFLICT (seq, effect, sha) DO UPDATE SET state = 'pending', next_at = excluded.next_at,
         first_at = CASE WHEN deliveries.state = 'pending' THEN deliveries.first_at ELSE excluded.first_at END,
         attempts = CASE WHEN deliveries.state = 'pending' THEN deliveries.attempts ELSE 0 END`,
      seq,
      effect,
      sha,
      now,
      now,
    );
  }

  private async runPending(now: number): Promise<void> {
    const due = this.deliveries(`WHERE state = 'pending' AND next_at IS NOT NULL AND next_at <= ?`, now);
    for (const d of due) {
      let outcome: 'done' | 'superseded';
      try {
        outcome = await this.apply(d);
      } catch (e) {
        const msg = String((e as Error).message ?? e).slice(0, 500);
        const attempts = d.attempts + 1;
        if (shouldGiveUp(d.first_at, now)) {
          this.ctx.storage.sql.exec(
            `UPDATE deliveries SET state = 'failed', attempts = ?, next_at = NULL, last_error = ? WHERE seq = ? AND effect = ? AND sha = ?`,
            attempts,
            msg,
            d.seq,
            d.effect,
            d.sha,
          );
          // A give-up is itself news for the sticky comment and the page.
          if (d.effect !== 'sticky') this.enqueue(0, 'sticky', this.pr().head_sha ?? d.sha, now + 1);
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE deliveries SET attempts = ?, next_at = ?, last_error = ? WHERE seq = ? AND effect = ? AND sha = ?`,
            attempts,
            now + nextBackoff(attempts),
            msg,
            d.seq,
            d.effect,
            d.sha,
          );
        }
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE deliveries SET state = ?, attempts = attempts + 1, next_at = NULL, last_error = NULL WHERE seq = ? AND effect = ? AND sha = ?`,
        outcome,
        d.seq,
        d.effect,
        d.sha,
      );
    }
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const r = this.ctx.storage.sql.exec(`SELECT MIN(next_at) AS t FROM deliveries WHERE state = 'pending'`).toArray()[0];
    const t = (r?.t as number | null) ?? null;
    if (t === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(t, this.now() + 1000));
  }

  private pageUrl(pr: PRState, sha?: string): string {
    const base = `${this.env.PUBLIC_URL}/r/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    return sha ? `${base}?sha=${sha}` : base;
  }

  private async token(pr: PRState): Promise<string> {
    return this.app.installationToken(pr.owner, pr.repo, this.now());
  }

  /** Applies one delivery with a fresh eligibility check. Throws to retry. */
  private async apply(d: DeliveryRow): Promise<'done' | 'superseded'> {
    const pr = this.pr();
    const events = this.verdicts();
    switch (d.effect) {
      case 'pending_status': {
        if (effectiveVerdict(events, d.sha)) return 'superseded';
        const hasBundle = this.bundles().some((b) => b.sha === d.sha);
        const description = hasBundle ? statusFor(null).description : PENDING_BUNDLE_DESCRIPTION;
        await this.gh.setStatus(await this.token(pr), pr.owner, pr.repo, d.sha, {
          state: 'pending',
          description,
          target_url: this.pageUrl(pr, d.sha),
        });
        return 'done';
      }
      case 'status': {
        // Only from the current effective verdict for that SHA. A delayed
        // retry of an earlier Dub it can't reopen the gate after a Revise.
        const eff = effectiveVerdict(events, d.sha);
        if (!eff || eff.seq !== d.seq) return 'superseded';
        const s = statusFor(eff.verdict, eff.reviewer);
        await this.gh.setStatus(await this.token(pr), pr.owner, pr.repo, d.sha, { ...s, target_url: this.pageUrl(pr, d.sha) });
        return 'done';
      }
      case 'close': {
        const ev = events.find((e) => e.seq === d.seq);
        if (!ev || !closeEligible(ev, events, pr)) return 'superseded';
        await this.gh.closePR(await this.token(pr), pr.owner, pr.repo, pr.number);
        this.ctx.storage.sql.exec(`UPDATE pr SET open = 0, closed_at = ? WHERE k = 1`, new Date(this.now()).toISOString());
        return 'done';
      }
      case 'sticky': {
        // Only for the head SHA's newest bundle: fresh head check at execution.
        if (pr.head_sha && d.sha !== pr.head_sha) return 'superseded';
        const head = pr.head_sha ?? d.sha;
        const bundles = this.bundles().filter((b) => b.sha === head);
        const newest = bundles[0] ?? null;
        const eff = effectiveVerdict(events, head);
        const failed = this.deliveries(`WHERE state = 'failed'`).map((f) => ({ effect: f.effect, last_error: f.last_error }));
        const body = stickyBody({
          head_sha: head,
          bundle_id: newest?.bundle_id ?? null,
          page_url: this.pageUrl(pr, head),
          effective: eff,
          newer_bundle_exists: Boolean(eff && newest && newest.bundle_id !== eff.bundle_id),
          failed_deliveries: failed,
          criteria: newest?.criteria,
        });
        const tok = await this.token(pr);
        let cid = this.stickyCommentId() ?? (await this.gh.findComment(tok, pr.owner, pr.repo, pr.number, STICKY_MARK));
        if (cid !== null) {
          try {
            await this.gh.updateComment(tok, pr.owner, pr.repo, cid, body);
          } catch (e) {
            if (!(e instanceof GitHubError && e.status === 404)) throw e;
            cid = null;
          }
        }
        if (cid === null) cid = (await this.gh.createComment(tok, pr.owner, pr.repo, pr.number, body)).id;
        this.ctx.storage.sql.exec(`UPDATE pr SET sticky_comment_id = ? WHERE k = 1`, cid);
        return 'done';
      }
      case 'review': {
        // App fallback: the human's token failed three times at submission.
        const ev = events.find((e) => e.seq === d.seq);
        if (!ev) return 'superseded';
        const later = events.some((e) => e.sha === ev.sha && e.seq > ev.seq);
        const body = reviewBody(ev, this.pageUrl(pr, ev.sha), { onBehalfOf: ev.reviewer, superseded: later });
        const tok = await this.token(pr);
        if (d.gh_id !== null) {
          await this.gh.updateReview(tok, pr.owner, pr.repo, pr.number, d.gh_id, body);
          return 'done';
        }
        const r = await this.gh.createReview(tok, pr.owner, pr.repo, pr.number, body, ev.sha);
        this.ctx.storage.sql.exec(`UPDATE deliveries SET gh_id = ? WHERE seq = ? AND effect = ? AND sha = ?`, r.id, d.seq, d.effect, d.sha);
        return 'done';
      }
    }
  }
}
