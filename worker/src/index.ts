// The Dub Worker: bundle intake (OIDC), access-checked serving, verdicts,
// webhooks, App OAuth, and the placeholder review page. The per-PR state is
// in `do/pr.ts`.
import type { Bundle, Criterion, Env, Meta } from './types';
import { PullRequest, type FullState, type PRId } from './do/pr';
import { AppAuth, GitHub, GitHubError, atLeast, type Permission } from './lib/github';
import { OidcError, verifyActionsToken } from './lib/oidc';
import { readTar } from './lib/tar';
import { criteriaDiff, previousFor, rubricHits } from './lib/meta';
import { parseConfig, type DubConfig } from './lib/config';
import {
  SESSION_COOKIE,
  hmacHex,
  parseCookies,
  readCliToken,
  readSession,
  sessionCookie,
  signCliToken,
  signSession,
  timingSafeEqual,
} from './lib/session';
import { renderReviewPage } from './page/review';
import { renderSimple } from './page/review';
import { esc } from './page/html';

export { PullRequest };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface User {
  login: string;
  user_token: string;
  via: 'cookie' | 'bearer';
}

// Per-isolate caches. Permission checks are re-done every 10 minutes.
const permCache = new Map<string, { perm: Permission; at: number }>();
const PERM_TTL_MS = 10 * 60_000;
let appAuth: AppAuth | null = null;

function app(env: Env): AppAuth {
  return (appAuth ??= new AppAuth({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }));
}
const gh = new GitHub();

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof OidcError) return json({ error: e.message }, 401);
      if (e instanceof GitHubError) return json({ error: `GitHub: ${e.message}` }, e.status === 404 ? 404 : 502);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === '/' && m === 'GET') return home(env);
  if (p === '/healthz') return json({ ok: true });

  if (p === '/auth/login' && m === 'GET') return authLogin(req, env);
  if (p === '/auth/callback' && m === 'GET') return authCallback(req, env);
  if (p === '/auth/token' && m === 'GET') return authToken(req, env);
  if (p === '/auth/logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie('', url.protocol === 'https:', 0) } });

  if (p === '/webhooks/github' && m === 'POST') return webhook(req, env);
  if (p === '/api/bundles' && m === 'POST') return intake(req, env);
  if (p === '/api/verdicts' && m === 'POST') return submitVerdict(req, env);
  if (p === '/api/prs' && m === 'POST') return createPR(req, env);

  let mm: RegExpExecArray | null;
  if ((mm = /^\/r\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(p)) && m === 'GET') {
    return reviewPage(req, env, { owner: mm[1]!, repo: mm[2]!, number: Number(mm[3]) }, url.searchParams.get('sha'));
  }
  if ((mm = /^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)$/.exec(p)) && m === 'GET') {
    return prState(req, env, { owner: mm[1]!, repo: mm[2]!, number: Number(mm[3]) });
  }
  if ((mm = /^\/api\/bundles\/([^/]+)\/([^/]+)\/(\d+)\/([0-9a-f]{7,40})\/([0-9A-Za-z]+)\/(.+)$/.exec(p)) && m === 'GET') {
    return bundleFile(req, env, { owner: mm[1]!, repo: mm[2]!, number: Number(mm[3]) }, mm[4]!, mm[5]!, mm[6]!);
  }
  return json({ error: 'not found' }, 404);
}

// ---- helpers ---------------------------------------------------------------

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function doFor(env: Env, id: PRId): DurableObjectStub<PullRequest> {
  const name = `${id.owner}/${id.repo}/${id.number}`.toLowerCase();
  return env.PR.get(env.PR.idFromName(name)) as DurableObjectStub<PullRequest>;
}

function prefix(id: PRId, sha: string, bundleId: string): string {
  return `${id.owner}/${id.repo}/${id.number}/${sha}/${bundleId}`.toLowerCase().replace(`/${bundleId.toLowerCase()}`, `/${bundleId}`);
}

async function currentUser(req: Request, env: Env): Promise<User | null> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const t = await readCliToken(env.SESSION_SECRET, auth.slice(7).trim());
    if (t) return { login: t.login, user_token: t.user_token, via: 'bearer' };
    return null;
  }
  const s = await readSession(env.SESSION_SECRET, parseCookies(req.headers.get('cookie'))[SESSION_COOKIE]);
  if (s) return { login: s.login, user_token: s.user_token, via: 'cookie' };
  return null;
}

