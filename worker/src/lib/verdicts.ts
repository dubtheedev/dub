// Pure rules from the spec's "Verdicts: storage, ordering, reconciliation".
import type { Verdict, VerdictEvent } from '../types';

/** The effective verdict for a SHA is the event with the highest seq for it. */
export function effectiveVerdict(events: VerdictEvent[], sha: string): VerdictEvent | null {
  let best: VerdictEvent | null = null;
  for (const e of events) {
    if (e.sha !== sha) continue;
    if (!best || e.seq > best.seq) best = e;
  }
  return best;
}

export interface CloseCheck {
  head_sha: string | null;
  open: boolean;
  reopen_seq: number;
}

/**
 * A Reject closes the PR only if, at execution time, it is still the
 * effective verdict for its SHA, that SHA is still the head, the PR is open,
 * and no reopen happened after this event's seq (reopen boundary).
 */
export function closeEligible(event: VerdictEvent, events: VerdictEvent[], pr: CloseCheck): boolean {
  if (event.verdict !== 'reject') return false;
  const eff = effectiveVerdict(events, event.sha);
  if (!eff || eff.seq !== event.seq) return false;
  if (pr.head_sha !== event.sha) return false;
  if (!pr.open) return false;
  if (event.seq <= pr.reopen_seq) return false;
  return true;
}

export type StatusState = 'pending' | 'success' | 'failure';

export function statusFor(verdict: Verdict | null, reviewer?: string): { state: StatusState; description: string } {
  switch (verdict) {
    case 'dub':
      return { state: 'success', description: `Dubbed by @${reviewer ?? 'reviewer'}` };
    case 'revise':
      return { state: 'failure', description: `Revise — @${reviewer ?? 'reviewer'}` };
    case 'reject':
      return { state: 'failure', description: `Rejected by @${reviewer ?? 'reviewer'}` };
    default:
      return { state: 'pending', description: 'Awaiting product acceptance' };
  }
}

export const PENDING_BUNDLE_DESCRIPTION = 'Waiting for evidence bundle';

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/** 30s doubling per attempt, capped at one hour. `attempts` is the count already made (≥1). */
export function nextBackoff(attempts: number): number {
  const n = Math.max(1, attempts);
  const ms = BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
}

export function shouldGiveUp(firstAttemptAt: number, now: number): boolean {
  return now - firstAttemptAt >= GIVE_UP_AFTER_MS;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  dub: 'Dub it',
  revise: 'Revise',
  reject: 'Reject',
};

export const USED_OPTIONS: Record<string, string> = {
  preview: 'preview',
  checkout: 'local checkout',
  other: 'other tool (logs, DB…)',
};

export const BECAUSE_OPTIONS: Record<string, string> = {
  couldnt_judge: "couldn't judge product here",
  checked_implementation: 'checked implementation',
  broken: 'evidence/preview broken',
};

const REVIEW_MARK = '<!-- dub:verdict -->';

/**
 * The structured block that goes into the COMMENT review body. There is no
 * separate verdict comment (contract decision 3).
 */
export function reviewBody(
  event: VerdictEvent,
  bundleUrl: string,
  opts: { onBehalfOf?: string; superseded?: boolean } = {},
): string {
  const lines: string[] = [REVIEW_MARK];
  const label = VERDICT_LABEL[event.verdict];
  lines.push(`## ${label}`);
  if (opts.onBehalfOf) lines.push(`*Posted by Dub on behalf of @${opts.onBehalfOf}.*`);
  if (opts.superseded) lines.push(`*Superseded by a later verdict.*`);
  lines.push('');
  lines.push(`**Product acceptance** (not code review) · SHA \`${event.sha}\` · bundle \`${event.bundle_id}\` · seq ${event.seq}`);
  lines.push(`[Open the review page](${bundleUrl})`);
  if (event.note && event.note.trim()) {
    lines.push('');
    lines.push(event.note.trim());
  }
  const used = event.used.map((k) => USED_OPTIONS[k] ?? k);
  const because = event.because.map((k) => BECAUSE_OPTIONS[k] ?? k);
  lines.push('');
  lines.push(`Also used: ${used.length ? used.join(', ') : 'nothing beyond the bundle'}`);
  if (because.length) lines.push(`Because: ${because.join(', ')}`);
  if (event.reason) lines.push(`Suggested as rule: yes`);
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify({
      dub: 1,
      verdict: event.verdict,
      sha: event.sha,
      bundle_id: event.bundle_id,
      seq: event.seq,
      reviewer: event.reviewer,
      used: event.used,
      because: event.because,
      suggest_rule: Boolean(event.reason),
    }),
  );
  lines.push('```');
  return lines.join('\n');
}

export const STICKY_MARK = '<!-- dub:sticky -->';

export interface StickySummary {
  head_sha: string;
  bundle_id: string | null;
  page_url: string;
  effective: VerdictEvent | null;
  newer_bundle_exists: boolean;
  failed_deliveries: { effect: string; last_error: string | null }[];
  criteria?: { id: string; status: string }[];
}

export function stickyBody(s: StickySummary): string {
  const lines: string[] = [STICKY_MARK, '### Dub'];
  lines.push('');
  if (!s.bundle_id) {
    lines.push(`Waiting for an evidence bundle for \`${s.head_sha.slice(0, 7)}\`.`);
  } else {
    lines.push(`Evidence bundle \`${s.bundle_id}\` for \`${s.head_sha.slice(0, 7)}\` — [review it](${s.page_url})`);
  }
  if (s.criteria && s.criteria.length) {
    lines.push('');
    lines.push('| Criterion | Status |');
    lines.push('|---|---|');
    for (const c of s.criteria) lines.push(`| ${c.id} | ${c.status} |`);
  }
  lines.push('');
  if (s.effective) {
    lines.push(`**${VERDICT_LABEL[s.effective.verdict]}** by @${s.effective.reviewer} on bundle \`${s.effective.bundle_id}\`.`);
    if (s.newer_bundle_exists) lines.push('A newer capture exists for this SHA; the acceptance stands.');
  } else {
    lines.push('No verdict yet for this SHA.');
  }
  if (s.failed_deliveries.length) {
    lines.push('');
    lines.push('**Some deliveries failed and need a human:**');
    for (const f of s.failed_deliveries) lines.push(`- ${f.effect}: ${f.last_error ?? 'unknown error'}`);
  }
  lines.push('');
  lines.push('_Product acceptance only. Code review is a separate gate._');
  return lines.join('\n');
}
