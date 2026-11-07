import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { AbortAfterCommit, type PullRequest, type SubmitResult } from '../src/do/pr';

const ok = (r: SubmitResult | { error: string }): SubmitResult => {
  if ('error' in r) throw new Error(r.error);
  return r;
};
import { BUNDLE_1, BUNDLE_2, FakeGitHub, ID, SHA_A, SHA_B } from './fake-github';

let gh: FakeGitHub;
let stub: DurableObjectStub<PullRequest>;
// A day ahead of the real clock, so a scheduled alarm never fires on its own.
let now = Math.ceil(Date.now() / 1000) * 1000 + 86_400_000;

function setNow(t: number): Promise<void> {
  now = t;
  return runInDurableObject(stub, (inst: PullRequest) => {
    inst.now = () => now;
    inst.sleep = async () => {};
  });
}

const verdict = (over: Partial<Parameters<PullRequest['submitVerdict']>[1]> = {}) => ({
  sha: SHA_A,
  bundle_id: BUNDLE_1,
  reviewer: 'ryan',
  verdict: 'dub' as const,
  used: ['preview'],
  because: [],
  user_token: 'gho_user',
  ...over,
});

beforeEach(async () => {
  gh = new FakeGitHub();
  gh.install();
  stub = env.PR.get(env.PR.idFromName(`o/r/1-${crypto.randomUUID()}`)) as DurableObjectStub<PullRequest>;
  await setNow(now);
  await stub.recordWebhook(ID, { action: 'opened', head_sha: SHA_A, author: 'agent-app[bot]', open: true });
  await stub.recordBundle(ID, { bundle_id: BUNDLE_1, sha: SHA_A, received_at: new Date(now).toISOString(), criteria: [{ id: 'ac-1', status: 'pass' }] });
  gh.calls.length = 0;
});
afterEach(() => gh.uninstall());