async function requireUser(req: Request, env: Env): Promise<User> {
  const u = await currentUser(req, env);
  if (!u) {
    if (req.headers.get('accept')?.includes('text/html')) {
      const next = new URL(req.url).pathname + new URL(req.url).search;
      throw new Redirect(`/auth/login?next=${encodeURIComponent(next)}`);
    }
    throw new HttpError(401, 'sign in required');
  }
  return u;
}

class Redirect extends HttpError {
  constructor(public to: string) {
    super(302, 'redirect');
  }
}

async function permission(env: Env, login: string, owner: string, repo: string): Promise<Permission> {
  const key = `${login}@${owner}/${repo}`.toLowerCase();
  const hit = permCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PERM_TTL_MS) return hit.perm;
  const tok = await app(env).installationToken(owner, repo);
  const perm = await gh.collaboratorPermission(tok, owner, repo, login);
  permCache.set(key, { perm, at: now });
  return perm;
}

async function requirePermission(env: Env, user: User, id: PRId, want: Permission): Promise<Permission> {
  const perm = await permission(env, user.login, id.owner, id.repo);
  if (!atLeast(perm, want)) throw new HttpError(403, `@${user.login} needs ${want} access to ${id.owner}/${id.repo}`);
  return perm;
}

async function repoConfig(env: Env, id: PRId): Promise<{ config: DubConfig; base_sha: string | null; rubric: string | null }> {
  const tok = await app(env).installationToken(id.owner, id.repo);
  // Base defaults to main; config.yml can move it, so read it first at main
  // then re-read at the declared base when they differ.
  let cfgFile = await gh.getContent(tok, id.owner, id.repo, '.dub/config.yml', 'main');
  let config = parseConfig(cfgFile?.text);
  if (config.base !== 'main') {
    cfgFile = (await gh.getContent(tok, id.owner, id.repo, '.dub/config.yml', config.base)) ?? cfgFile;
    config = parseConfig(cfgFile?.text);
  }
  const [base_sha, rubric] = await Promise.all([
    gh.branchSha(tok, id.owner, id.repo, config.base),
    gh.getContent(tok, id.owner, id.repo, '.dub/rubric.md', config.base),
  ]);
  return { config, base_sha, rubric: rubric?.text ?? null };
}

function checkOrigin(req: Request, env: Env, user: User): void {
  // CSRF: a cookie session may only be used from our own origin.
  if (user.via !== 'cookie') return;
  const origin = req.headers.get('origin') ?? (req.headers.get('referer') ? new URL(req.headers.get('referer')!).origin : null);
  const self = new URL(req.url).origin;
  const allowed = new Set([self, ...env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)]);
  if (!origin || !allowed.has(origin)) throw new HttpError(403, 'cross-origin request refused');
}

// ---- auth ------------------------------------------------------------------

function home(env: Env): Response {
  return renderSimple(
    'Dub',
    `<p><i>"I dub thee merged."</i> Product acceptance for agent-written work.</p>
     <p><a href="/auth/login">Sign in with GitHub</a> · <a href="/auth/login?cli=1">Get a CLI token</a></p>
     <p class="muted">${esc(env.PUBLIC_URL)}</p>`,
  );
}

