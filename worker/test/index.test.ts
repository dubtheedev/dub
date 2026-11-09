import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hmacHex, signCliToken, signSession } from '../src/lib/session';
import { signOAuthState } from '../src/lib/oauth';
import type { Bundle, Meta } from '../src/types';
import { FakeGitHub, SHA_A, SHA_B } from './fake-github';
import { ustar } from './tar-build';

let gh: FakeGitHub;
// Storage is not isolated between tests, so every test gets its own bundle ids.
let BUNDLE_1: string;
let BUNDLE_2: string;
const ulid = () => Array.from({ length: 26 }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('');
beforeEach(() => {
  gh = new FakeGitHub();
  gh.install();
  BUNDLE_1 = ulid();
  BUNDLE_2 = ulid();
});
afterEach(() => gh.uninstall());

const OIDC = { repository: 'o/r', event_name: 'pull_request', ref: 'refs/pull/1/merge', sha: 'merge-sha', run_id: '7', workflow: 'Review app', job_workflow_ref: 'o/r/.github/workflows/review-app.yml@refs/pull/1/merge' };

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    version: 0,
    bundle_id: BUNDLE_1,
    repo: 'o/r',
    pr: 1,
    sha: SHA_A,
    runner: 'ghcr.io/dubtheedev/runner@sha256:abc',
    preview: { url: 'https://pr-1-misiva.fly.dev', preview_sha: SHA_A, moved: false },
    brief: {
      path: '.dub/briefs/invoice-reminders.md',
      text: '# Send a reminder when an invoice is 7 days overdue\n\n**Why:** customers forget.\n\n## Acceptance\n- [ac-1] Badge shows {kind: visual}\n',
      criteria: [
        { id: 'ac-1', kind: 'visual', text: 'Badge shows' },
        { id: 'ac-2', kind: 'judgment', text: 'Tone matches' },
      ],
      first_seen_sha: 'c'.repeat(40),
      before_implementation: 'unknown',
    },
    notes: { did: ['Added the badge'], didnt: [], unsure: ['Timezone of the cutoff'] },
    criteria: [
      { id: 'ac-1', kind: 'visual', status: 'pass', assertions: ['goto /invoices', "expect badge 'Reminder sent' visible"], spec: { source: "test('ac-1', …)", files: [{ path: '.dub/evidence/a.spec.ts', sha256: 'x' }], external_imports: ['@playwright/test'], changed: false }, evidence: [{ type: 'image', path: 'ac-1/list.png', hash: 'sha256:1' }] },
      { id: 'ac-2', kind: 'judgment', status: 'none', evidence: [{ type: 'image', path: 'ac-2/tone.png', role: 'supporting' }] },
    ],
    diff: { files: 3, additions: 40, deletions: 2, areas: ['email'] },
    ...over,
  };
}