describe('PullRequest DO', () => {
  it('sets a pending status and a sticky comment on open, and refreshes pending on a bundle', async () => {
    const fresh = env.PR.get(env.PR.idFromName(`o/r/1-${crypto.randomUUID()}`)) as DurableObjectStub<PullRequest>;
    const g2 = gh;
    await fresh.recordWebhook(ID, { action: 'synchronize', head_sha: SHA_B, author: 'agent-app[bot]', open: true });
    const statuses = g2.of('POST', `/repos/o/r/statuses/${SHA_B}`);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.body).toMatchObject({ context: 'dubbed', state: 'pending', description: 'Waiting for evidence bundle', target_url: `https://dub.test/r/o/r/pull/1?sha=${SHA_B}` });
    expect(g2.of('POST', '/repos/o/r/issues/1/comments')).toHaveLength(1);
    expect(String((g2.of('POST', '/repos/o/r/issues/1/comments')[0]!.body as { body: string }).body)).toContain('Waiting for an evidence bundle');

    await fresh.recordBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_B, received_at: new Date().toISOString(), criteria: [{ id: 'ac-1', status: 'fail' }] });
    const after = g2.of('POST', `/repos/o/r/statuses/${SHA_B}`);
    expect(after[1]!.body).toMatchObject({ state: 'pending', description: 'Awaiting product acceptance' });
    // The sticky was edited, not duplicated.
    expect(g2.of('PATCH', '/repos/o/r/issues/comments/700')).toHaveLength(1);
    expect(String((g2.of('PATCH', '/repos/o/r/issues/comments/700')[0]!.body as { body: string }).body)).toContain('| ac-1 | fail |');
  });

  it('records a Dub it: review as the human, success status, sticky updated', async () => {
    const r = await stub.submitVerdict(ID, verdict());
    expect(r).toMatchObject({ seq: 1, effective: { sha: SHA_A, verdict: 'dub', seq: 1 }, head_sha: SHA_A, historical: false, review: 'posted' });
    const review = gh.of('POST', '/repos/o/r/pulls/1/reviews')[0]!;
    expect(review.auth).toBe('Bearer gho_user');
    expect(review.body).toMatchObject({ event: 'COMMENT', commit_id: SHA_A });
    expect(String((review.body as { body: string }).body)).toContain('## Dub it');
    const status = gh.of('POST', `/repos/o/r/statuses/${SHA_A}`)[0]!;
    expect(status.auth).toBe('Bearer ghs_app');
    expect(status.body).toMatchObject({ state: 'success', description: 'Dubbed by @ryan' });
    const state = await stub.state(ID);
    expect(state.deliveries.filter((d) => d.seq === 1).map((d) => [d.effect, d.state])).toEqual(
      expect.arrayContaining([
        ['review', 'done'],
        ['status', 'done'],
        ['sticky', 'done'],
      ]),
    );
    expect(state.deliveries.find((d) => d.seq === 1 && d.effect === 'review')?.gh_id).toBe(500);
  });

  it('a failed Dub-it status is superseded by a later Revise and never reopens the gate', async () => {
    let fail = true;
    gh.on('POST /repos/o/r/statuses/*', () => (fail ? { status: 502, body: { message: 'bad gateway' } } : { status: 201, body: { id: 1 } }));
    await stub.submitVerdict(ID, verdict({ verdict: 'dub' }));
    let st = await stub.state(ID);
    const pendingDub = st.deliveries.find((d) => d.seq === 1 && d.effect === 'status')!;
    expect(pendingDub.state).toBe('pending');
    expect(pendingDub.attempts).toBe(1);
    expect(pendingDub.next_at).toBe(now + 30_000);

    await stub.submitVerdict(ID, verdict({ verdict: 'revise', note: 'tz' }));
    fail = false;
    const before = gh.calls.length;
    await setNow(now + 31_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.seq === 1 && d.effect === 'status')?.state).toBe('superseded');
    expect(st.deliveries.find((d) => d.seq === 2 && d.effect === 'status')?.state).toBe('done');
    // Once GitHub is back, the only status written is the effective one.
    const writes = gh.calls.slice(before).filter((c) => c.method === 'POST' && c.path === `/repos/o/r/statuses/${SHA_A}`);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({ state: 'failure', description: 'Revise — @ryan' });
  });

  it('backs off exponentially and gives up after 24h, surfacing the failure', async () => {
    gh.on('POST /repos/o/r/statuses/*', () => ({ status: 502, body: { message: 'down' } }));
    await stub.submitVerdict(ID, verdict());
    let st = await stub.state(ID);
    const d = () => st.deliveries.find((x) => x.seq === 1 && x.effect === 'status')!;
    expect(d().next_at).toBe(now + 30_000);
    await setNow(now + 30_000);
    await runDurableObjectAlarm(stub);
    st = await stub.state(ID);
    expect(d().attempts).toBe(2);
    expect(d().next_at).toBe(now + 60_000);
    await setNow(now + 25 * 3600_000);
    await runDurableObjectAlarm(stub);
    st = await stub.state(ID);
    expect(d().state).toBe('failed');
    expect(d().last_error).toContain('down');
    // The give-up re-enqueued the sticky so the PR comment names it.
    await setNow(now + 1000);
    await runDurableObjectAlarm(stub);
    const patches = gh.of('PATCH', '/repos/o/r/issues/comments/700');
    expect(String((patches[patches.length - 1]!.body as { body: string }).body)).toContain('deliveries failed');
  });

  it('a Reject closes the PR only while it is the effective verdict on the open head', async () => {
    await stub.submitVerdict(ID, verdict({ verdict: 'reject' }));
    expect(gh.of('PATCH', '/repos/o/r/pulls/1')).toHaveLength(1);
    expect(gh.of('PATCH', '/repos/o/r/pulls/1')[0]!.body).toEqual({ state: 'closed' });
    const st = await stub.state(ID);
    expect(st.pr.open).toBe(false);
    expect(st.deliveries.find((d) => d.effect === 'close')?.state).toBe('done');
  });

  it('a delayed Reject never undoes a deliberate reopen (reopen boundary)', async () => {
    gh.on('PATCH /repos/o/r/pulls/1', () => ({ status: 502, body: { message: 'later' } }));
    await stub.submitVerdict(ID, verdict({ verdict: 'reject' }));
    let st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'close')?.state).toBe('pending');
    await stub.recordWebhook(ID, { action: 'reopened', head_sha: SHA_A, author: 'agent-app[bot]', open: true });
    st = await stub.state(ID);
    expect(st.pr.reopen_seq).toBe(1);
    gh.on('PATCH /repos/o/r/pulls/1', () => ({ body: { state: 'closed' } }));
    await setNow(now + 31_000);
    await runDurableObjectAlarm(stub);
    st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'close')?.state).toBe('superseded');
    expect(gh.of('PATCH', '/repos/o/r/pulls/1').filter((c) => (c.body as { state: string }).state === 'closed' && c.auth === 'Bearer ghs_app').length).toBe(1); // the failed try only
  });

  it('a verdict on a SHA that is no longer the head is recorded as historical and skips the close', async () => {
    await stub.recordWebhook(ID, { action: 'synchronize', head_sha: SHA_B, author: 'agent-app[bot]', open: true });
    gh.calls.length = 0;
    const r = ok(await stub.submitVerdict(ID, verdict({ verdict: 'reject' })));
    expect(r.historical).toBe(true);
    expect(r.head_sha).toBe(SHA_B);
    expect(gh.of('PATCH', '/repos/o/r/pulls/1')).toHaveLength(0);
    // Status still goes to the verdict's own SHA.
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`)[0]!.body).toMatchObject({ state: 'failure' });
    const st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.seq === 1 && d.effect === 'sticky')?.state).toBe('superseded');
  });

  it('falls back to the App posting on the reviewer\'s behalf when the human token fails three times', async () => {
    let userTries = 0;
    gh.on('POST /repos/o/r/pulls/1/reviews', (c) => {
      if (c.auth === 'Bearer gho_user') {
        userTries++;
        return { status: 500, body: { message: 'boom' } };
      }
      return { body: { id: 501 } };
    });
    const r = ok(await stub.submitVerdict(ID, verdict()));
    expect(userTries).toBe(3);
    expect(r.review).toBe('on_behalf_pending');
    let st = await stub.state(ID);
    expect(st.verdicts[0]?.on_behalf).toBe(true);
    // The App fallback ran in the same pass.
    const appReview = gh.of('POST', '/repos/o/r/pulls/1/reviews').find((c) => c.auth === 'Bearer ghs_app')!;
    expect(String((appReview.body as { body: string }).body)).toContain('on behalf of @ryan');
    st = await stub.state(ID);
    const rev = st.deliveries.find((d) => d.effect === 'review')!;
    expect(rev.state).toBe('done');
    expect(rev.gh_id).toBe(501);
  });

  it('does not retry a 4xx on the human review, and stops short of three tries', async () => {
    let userTries = 0;
    gh.on('POST /repos/o/r/pulls/1/reviews', (c) => {
      if (c.auth === 'Bearer gho_user') {
        userTries++;
        return { status: 422, body: { message: 'Review already submitted' } };
      }
      return { body: { id: 502 } };
    });
    await stub.submitVerdict(ID, verdict());
    expect(userTries).toBe(1);
  });

  it('refuses a bundle that belongs to another SHA', async () => {
    expect(await stub.submitVerdict(ID, verdict({ sha: SHA_B }))).toEqual({ error: expect.stringMatching(/belongs to/) });
    expect(await stub.submitVerdict(ID, verdict({ bundle_id: BUNDLE_2 }))).toEqual({ error: expect.stringMatching(/unknown bundle/) });
  });

  it('closed: pending deliveries are superseded and the alarm is cancelled', async () => {
    gh.on('POST /repos/o/r/statuses/*', () => ({ status: 502, body: { message: 'down' } }));
    await stub.submitVerdict(ID, verdict());
    await stub.recordWebhook(ID, { action: 'closed', head_sha: SHA_A, author: 'agent-app[bot]', open: false });
    const st = await stub.state(ID);
    expect(st.pr.open).toBe(false);
    expect(st.deliveries.filter((d) => d.state === 'pending')).toHaveLength(0);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('a newer bundle for a dubbed SHA does not touch the status', async () => {
    await stub.submitVerdict(ID, verdict());
    gh.calls.length = 0;
    await stub.recordBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, received_at: new Date(now + 1000).toISOString(), criteria: [{ id: 'ac-1', status: 'fail' }] });
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`)).toHaveLength(0);
    const patch = gh.of('PATCH', '/repos/o/r/issues/comments/700');
    expect(String((patch[patch.length - 1]!.body as { body: string }).body)).toContain('A newer capture exists');
  });

  // ---- review findings ----------------------------------------------------

  it('serialises the reconciler: a Dub it and a Revise submitted together end with the Revise on GitHub', async () => {
    const order: string[] = [];
    gh.on('POST /repos/o/r/statuses/*', async (c) => {
      const state = (c.body as { state: string }).state;
      order.push('start:' + state);
      await new Promise((r) => setTimeout(r, state === 'success' ? 80 : 5));
      order.push('end:' + state);
      return { status: 201, body: { id: 1 } };
    });
    const [a, b] = await Promise.all([stub.submitVerdict(ID, verdict({ verdict: 'dub' })), stub.submitVerdict(ID, verdict({ verdict: 'revise' }))]);
    expect(ok(a).seq).toBe(1);
    expect(ok(b).seq).toBe(2);
    // Whatever interleaving happened, the last write that finished is the Revise.
    const ends = order.filter((o) => o.startsWith('end:'));
    expect(ends[ends.length - 1]).toBe('end:failure');
    const st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.seq === 2 && d.effect === 'status')?.state).toBe('done');
    expect(st.deliveries.filter((d) => d.state === 'pending')).toHaveLength(0);
  });

  it('a verdict arriving while an older status write is in flight still ends with the newer status', async () => {
    const states: string[] = [];
    gh.on('POST /repos/o/r/statuses/*', async (c) => {
      const state = (c.body as { state: string }).state;
      // The Dub it's write is slow; the Revise lands while it is in flight.
      await new Promise((r) => setTimeout(r, state === 'success' ? 80 : 1));
      states.push(state);
      return { status: 201, body: { id: 1 } };
    });
    const p1 = stub.submitVerdict(ID, verdict({ verdict: 'dub' }));
    await new Promise((r) => setTimeout(r, 20));
    const p2 = stub.submitVerdict(ID, verdict({ verdict: 'revise' }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(ok(a).seq).toBe(1);
    expect(ok(b).seq).toBe(2);
    expect(states).toEqual(['success', 'failure']);
    const st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.seq === 1 && d.effect === 'status')?.state).toBe('done');
    expect(st.deliveries.find((d) => d.seq === 2 && d.effect === 'status')?.state).toBe('done');
    expect(st.deliveries.filter((d) => d.state === 'pending')).toHaveLength(0);
  });

  it('commits the event and every delivery intent before any await, so a crash still delivers', async () => {
    await runInDurableObject(stub, (inst: PullRequest) => {
      inst.afterCommit = () => {
        throw new AbortAfterCommit('simulated crash after commit');
      };
    });
    expect(await stub.submitVerdict(ID, verdict({ verdict: 'reject' }))).toEqual({ error: expect.stringMatching(/aborted after commit/) });
    let st = await stub.state(ID);
    expect(st.verdicts).toHaveLength(1);
    const rows = st.deliveries.filter((d) => d.seq === 1);
    expect(rows.map((d) => [d.effect, d.state]).sort()).toEqual([
      ['close', 'pending'],
      ['review', 'pending'],
      ['status', 'pending'],
      ['sticky', 'pending'],
    ]);
    expect(rows.find((d) => d.effect === 'review')?.next_at).toBe(now + 60_000);
    expect(gh.of('POST', '/repos/o/r/pulls/1/reviews')).toHaveLength(0);
    await runInDurableObject(stub, (inst: PullRequest) => {
      inst.afterCommit = null;
    });
    // The alarm set in the commit block delivers the App effects…
    await setNow(now + 2000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'status')?.state).toBe('done');
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`).at(-1)!.body).toMatchObject({ state: 'failure' });
    expect(st.deliveries.find((d) => d.effect === 'review')?.state).toBe('pending');
    // …and, once the grace period is over, the review on the reviewer's behalf.
    await setNow(now + 61_000);
    await runDurableObjectAlarm(stub);
    st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'review')?.state).toBe('done');
    const review = gh.of('POST', '/repos/o/r/pulls/1/reviews')[0]!;
    expect(review.auth).toBe('Bearer ghs_app');
    expect(String((review.body as { body: string }).body)).toContain('on behalf of @ryan');
    expect(st.verdicts[0]?.on_behalf).toBe(true);
  });

  it('reserveBundle: new, identical retry, and conflicting content', async () => {
    const r1 = await stub.reserveBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, digest: 'd1', received_at: new Date(now).toISOString() });
    expect(r1).toEqual({ existing: false });
    let st = await stub.state(ID);
    expect(st.bundles.find((b) => b.bundle_id === BUNDLE_2)).toMatchObject({ complete: false, digest: 'd1' });
    const r2 = await stub.reserveBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, digest: 'd1', received_at: 'later' });
    expect(r2).toEqual({ existing: true, complete: false });
    await stub.recordBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, received_at: 'ignored', criteria: [{ id: 'ac-1', status: 'pass' }] });
    st = await stub.state(ID);
    expect(st.bundles.find((b) => b.bundle_id === BUNDLE_2)).toMatchObject({ complete: true, digest: 'd1', received_at: new Date(now).toISOString() });
    expect(await stub.reserveBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, digest: 'd1', received_at: 'x' })).toEqual({ existing: true, complete: true });
    expect(await stub.reserveBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_A, digest: 'd2', received_at: 'x' })).toEqual({ conflict: true, digest: 'd1' });
    expect(await stub.reserveBundle(ID, { bundle_id: BUNDLE_2, sha: SHA_B, digest: 'd1', received_at: 'x' })).toEqual({ conflict: true, digest: 'd1' });
  });

  it('asks GitHub before closing and backs off if the PR moved or closed meanwhile', async () => {
    gh.on('GET /repos/o/r/pulls/1', () => ({
      body: { number: 1, state: 'open', merged: false, head: { sha: SHA_B, ref: 'feat', repo: { full_name: 'o/r' } }, base: { sha: 'b', ref: 'main' }, user: { login: 'agent-app[bot]' }, html_url: 'u' },
    }));
    await stub.submitVerdict(ID, verdict({ verdict: 'reject' }));
    expect(gh.of('GET', '/repos/o/r/pulls/1')).toHaveLength(1);
    expect(gh.of('PATCH', '/repos/o/r/pulls/1')).toHaveLength(0);
    const st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'close')?.state).toBe('superseded');
    expect(st.pr.head_sha).toBe(SHA_B);
  });

  it('close_on_reject: false records the Reject without closing', async () => {
    await stub.submitVerdict(ID, verdict({ verdict: 'reject', close_on_reject: false }));
    const st = await stub.state(ID);
    expect(st.deliveries.find((d) => d.effect === 'close')).toBeUndefined();
    expect(gh.of('PATCH', '/repos/o/r/pulls/1')).toHaveLength(0);
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`).at(-1)!.body).toMatchObject({ state: 'failure' });
  });

  it('replays a verdict with the same idempotency key instead of recording a second one', async () => {
    const key = crypto.randomUUID();
    const first = ok(await stub.submitVerdict(ID, verdict({ idempotency_key: key, note: 'first' })));
    const again = ok(await stub.submitVerdict(ID, verdict({ idempotency_key: key, verdict: 'reject', note: 'second' })));
    expect(again).toEqual({ ...first, replayed: true });
    const st = await stub.state(ID);
    expect(st.verdicts).toHaveLength(1);
    expect(st.verdicts[0]).toMatchObject({ verdict: 'dub', note: 'first', idempotency_key: key });
    expect(gh.of('POST', '/repos/o/r/pulls/1/reviews')).toHaveLength(1);
    const other = ok(await stub.submitVerdict(ID, verdict({ idempotency_key: crypto.randomUUID() })));
    expect(other.seq).toBe(2);
  });
});