async function authLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const cli = url.searchParams.get('cli') === '1';
  const next = url.searchParams.get('next') ?? '/';
  const nonce = crypto.randomUUID();
  const statePayload = JSON.stringify({ n: nonce, cli, next: next.startsWith('/') ? next : '/' });
  const state = `${b64url(statePayload)}.${await hmacHex(env.SESSION_SECRET, new TextEncoder().encode(statePayload))}`;
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${env.PUBLIC_URL}/auth/callback`);
  authorize.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { location: authorize.toString() } });
}

async function authCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const [payloadB64, sig] = state.split('.');
  if (!code || !payloadB64 || !sig) throw new HttpError(400, 'missing code or state');
  const payload = b64urlDecode(payloadB64);
  const expect = await hmacHex(env.SESSION_SECRET, new TextEncoder().encode(payload));
  if (!timingSafeEqual(sig, expect)) throw new HttpError(400, 'bad state');
  const st = JSON.parse(payload) as { cli: boolean; next: string };

  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dub (dubthee.dev)' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
    }),
  });
  const tok = (await tokRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) throw new HttpError(401, `GitHub OAuth failed: ${tok.error_description ?? tok.error ?? 'no token'}`);
  const me = await gh.viewer(tok.access_token);
  const cookie = await signSession(env.SESSION_SECRET, { login: me.login, user_token: tok.access_token });
  return new Response(null, {
    status: 302,
    headers: {
      location: st.cli ? '/auth/token' : st.next || '/',
      'set-cookie': sessionCookie(cookie, url.protocol === 'https:'),
    },
  });
}

async function authToken(req: Request, env: Env): Promise<Response> {
  const user = await requireUser(req, env).catch((e) => {
    if (e instanceof Redirect) throw new Redirect('/auth/login?cli=1');
    throw e;
  });
  const token = await signCliToken(env.SESSION_SECRET, { login: user.login, user_token: user.user_token });
  if (req.headers.get('accept')?.includes('application/json')) return json({ login: user.login, token });
  return renderSimple(
    'Your Dub CLI token',
    `<p>Signed in as <b>@${esc(user.login)}</b>. Paste this into <code>dub login</code>. It is valid for 30 days and is shown once.</p>
     <pre style="white-space:pre-wrap;word-break:break-all">${esc(token)}</pre>`,
  );
}

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4))));
}

// ---- webhooks --------------------------------------------------------------

async function webhook(req: Request, env: Env): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const sig = req.headers.get('x-hub-signature-256') ?? '';
  const expect = `sha256=${await hmacHex(env.GITHUB_WEBHOOK_SECRET, raw)}`;
  if (!timingSafeEqual(sig, expect)) return json({ error: 'bad signature' }, 401);
  const event = req.headers.get('x-github-event');
  if (event !== 'pull_request') return new Response(null, { status: 204 });
  const body = JSON.parse(new TextDecoder().decode(raw)) as {
    action: string;
    number: number;
    repository: { name: string; owner: { login: string } };
    pull_request: { head: { sha: string }; user: { login: string }; state: 'open' | 'closed' };
  };
  if (!['opened', 'synchronize', 'reopened', 'closed'].includes(body.action)) return new Response(null, { status: 204 });
  const id: PRId = { owner: body.repository.owner.login, repo: body.repository.name, number: body.number };
  await doFor(env, id).recordWebhook(id, {
    action: body.action,
    head_sha: body.pull_request.head.sha,
    author: body.pull_request.user.login,
    open: body.pull_request.state === 'open',
  });
  return json({ ok: true });
}

// ---- bundle intake ---------------------------------------------------------

const MAX_TAR_BYTES = 200 * 1024 * 1024;

async function intake(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'OIDC bearer token required');
  const claims = await verifyActionsToken(auth.slice(7).trim(), env.GITHUB_OIDC_AUDIENCE);

  const form = await req.formData();
  const dubFile = form.get('dub.json');
  const tarFile = form.get('evidence.tar');
  if (!(dubFile instanceof File)) throw new HttpError(400, 'multipart field dub.json (file) required');
  let bundle: Bundle;
  try {
    bundle = JSON.parse(await dubFile.text()) as Bundle;
  } catch {
    throw new HttpError(400, 'dub.json is not JSON');
  }
  validateBundle(bundle);
  if (bundle.repo.toLowerCase() !== claims.repository.toLowerCase()) throw new HttpError(403, `bundle repo ${bundle.repo} does not match token ${claims.repository}`);
  if (bundle.pr !== claims.pr) throw new HttpError(403, `bundle pr ${bundle.pr} does not match token ref ${claims.ref}`);
  const [owner, repo] = bundle.repo.split('/') as [string, string];
  const id: PRId = { owner, repo, number: bundle.pr };

  // The SHA must belong to this PR: the head, or a commit GitHub lists under it.
  const tok = await app(env).installationToken(owner, repo);
  const pr = await gh.getPR(tok, owner, repo, bundle.pr);
  if (pr.head.sha !== bundle.sha) {
    const prs = await gh.pullsForCommit(tok, owner, repo, bundle.sha);
    if (!prs.some((p) => p.number === bundle.pr)) throw new HttpError(422, `sha ${bundle.sha} is not part of PR #${bundle.pr}`);
  }

  const stub = doFor(env, id);
  // Keep the DO's picture of the PR fresh even if a webhook was missed.
  await stub.recordWebhook(id, { action: 'sync', head_sha: pr.head.sha, author: pr.user.login, open: pr.state === 'open' });
  const state = await stub.state(id);

  const pre = prefix(id, bundle.sha, bundle.bundle_id);
  const received_at = new Date().toISOString();

  // Evidence files.
  if (tarFile instanceof File) {
    if (tarFile.size > MAX_TAR_BYTES) throw new HttpError(413, 'evidence.tar too large');
    const buf = new Uint8Array(await tarFile.arrayBuffer());
    for (const entry of readTar(buf)) {
      if (entry.name === 'dub.json' || entry.name === 'meta.json') continue;
      await env.BUNDLES.put(`${pre}/${entry.name}`, entry.data, { httpMetadata: { contentType: contentType(entry.name) } });
    }
  }
  await env.BUNDLES.put(`${pre}/dub.json`, JSON.stringify(bundle), { httpMetadata: { contentType: 'application/json' } });

  // meta.json: previous, criteria_diff, rubric hits (contract decision 2).
  const previous = previousFor(state.bundles, state.verdicts, bundle.sha, received_at);
  let prevCriteria: Criterion[] | null = null;
  if (previous) {
    const prevObj = await env.BUNDLES.get(`${prefix(id, previous.sha, previous.bundle_id)}/dub.json`);
    if (prevObj) prevCriteria = ((await prevObj.json()) as Bundle).brief?.criteria ?? null;
  }
  const { base_sha, rubric } = await repoConfig(env, id);
  const meta: Meta = {
    bundle_id: bundle.bundle_id,
    sha: bundle.sha,
    received_at,
    head_at_intake: pr.head.sha === bundle.sha,
    previous,
    criteria_diff: criteriaDiff(prevCriteria, bundle.brief.criteria),
    rubric: { base_sha, hits: rubric ? rubricHits(rubric, bundle.diff?.areas) : [] },
  };
  await env.BUNDLES.put(`${pre}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });

  await stub.recordBundle(id, {
    bundle_id: bundle.bundle_id,
    sha: bundle.sha,
    received_at,
    criteria: bundle.criteria.map((c) => ({ id: c.id, status: c.status })),
  });

  return json({ bundle_id: bundle.bundle_id, url: `${env.PUBLIC_URL}/r/${owner}/${repo}/pull/${bundle.pr}?sha=${bundle.sha}` }, 201);
}

function validateBundle(b: Bundle): void {
  const bad = (m: string): never => {
    throw new HttpError(400, `dub.json: ${m}`);
  };
  if (typeof b !== 'object' || b === null) bad('not an object');
  if (b.version !== 0) bad(`unsupported version ${b.version}`);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(b.bundle_id ?? '')) bad('bundle_id must be a ULID');
  if (!/^[^/]+\/[^/]+$/.test(b.repo ?? '')) bad('repo must be owner/name');
  if (!Number.isInteger(b.pr) || b.pr <= 0) bad('pr must be a positive integer');
  if (!/^[0-9a-f]{40}$/.test(b.sha ?? '')) bad('sha must be a full 40-hex SHA');
  if (!b.brief || typeof b.brief.text !== 'string' || !Array.isArray(b.brief.criteria)) bad('brief.text and brief.criteria required');
  if (b.brief.criteria.length === 0) bad('brief has no criteria');
  if (!Array.isArray(b.criteria)) bad('criteria must be an array');
  const ids = new Set<string>();
  for (const c of b.brief.criteria) {
    if (!/^[a-z][a-z0-9-]*$/.test(c.id)) bad(`criterion id ${c.id} is not stable-id shaped`);
    if (ids.has(c.id)) bad(`duplicate criterion id ${c.id}`);
    ids.add(c.id);
    if (!['visual', 'behaviour', 'check', 'judgment'].includes(c.kind)) bad(`criterion ${c.id} has unknown kind ${c.kind}`);
  }
  for (const c of b.criteria) {
    if (!['pass', 'fail', 'error', 'none'].includes(c.status)) bad(`criterion ${c.id} has unknown status ${c.status}`);
    for (const e of c.evidence ?? []) if (e.path.includes('..') || e.path.startsWith('/')) bad(`evidence path ${e.path} escapes the bundle`);
  }
}

function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      webm: 'video/webm',
      mp4: 'video/mp4',
      json: 'application/json',
      zip: 'application/zip',
      txt: 'text/plain; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      ts: 'text/plain; charset=utf-8',
      html: 'text/html; charset=utf-8',
    }[ext] ?? 'application/octet-stream'
  );
}

// ---- serving ---------------------------------------------------------------

async function loadBundle(env: Env, id: PRId, sha: string, bundleId: string): Promise<{ bundle: Bundle; meta: Meta } | null> {
  const pre = prefix(id, sha, bundleId);
  const [b, m] = await Promise.all([env.BUNDLES.get(`${pre}/dub.json`), env.BUNDLES.get(`${pre}/meta.json`)]);
  if (!b) return null;
  const bundle = (await b.json()) as Bundle;
  const meta: Meta = m
    ? ((await m.json()) as Meta)
    : { bundle_id: bundleId, sha, received_at: '', head_at_intake: false, previous: null, criteria_diff: [], rubric: { base_sha: null, hits: [] } };
  return { bundle, meta };
}

function pickBundle(state: FullState, sha: string | null): { sha: string; bundle_id: string; count: number } | null {
  const want = sha ?? state.pr.head_sha ?? state.bundles[0]?.sha ?? null;
  if (!want) return null;
  const forSha = state.bundles.filter((b) => b.sha === want || (sha && b.sha.startsWith(sha)));
  if (!forSha.length) return null;
  const newest = forSha[0]!;
  return { sha: newest.sha, bundle_id: newest.bundle_id, count: forSha.length };
}

async function reviewPage(req: Request, env: Env, id: PRId, sha: string | null): Promise<Response> {
  let user: User;
  try {
    user = await requireUser(req, env);
  } catch (e) {
    if (e instanceof Redirect) return new Response(null, { status: 302, headers: { location: e.to } });
    throw e;
  }
  const perm = await requirePermission(env, user, id, 'read');
  const stub = doFor(env, id);
  const state = await stub.state(id);
  const pick = pickBundle(state, sha);
  if (!pick) {
    return renderSimple(
      `#${id.number} · waiting for a bundle`,
      `<p>No evidence bundle has arrived for ${esc(id.owner)}/${esc(id.repo)} #${id.number}${sha ? ` at <code>${esc(sha)}</code>` : ''} yet. The review-app workflow uploads one after each deploy.</p>`,
      404,
    );
  }
  const loaded = await loadBundle(env, id, pick.sha, pick.bundle_id);
  if (!loaded) return renderSimple('Bundle missing', '<p>The bundle is recorded but its files are missing from storage.</p>', 500);
  const { config } = await repoConfig(env, id);
  const effective = state.verdicts.filter((v) => v.sha === pick.sha).sort((a, b) => b.seq - a.seq)[0] ?? null;
  const can_review =
    atLeast(perm, 'write') && config.reviewers.includes(user.login.toLowerCase()) && state.pr.author?.toLowerCase() !== user.login.toLowerCase();
  const html = renderReviewPage({
    owner: id.owner,
    repo: id.repo,
    number: id.number,
    viewer: user.login,
    can_review,
    head_sha: state.pr.head_sha,
    bundle: loaded.bundle,
    meta: loaded.meta,
    bundle_base: `/api/bundles/${id.owner}/${id.repo}/${id.number}/${pick.sha}/${pick.bundle_id}`,
    verdicts: state.verdicts,
    failed_deliveries: state.deliveries.filter((d) => d.state === 'failed').map((d) => ({ effect: d.effect, last_error: d.last_error })),
    newer_bundle_exists: Boolean(effective && effective.bundle_id !== pick.bundle_id),
    all_bundles_for_sha: pick.count,
  });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