async function upload(b: Bundle, files: { name: string; data: Uint8Array }[] = [{ name: './ac-1/list.png', data: new TextEncoder().encode('PNG') }], claims = OIDC) {
  const token = await gh.oidcToken(claims);
  const form = new FormData();
  form.set('dub.json', new File([JSON.stringify(b)], 'dub.json', { type: 'application/json' }));
  form.set('evidence.tar', new File([ustar(files)], 'evidence.tar', { type: 'application/x-tar' }));
  return SELF.fetch('https://dub.test/api/bundles', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
}

async function cookieFor(login: string): Promise<string> {
  return `dub_session=${encodeURIComponent(await signSession(env.SESSION_SECRET, { login, user_token: 'gho_' + login }))}`;
}

describe('webhooks', () => {
  it('rejects a bad signature and routes a good one to the PR', async () => {
    const payload = JSON.stringify({ action: 'synchronize', number: 1, repository: { name: 'r', owner: { login: 'o' } }, pull_request: { head: { sha: SHA_B }, user: { login: 'agent-app[bot]' }, state: 'open' } });
    const bad = await SELF.fetch('https://dub.test/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=00' }, body: payload });
    expect(bad.status).toBe(401);
    const sig = 'sha256=' + (await hmacHex(env.GITHUB_WEBHOOK_SECRET, new TextEncoder().encode(payload)));
    const ok = await SELF.fetch('https://dub.test/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig }, body: payload });
    expect(ok.status).toBe(200);
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_B}`)[0]!.body).toMatchObject({ state: 'pending', description: 'Waiting for evidence bundle' });
    const other = await SELF.fetch('https://dub.test/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sig }, body: payload });
    expect(other.status).toBe(204);
  });
});

describe('bundle intake', () => {
  it('requires a pull_request OIDC token for the same repo and PR', async () => {
    const noAuth = await SELF.fetch('https://dub.test/api/bundles', { method: 'POST', body: new FormData() });
    expect(noAuth.status).toBe(401);
    const wrongRepo = await gh.oidcToken({ ...OIDC, repository: 'o/other', job_workflow_ref: 'o/other/.github/workflows/review-app.yml@refs/pull/1/merge' });
    const form = new FormData();
    form.set('dub.json', new File([JSON.stringify(bundle())], 'dub.json'));
    const r = await SELF.fetch('https://dub.test/api/bundles', { method: 'POST', headers: { authorization: `Bearer ${wrongRepo}` }, body: form });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/does not match/);
  });

  it('validates dub.json', async () => {
    const r = await upload(bundle({ brief: { ...bundle().brief, criteria: [] } }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/no criteria/);
    const r2 = await upload(bundle({ sha: 'short' }));
    expect(r2.status).toBe(400);
  });

  it('refuses a SHA that is not part of the PR', async () => {
    gh.on('GET /repos/o/r/commits/*/pulls', () => ({ body: [{ number: 42 }] }));
    const r = await upload(bundle({ sha: SHA_B }));
    expect(r.status).toBe(422);
  });

  it('stores the bundle, computes meta.json, and sets pending', async () => {
    const r = await upload(bundle());
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ bundle_id: BUNDLE_1, url: `https://dub.test/r/o/r/pull/1?sha=${SHA_A}` });
    const pre = `o/r/1/${SHA_A}/${BUNDLE_1}`;
    expect(await env.BUNDLES.get(`${pre}/ac-1/list.png`).then((o) => o?.text())).toBe('PNG');
    expect((await env.BUNDLES.get(`${pre}/ac-1/list.png`))?.httpMetadata?.contentType).toBe('image/png');
    const meta = (await env.BUNDLES.get(`${pre}/meta.json`).then((o) => o!.json())) as Meta;
    expect(meta).toMatchObject({ bundle_id: BUNDLE_1, sha: SHA_A, head_at_intake: true, previous: null, criteria_diff: [], rubric: { base_sha: 'base-sha', hits: ['Plain tone', 'Empty states everywhere'] } });
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`).at(-1)!.body).toMatchObject({ state: 'pending', description: 'Awaiting product acceptance' });

    // A second bundle for a new head gets `previous` and a criteria diff.
    gh.on('GET /repos/o/r/pulls/1', () => ({
      body: { number: 1, state: 'open', merged: false, head: { sha: SHA_B, ref: 'feat', repo: { full_name: 'o/r' } }, base: { sha: 'b', ref: 'main' }, user: { login: 'agent-app[bot]' }, html_url: 'u' },
    }));
    const b2 = bundle({ bundle_id: BUNDLE_2, sha: SHA_B, diff: { files: 1, additions: 1, deletions: 0, areas: ['invoices'] } });
    b2.brief.criteria = [{ id: 'ac-1', kind: 'visual', text: 'Badge shows in the list' }, { id: 'ac-3', kind: 'check', text: 'New one' }];
    const r2 = await upload(b2);
    expect(r2.status).toBe(201);
    const meta2 = (await env.BUNDLES.get(`o/r/1/${SHA_B}/${BUNDLE_2}/meta.json`).then((o) => o!.json())) as Meta;
    expect(meta2.previous).toEqual({ sha: SHA_A, bundle_id: BUNDLE_1, verdict: null, seq: null });
    expect(meta2.criteria_diff.map((c) => [c.id, c.change])).toEqual([
      ['ac-1', 'edited'],
      ['ac-3', 'added'],
      ['ac-2', 'removed'],
    ]);
    expect(meta2.rubric.hits).toEqual(['Empty states everywhere']);
    // Artifact and spec comparison against `previous`.
    expect(meta.criteria).toEqual([
      { id: 'ac-1', spec_changed: null, evidence: [{ path: 'ac-1/list.png', artifact_changed: null }] },
      { id: 'ac-2', spec_changed: null, evidence: [{ path: 'ac-2/tone.png', artifact_changed: null }] },
    ]);
    expect(meta2.criteria[0]).toEqual({ id: 'ac-1', spec_changed: false, evidence: [{ path: 'ac-1/list.png', artifact_changed: false }] });
  });

  it('is idempotent for a retry with identical bytes and refuses a different payload under the same id', async () => {
    const b = bundle();
    expect((await upload(b)).status).toBe(201);
    const again = await upload(b);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ bundle_id: BUNDLE_1, existing: true });
    const changed = await upload(bundle({ notes: { did: ['something else'] } }));
    expect(changed.status).toBe(409);
    // The stored bundle is the original.
    const stored = (await env.BUNDLES.get(`o/r/1/${SHA_A}/${BUNDLE_1}/dub.json`).then((o) => o!.json())) as Bundle;
    expect(stored.notes?.did).toEqual(['Added the badge']);
  });

  it('enforces the configured publishing workflow', async () => {
    gh.on('GET /repos/o/r/contents/.dub/config.yml', () => ({ body: { encoding: 'base64', sha: 'c', content: btoa('reviewers: [ryan]\npublish_workflow: review-app.yml\n') } }));
    const wrong = await upload(bundle(), undefined, { ...OIDC, job_workflow_ref: 'o/r/.github/workflows/ci.yml@refs/pull/1/merge' });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/review-app.yml, not ci.yml/);
    expect((await upload(bundle())).status).toBe(201);
    const foreign = await upload(bundle({ bundle_id: BUNDLE_2 }), undefined, { ...OIDC, job_workflow_ref: 'other/repo/.github/workflows/review-app.yml@refs/heads/main' });
    expect(foreign.status).toBe(401);
  });
});

describe('review page and API', () => {
  it('redirects a signed-out browser to login and 401s an API call', async () => {
    const page = await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/login?next=%2Fr%2Fo%2Fr%2Fpull%2F1');
    expect((await SELF.fetch('https://dub.test/api/prs/o/r/1')).status).toBe(401);
  });

  it('needs read access, then renders the newest bundle with the verdict form for a reviewer', async () => {
    await upload(bundle());
    const nobody = await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('nobody') } });
    expect(nobody.status).toBe(403);
    const reader = await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('reader') } });
    expect(reader.status).toBe(200);
    const readerHtml = await reader.text();
    expect(readerHtml).toContain("aren't on the reviewer list");
    const ryan = await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('ryan') } });
    const html = await ryan.text();
    expect(html).toContain('Send a reminder when an invoice is 7 days overdue');
    expect(html).toContain('<code>ac-1</code> Badge shows');
    expect(html).toContain('Assertions passed');
    expect(html).toContain(`/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/list.png`);
    expect(html).toContain('Plain tone');
    expect(html).toContain('brief order unknown');
    expect(html).toContain('<form id="verdict" >');
    // The brief is rendered, not dumped; the agent's checks are a demoted panel; the summary is still being written.
    expect(html).toContain('<h3>Send a reminder when an invoice is 7 days overdue</h3>');
    expect(html).toContain('<strong>Why:</strong>');
    expect(html).toContain("Agent's checks <span class=\"muted\">1 passed, 1 without evidence");
    expect(html).toContain('id="summary-pending"');
    expect(html).toContain('id="toggle-drawer"');
    expect(html).not.toContain('<script>alert');
    // Bundle files need the same access.
    const file = await SELF.fetch(`https://dub.test/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/list.png`, { headers: { cookie: await cookieFor('reader') } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await SELF.fetch(`https://dub.test/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/list.png`)).status).toBe(401);
  });

  it('never serves bundle files as active content', async () => {
    const enc = new TextEncoder();
    await upload(bundle(), [
      { name: 'ac-1/list.png', data: enc.encode('PNG') },
      { name: 'ac-1/x.svg', data: enc.encode('<svg onload="alert(1)"/>') },
      { name: 'ac-1/x.html', data: enc.encode('<script>alert(1)</script>') },
      { name: 'ac-1/trace.zip', data: enc.encode('PK') },
    ]);
    const get = async (name: string) => SELF.fetch(`https://dub.test/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/${name}`, { headers: { cookie: await cookieFor('reader') } });
    const png = await get('list.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toBe('inline; filename="list.png"');
    expect(png.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    for (const name of ['x.svg', 'x.html', 'trace.zip']) {
      const r = await get(name);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
      expect(r.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('shows a waiting page when no bundle exists yet', async () => {
    const r = await SELF.fetch('https://dub.test/r/o/r/pull/2', { headers: { accept: 'text/html', cookie: await cookieFor('ryan') } });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('waiting for a bundle');
  });

  it('escapes bundle content', async () => {
    const b = bundle();
    b.brief.text = '# <script>alert(1)</script>';
    b.notes = { did: ['<img src=x onerror=alert(1)>'] };
    await upload(b);
    const html = await (await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('ryan') } })).text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('summary', () => {
  it('writes the summary from the PR diff on request, stores it, and renders it on the page', async () => {
    await upload(bundle());
    const body = { owner: 'o', repo: 'r', pr: 1, sha: SHA_A, bundle_id: BUNDLE_1 };
    const headers = { 'content-type': 'application/json', cookie: await cookieFor('reader'), origin: 'https://dub.test' };
    const res = await SELF.fetch('https://dub.test/api/summaries', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const sum = (await res.json()) as { status: string; test_plan: { path: string }[]; model: string };
    expect(sum.status).toBe('done');
    expect(sum.test_plan[0]!.path).toBe('/invoices');
    // The model saw the diff, the brief and the PR, and was asked for JSON.
    const call = gh.anthropicCalls[0] as { model: string; output_config: { format: { type: string } }; messages: { content: string }[]; fallbacks: string };
    expect(call.model).toBe('claude-opus-5-5');
    expect(call.output_config.format.type).toBe('json_schema');
    expect(call.fallbacks).toBe('default');
    expect(call.messages[0]!.content).toContain('lib/invoices.ex');
    expect(call.messages[0]!.content).toContain('Send a reminder when an invoice');
    // Stored once; a second request is served from storage.
    const again = await SELF.fetch('https://dub.test/api/summaries', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(again.status).toBe(200);
    expect(gh.anthropicCalls).toHaveLength(1);
    const page = await (await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('ryan') } })).text();
    expect(page).toContain('Adds a <strong>reminder badge</strong>');
    expect(page).toContain('<b>Badge on the invoice list</b>');
    expect(page).toContain('data-path="/invoices"');
    expect(page).toContain('The cutoff ignores the customer timezone.');
    expect(page).not.toContain('id="summary-pending"');
    // Needs read access like everything else.
    expect((await SELF.fetch('https://dub.test/api/summaries', { method: 'POST', headers: { ...headers, cookie: await cookieFor('nobody') }, body: JSON.stringify(body) })).status).toBe(403);
  });

  it('records an error when the model fails and lets the page retry it', async () => {
    await upload(bundle());
    gh.anthropic = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } } });
    const body = { owner: 'o', repo: 'r', pr: 1, sha: SHA_A, bundle_id: BUNDLE_1 };
    const headers = { 'content-type': 'application/json', cookie: await cookieFor('ryan'), origin: 'https://dub.test' };
    const res = await SELF.fetch('https://dub.test/api/summaries', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { status: string }).status).toBe('error');
    const page = await (await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('ryan') } })).text();
    expect(page).toContain('The summary could not be written');
    expect(page).toContain('id="summary-retry"');
    gh.anthropicCalls = [];
    gh.anthropic = new FakeGitHub().anthropic;
    const retry = await SELF.fetch('https://dub.test/api/summaries', { method: 'POST', headers, body: JSON.stringify({ ...body, force: true }) });
    expect(retry.status).toBe(200);
    expect(gh.anthropicCalls).toHaveLength(1);
  });
});

