import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hmacHex, signCliToken, signSession } from '../src/lib/session';
import type { Bundle, Meta } from '../src/types';
import { BUNDLE_1, BUNDLE_2, FakeGitHub, SHA_A, SHA_B } from './fake-github';
import { ustar } from './tar-build';

let gh: FakeGitHub;
beforeEach(() => {
  gh = new FakeGitHub();
  gh.install();
});
afterEach(() => gh.uninstall());

const OIDC = { repository: 'o/r', event_name: 'pull_request', ref: 'refs/pull/1/merge', sha: 'merge-sha', run_id: '7', workflow: 'Review app' };

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

async function upload(b: Bundle, files: { name: string; data: Uint8Array }[] = [{ name: './ac-1/list.png', data: new TextEncoder().encode('PNG') }]) {
  const token = await gh.oidcToken(OIDC);
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
    const wrongRepo = await gh.oidcToken({ ...OIDC, repository: 'o/other' });
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
    expect(html).toContain('Brief order: <b>unknown</b>');
    expect(html).toContain('<form id="verdict" >');
    expect(html).not.toContain('<script>alert');
    // Bundle files need the same access.
    const file = await SELF.fetch(`https://dub.test/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/list.png`, { headers: { cookie: await cookieFor('reader') } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await SELF.fetch(`https://dub.test/api/bundles/o/r/1/${SHA_A}/${BUNDLE_1}/ac-1/list.png`)).status).toBe(401);
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

describe('verdicts', () => {
  const body = { owner: 'o', repo: 'r', pr: 1, sha: SHA_A, bundle_id: BUNDLE_1, verdict: 'dub', note: 'ship it', used: ['preview'], because: [] };
  const post = (cookie: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    SELF.fetch('https://dub.test/api/verdicts', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://dub.test', ...headers }, body: JSON.stringify({ ...body, ...over }) });

  it('records a verdict for an authorised reviewer and posts the review with their token', async () => {
    await upload(bundle());
    const r = await post(await cookieFor('ryan'));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ seq: 1, effective: { sha: SHA_A, verdict: 'dub', seq: 1 }, historical: false, review: 'posted' });
    const review = gh.of('POST', '/repos/o/r/pulls/1/reviews')[0]!;
    expect(review.auth).toBe('Bearer gho_ryan');
    expect(String((review.body as { body: string }).body)).toContain('ship it');
    expect(gh.of('POST', `/repos/o/r/statuses/${SHA_A}`).at(-1)!.body).toMatchObject({ state: 'success' });
    const state = (await (await SELF.fetch('https://dub.test/api/prs/o/r/1', { headers: { cookie: await cookieFor('reader') } })).json()) as { verdicts: unknown[]; head_sha: string };
    expect(state.verdicts).toHaveLength(1);
    expect(state.head_sha).toBe(SHA_A);
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
    expect((await post(await cookieFor('ryan'), { bundle_id: BUNDLE_2 })).status).toBe(422);
    expect(gh.of('POST', '/repos/o/r/pulls/1/reviews')).toHaveLength(0);
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

  it('starts the OAuth dance with a signed state', async () => {
    const r = await SELF.fetch('https://dub.test/auth/login?cli=1', { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('Iv1.test');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://dub.test/auth/callback');
    expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });
});