async function prState(req: Request, env: Env, id: PRId): Promise<Response> {
  const user = await requireUser(req, env);
  await requirePermission(env, user, id, 'read');
  const state = await doFor(env, id).state(id);
  return json(
    {
      head_sha: state.pr.head_sha,
      open: state.pr.open,
      author: state.pr.author,
      reopen_seq: state.pr.reopen_seq,
      bundles: state.bundles,
      verdicts: state.verdicts,
      deliveries: state.deliveries,
    },
    200,
    { 'cache-control': 'no-store' },
  );
}

async function bundleFile(req: Request, env: Env, id: PRId, sha: string, bundleId: string, path: string): Promise<Response> {
  const user = await requireUser(req, env);
  await requirePermission(env, user, id, 'read');
  if (path.split('/').some((s) => s === '..')) throw new HttpError(400, 'bad path');
  const obj = await env.BUNDLES.get(`${prefix(id, sha, bundleId)}/${path}`);
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('x-content-type-options', 'nosniff');
  if (!headers.get('content-type')) headers.set('content-type', contentType(path));
  return new Response(obj.body, { headers });
}

// ---- verdicts --------------------------------------------------------------

interface VerdictBody {
  owner: string;
  repo: string;
  pr: number;
  sha: string;
  bundle_id: string;
  verdict: 'dub' | 'revise' | 'reject';
  note?: string;
  suggest_rule?: boolean;
  used?: string[];
  because?: string[];
}