describe('reruns', () => {
  it('re-runs the newest completed run of the publishing workflow for a reviewer', async () => {
    await upload(bundle());
    gh.on('GET /repos/o/r/contents/.dub/config.yml', () => ({ body: { encoding: 'base64', sha: 'c', content: btoa('reviewers: [ryan]\npublish_workflow: review-app.yml\n') } }));
    const body = JSON.stringify({ owner: 'o', repo: 'r', pr: 1, sha: SHA_A });
    const headers = { 'content-type': 'application/json', origin: 'https://dub.test' };
    expect((await SELF.fetch('https://dub.test/api/reruns', { method: 'POST', headers: { ...headers, cookie: await cookieFor('reader') }, body })).status).toBe(403);
    const res = await SELF.fetch('https://dub.test/api/reruns', { method: 'POST', headers: { ...headers, cookie: await cookieFor('ryan') }, body });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: 42, html_url: 'https://github.com/o/r/actions/runs/42' });
    expect(gh.of('POST', '/repos/o/r/actions/runs/42/rerun')).toHaveLength(1);
    expect(gh.of('POST', '/repos/o/r/actions/runs/41/rerun')).toHaveLength(0);
    // A missing App permission is explained.
    gh.on('POST /repos/o/r/actions/runs/*/rerun', () => ({ status: 403, body: { message: 'Resource not accessible by integration' } }));
    const denied = await SELF.fetch('https://dub.test/api/reruns', { method: 'POST', headers: { ...headers, cookie: await cookieFor('ryan') }, body });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/Actions: read and write/);
  });
});

