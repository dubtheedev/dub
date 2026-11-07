import { describe, expect, it } from 'vitest';
import {
  BACKOFF_CAP_MS,
  closeEligible,
  effectiveVerdict,
  nextBackoff,
  reviewBody,
  shouldGiveUp,
  statusFor,
  stickyBody,
} from '../src/lib/verdicts';
import type { VerdictEvent } from '../src/types';

const ev = (seq: number, sha: string, verdict: VerdictEvent['verdict'], extra: Partial<VerdictEvent> = {}): VerdictEvent => ({
  seq,
  sha,
  bundle_id: '01HX7Q0000000000000000000' + seq,
  reviewer: 'ryan',
  verdict,
  used: [],
  because: [],
  at: '2026-11-07T00:00:00Z',
  ...extra,
});

describe('effectiveVerdict', () => {
  it('is the highest seq for that SHA only', () => {
    const events = [ev(1, 'a', 'dub'), ev(2, 'b', 'reject'), ev(3, 'a', 'revise')];
    expect(effectiveVerdict(events, 'a')?.seq).toBe(3);
    expect(effectiveVerdict(events, 'b')?.seq).toBe(2);
    expect(effectiveVerdict(events, 'c')).toBeNull();
  });
});

describe('closeEligible', () => {
  const pr = { head_sha: 'a', open: true, reopen_seq: 0 };
  it('closes only for an effective reject on the open head', () => {
    const r = ev(2, 'a', 'reject');
    expect(closeEligible(r, [ev(1, 'a', 'dub'), r], pr)).toBe(true);
  });
  it('never closes for dub or revise', () => {
    expect(closeEligible(ev(1, 'a', 'dub'), [ev(1, 'a', 'dub')], pr)).toBe(false);
    expect(closeEligible(ev(1, 'a', 'revise'), [ev(1, 'a', 'revise')], pr)).toBe(false);
  });
  it('is skipped when superseded, when the head moved, or when the PR is closed', () => {
    const r = ev(1, 'a', 'reject');
    expect(closeEligible(r, [r, ev(2, 'a', 'revise')], pr)).toBe(false);
    expect(closeEligible(r, [r], { ...pr, head_sha: 'b' })).toBe(false);
    expect(closeEligible(r, [r], { ...pr, open: false })).toBe(false);
  });
  it('respects the reopen boundary: a reject with seq <= reopen_seq never closes', () => {
    const r = ev(3, 'a', 'reject');
    expect(closeEligible(r, [r], { ...pr, reopen_seq: 3 })).toBe(false);
    expect(closeEligible(r, [r], { ...pr, reopen_seq: 2 })).toBe(true);
  });
});

describe('statusFor', () => {
  it('maps verdicts to commit status states', () => {
    expect(statusFor('dub', 'ryan')).toEqual({ state: 'success', description: 'Dubbed by @ryan' });
    expect(statusFor('revise').state).toBe('failure');
    expect(statusFor('reject').state).toBe('failure');
    expect(statusFor(null).state).toBe('pending');
  });
});

describe('backoff', () => {
  it('doubles from 30s and caps at an hour', () => {
    expect(nextBackoff(1)).toBe(30_000);
    expect(nextBackoff(2)).toBe(60_000);
    expect(nextBackoff(3)).toBe(120_000);
    expect(nextBackoff(8)).toBe(BACKOFF_CAP_MS);
    expect(nextBackoff(40)).toBe(BACKOFF_CAP_MS);
  });
  it('gives up after 24h', () => {
    const t0 = 1_000_000;
    expect(shouldGiveUp(t0, t0 + 23 * 3600_000)).toBe(false);
    expect(shouldGiveUp(t0, t0 + 24 * 3600_000)).toBe(true);
  });
});

describe('reviewBody', () => {
  it('carries the structured block, the note and the checkboxes', () => {
    const body = reviewBody(ev(4, 'abc', 'revise', { note: 'Timezone is off', used: ['preview'], because: ['couldnt_judge'] }), 'https://dub.test/r/o/r/pull/1');
    expect(body).toContain('<!-- dub:verdict -->');
    expect(body).toContain('## Revise');
    expect(body).toContain('Timezone is off');
    expect(body).toContain('Also used: preview');
    expect(body).toContain("Because: couldn't judge product here");
    const json = JSON.parse(/```json\n(.*)\n```/s.exec(body)![1]!);
    expect(json).toMatchObject({ dub: 1, verdict: 'revise', sha: 'abc', seq: 4, reviewer: 'ryan' });
  });
  it('has an on-behalf variant', () => {
    expect(reviewBody(ev(1, 'a', 'dub'), 'u', { onBehalfOf: 'ryan' })).toContain('on behalf of @ryan');
    expect(reviewBody(ev(1, 'a', 'dub'), 'u', { superseded: true })).toContain('Superseded');
  });
});

describe('stickyBody', () => {
  it('shows waiting, verdict, newer-bundle and failures', () => {
    const base = { head_sha: 'abcdef0123', bundle_id: null, page_url: 'https://dub.test/p', effective: null, newer_bundle_exists: false, failed_deliveries: [] };
    expect(stickyBody(base)).toContain('Waiting for an evidence bundle');
    const withVerdict = stickyBody({
      ...base,
      bundle_id: 'B2',
      effective: ev(1, 'abcdef0123', 'dub', { bundle_id: 'B1' }),
      newer_bundle_exists: true,
      failed_deliveries: [{ effect: 'close', last_error: '502' }],
      criteria: [{ id: 'ac-1', status: 'pass' }],
    });
    expect(withVerdict).toContain('<!-- dub:sticky -->');
    expect(withVerdict).toContain('**Dub it** by @ryan');
    expect(withVerdict).toContain('A newer capture exists');
    expect(withVerdict).toContain('- close: 502');
    expect(withVerdict).toContain('| ac-1 | pass |');
  });
});