async function submitVerdict(req: Request, env: Env): Promise<Response> {
  const user = await requireUser(req, env);
  checkOrigin(req, env, user);
  const body = (await req.json().catch(() => null)) as VerdictBody | null;
  if (!body) throw new HttpError(400, 'JSON body required');
  for (const k of ['owner', 'repo', 'sha', 'bundle_id', 'verdict'] as const) if (!body[k]) throw new HttpError(400, `${k} required`);
  if (!['dub', 'revise', 'reject'].includes(body.verdict)) throw new HttpError(400, 'verdict must be dub, revise or reject');
  const id: PRId = { owner: body.owner, repo: body.repo, number: Number(body.pr) };

  // Authority: write access, on the reviewer list, and never the PR author.
  const perm = await requirePermission(env, user, id, 'write');
  const { config } = await repoConfig(env, id);
  if (!config.reviewers.includes(user.login.toLowerCase())) throw new HttpError(403, `@${user.login} is not in .dub/config.yml reviewers`);
  const stub = doFor(env, id);
  let state = await stub.state(id);
  if (!state.pr.author || !state.pr.head_sha) {
    const tok = await app(env).installationToken(id.owner, id.repo);
    const pr = await gh.getPR(tok, id.owner, id.repo, id.number);
    await stub.recordWebhook(id, { action: 'sync', head_sha: pr.head.sha, author: pr.user.login, open: pr.state === 'open' });
    state = await stub.state(id);
  }
  if (state.pr.author?.toLowerCase() === user.login.toLowerCase()) throw new HttpError(403, 'the PR author cannot be its reviewer');
  void perm;

  const result = await stub.submitVerdict(id, {
    sha: body.sha,
    bundle_id: body.bundle_id,
    reviewer: user.login,
    verdict: body.verdict,
    note: body.note,
    suggest_rule: Boolean(body.suggest_rule),
    used: sanitiseList(body.used),
    because: sanitiseList(body.because),
    user_token: user.user_token,
  });
  if ('error' in result) throw new HttpError(422, result.error);
  return json(result, 201);
}

function sanitiseList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && /^[a-z_]{1,40}$/.test(x)).slice(0, 10);
}

// ---- dub pr ----------------------------------------------------------------

async function createPR(req: Request, env: Env): Promise<Response> {
  const user = await requireUser(req, env);
  checkOrigin(req, env, user);
  const body = (await req.json().catch(() => null)) as { owner: string; repo: string; head: string; base?: string; title: string; body?: string; draft?: boolean } | null;
  if (!body) throw new HttpError(400, 'JSON body required');
  for (const k of ['owner', 'repo', 'head', 'title'] as const) if (!body[k]) throw new HttpError(400, `${k} required`);
  const id: PRId = { owner: body.owner, repo: body.repo, number: 0 };
  await requirePermission(env, user, id, 'write');
  const { config } = await repoConfig(env, id);
  const tok = await app(env).installationToken(id.owner, id.repo);
  const pr = await gh.createPR(tok, id.owner, id.repo, {
    head: body.head,
    base: body.base ?? config.base,
    title: body.title,
    body: `${body.body ?? ''}\n\n<!-- dub:pr opened by @${user.login} -->`.trim(),
    draft: Boolean(body.draft),
  });
  return json({ number: pr.number, url: pr.html_url }, 201);
}