describe('verdicts', () => {
  const body = () => ({ owner: 'o', repo: 'r', pr: 1, sha: SHA_A, bundle_id: BUNDLE_1, verdict: 'dub', note: 'ship it', used: ['preview'], because: [] });
  const post = (cookie: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    SELF.fetch('https://dub.test/api/verdicts', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://dub.test', ...headers }, body: JSON.stringify({ idempotency_key: crypto.randomUUID(), ...body(), ...over }) });

  it('records a verdict for an authorised reviewer and posts the review with their token', async () => {
    await upload(bundle());
    const r = await post(await cookieFor('ryan'));
    expect(r.status).toBe(201);
    const j = (await r.json()) as { seq: number };
    expect(j).toMatchObject({ seq: j.seq, effective: { sha: SHA_A, verdict: 'dub', seq: j.seq }, historical: false, review: 'posted' });
    const review = gh.of('POST', '/repos/o/r/pulls/1/reviews')[0]!;
    expect(review.auth).toBe('Bearer gho_ryan');
    expect(String((review.body as { body: string }).body)).toContain('ship it');
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`).at(-1)!.body).toMatchObject({ state: 'success' });
    const state = (await (await SELF.fetch('https://dub.test/api/prs/o/r/1', { headers: { cookie: await cookieFor('reader') } })).json()) as { verdicts: unknown[]; head_sha: string };
    expect(state.verdicts.length).toBeGreaterThanOrEqual(1);
    expect(state.head_sha).toBe(SHA_A);
  });

  it('replays a page submission with the same key and lets the API omit the key', async () => {
    await upload(bundle());
    const key = crypto.randomUUID();
    const first = await post(await cookieFor('ryan'), { idempotency_key: key });
    expect(first.status).toBe(201);
    const seq = ((await first.json()) as { seq: number }).seq;
    const again = await post(await cookieFor('ryan'), { idempotency_key: key, verdict: 'reject' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ seq, replayed: true });
    expect(gh.of('POST', '/repos/o/r/pulls/1/reviews')).toHaveLength(1);
    const token = await signCliToken(env.SESSION_SECRET, { login: 'ryan', user_token: 'gho_ryan' });
    const api = await SELF.fetch('https://dub.test/api/verdicts', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body(), verdict: 'revise' }) });
    expect(api.status).toBe(201);
    expect(await api.json()).toMatchObject({ seq: seq + 1 });
  });

  it('refuses non-reviewers, the PR author, cross-origin cookies, and bad input', async () => {
    await upload(bundle());
    expect((await post(await cookieFor('reader'))).status).toBe(403);
    gh.on('GET /repos/o/r/collaborators/*/permission', () => ({ body: { permission: 'admin' } }));
    gh.on('GET /repos/o/r/contents/.dub/config.yml', () => ({ body: { encoding: 'base64', sha: 'c', content: btoa('reviewers: [ryan, agent-app[bot]]\n') } }));
    const author = await post(await cookieFor('agent-app[bot]'));
    expect(author.status).toBe(403);
    expect(((await author.json()) as { error: string }).error).toMatch(/author/);
    expect((await post(await cookieFor('ryan'), {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(await cookieFor('ryan'), { verdict: 'approve' })).status).toBe(400);
    expect((await post(await cookieFor('ryan'), { idempotency_key: undefined })).status).toBe(400);
    expect((await post(await cookieFor('ryan'), { idempotency_key: 'not-a-uuid' })).status).toBe(400);
    expect((await post(await cookieFor('ryan'), { bundle_id: BUNDLE_2 })).status).toBe(422);
    expect(gh.of('POST', '/repos/o/r/pulls/1/reviews')).toHaveLength(0);
  });

  it('lets the author review their own PR when the repo allows self review', async () => {
    await upload(bundle());
    gh.on('GET /repos/o/r/collaborators/*/permission', () => ({ body: { permission: 'admin' } }));
    gh.on('GET /repos/o/r/contents/.dub/config.yml', () => ({ body: { encoding: 'base64', sha: 'c', content: btoa('reviewers: [ryan, agent-app[bot]]\nallow_self_review: true\n') } }));
    const page = await (await SELF.fetch('https://dub.test/r/o/r/pull/1', { headers: { accept: 'text/html', cookie: await cookieFor('agent-app[bot]') } })).text();
    expect(page).toContain('<form id="verdict" >');
    expect((await post(await cookieFor('agent-app[bot]'))).status).toBe(201);
  });
});

describe('dub pr and CLI tokens', () => {
  it('creates the PR as the App for a bearer-authenticated user with push access', async () => {
    gh.on('POST /repos/o/r/pulls', (c) => ({ status: 201, body: { number: 12, html_url: 'https://github.com/o/r/pull/12', ...(c.body as object) } }));
    const token = await signCliToken(env.SESSION_SECRET, { login: 'ryan', user_token: 'gho_ryan' });
    const r = await SELF.fetch('https://dub.test/api/prs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'o', repo: 'r', head: 'anson/feat', title: 'Feat', body: 'desc' }) });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' });
    const call = gh.of('POST', '/repos/o/r/pulls')[0]!;
    expect(call.auth).toBe('Bearer ghs_app');
    expect(call.body).toMatchObject({ head: 'anson/feat', base: 'main', title: 'Feat' });
    expect(String((call.body as { body: string }).body)).toContain('opened by @ryan');
    const denied = await SELF.fetch('https://dub.test/api/prs', { method: 'POST', headers: { authorization: `Bearer ${await signCliToken(env.SESSION_SECRET, { login: 'reader', user_token: 'x' })}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'o', repo: 'r', head: 'h', title: 't' }) });
    expect(denied.status).toBe(403);
  });

  it('hands a signed-in user a CLI token', async () => {
    const r = await SELF.fetch('https://dub.test/auth/token', { headers: { accept: 'application/json', cookie: await cookieFor('ryan') } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { login: string; token: string };
    expect(j.login).toBe('ryan');
    const me = await SELF.fetch('https://dub.test/api/prs/o/r/1', { headers: { authorization: `Bearer ${j.token}` } });
    expect(me.status).toBe(200);
  });

  it('starts the OAuth dance with a signed state bound to a browser cookie', async () => {
    const r = await SELF.fetch('https://dub.test/auth/login?cli=1', { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Iv1.test');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://dub.test/auth/callback');
    expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^dub_oauth=[0-9a-f-]{36}; Path=\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  });

  it('redeems the OAuth callback only with the matching cookie', async () => {
    const nonce = crypto.randomUUID();
    const state = await signOAuthState(env.SESSION_SECRET, { n: nonce, cli: true, next: '/' });
    const url = `https://dub.test/auth/callback?code=abc&state=${encodeURIComponent(state)}`;
    expect((await SELF.fetch(url, { redirect: 'manual' })).status).toBe(400);
    expect((await SELF.fetch(url, { redirect: 'manual', headers: { cookie: `dub_oauth=${crypto.randomUUID()}` } })).status).toBe(400);
    expect((await SELF.fetch(`https://dub.test/auth/callback?code=abc&state=${encodeURIComponent(state.slice(0, -1) + '0')}`, { redirect: 'manual', headers: { cookie: `dub_oauth=${nonce}` } })).status).toBe(400);
    expect(gh.of('POST', '/login/oauth/access_token')).toHaveLength(0);
    const ok = await SELF.fetch(url, { redirect: 'manual', headers: { cookie: `dub_oauth=${nonce}` } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/auth/token');
    const cookies = ok.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('dub_session=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('dub_oauth=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(gh.of('POST', '/login/oauth/access_token')[0]!.body).toMatchObject({ code: 'abc', client_id: 'Iv1.test' });
  });
});
