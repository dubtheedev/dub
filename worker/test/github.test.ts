import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { AppAuth, GitHub, GitHubError, appJwt, atLeast, normalisePermission } from '../src/lib/github';
import { decodeProtectedHeader, decodeJwt } from 'jose';

const KEY = env.GITHUB_APP_PRIVATE_KEY;

function fakeFetch(routes: Record<string, (init: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    calls.push({ url, init: init ?? {} });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ message: 'no route ' + key }), { status: 404 });
    const out = r(init ?? {});
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('appJwt', () => {
  it('signs an RS256 JWT with the app id as issuer', async () => {
    const jwt = await appJwt({ appId: '12345', privateKey: KEY }, 1_700_000_000_000);
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
    const p = decodeJwt(jwt);
    expect(p.iss).toBe('12345');
    expect(p.exp! - p.iat!).toBe(540);
  });
  it('restores newlines a secret lost on the way in', async () => {
    const flat = KEY.replace(/\n/g, '\\n');
    await expect(appJwt({ appId: '1', privateKey: flat })).resolves.toMatch(/^eyJ/);
  });
});

describe('AppAuth', () => {
  it('mints one installation token per repo and caches it until near expiry', async () => {
    let minted = 0;
    const { f, calls } = fakeFetch({
      'GET /repos/o/r/installation': () => ({ body: { id: 9 } }),
      'POST /app/installations/9/access_tokens': () => ({ status: 201, body: { token: `ghs_${++minted}`, expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    });
    const a = new AppAuth({ appId: '1', privateKey: KEY }, f);
    expect(await a.installationToken('o', 'r')).toBe('ghs_1');
    expect(await a.installationToken('o', 'r')).toBe('ghs_1');
    expect(await a.installationToken('o', 'r', Date.now() + 3600_000)).toBe('ghs_2');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(2);
  });
});

describe('GitHub', () => {
  it('posts a dubbed status with a truncated description', async () => {
    const { f, calls } = fakeFetch({ 'POST /repos/o/r/statuses/abc': () => ({ status: 201, body: { id: 1 } }) });
    await new GitHub(f).setStatus('t', 'o', 'r', 'abc', { state: 'success', description: 'x'.repeat(200), target_url: 'u' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.context).toBe('dubbed');
    expect(body.description).toHaveLength(140);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer t');
  });
  it('creates COMMENT reviews pinned to a commit', async () => {
    const { f, calls } = fakeFetch({ 'POST /repos/o/r/pulls/3/reviews': () => ({ body: { id: 55 } }) });
    expect(await new GitHub(f).createReview('t', 'o', 'r', 3, 'body', 'sha1')).toEqual({ id: 55 });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ event: 'COMMENT', body: 'body', commit_id: 'sha1' });
  });
  it('decodes file content and returns null when missing', async () => {
    const { f } = fakeFetch({
      'GET /repos/o/r/contents/.dub/config.yml': () => ({ body: { content: btoa('reviewers: [a]\n'), encoding: 'base64', sha: 'c' } }),
    });
    const g = new GitHub(f);
    expect(await g.getContent('t', 'o', 'r', '.dub/config.yml', 'main')).toEqual({ text: 'reviewers: [a]\n', sha: 'c' });
    expect(await g.getContent('t', 'o', 'r', '.dub/missing.md', 'main')).toBeNull();
  });
  it('finds a sticky comment by marker', async () => {
    const { f } = fakeFetch({
      'GET /repos/o/r/issues/1/comments': () => ({ body: [{ id: 1, body: 'hi' }, { id: 2, body: '<!-- dub:sticky -->\nx' }] }),
    });
    expect(await new GitHub(f).findComment('t', 'o', 'r', 1, '<!-- dub:sticky -->')).toBe(2);
  });
  it('maps permission levels and treats 404 as none', async () => {
    const { f } = fakeFetch({ 'GET /repos/o/r/collaborators/ryan/permission': () => ({ body: { permission: 'maintain' } }) });
    expect(await new GitHub(f).collaboratorPermission('t', 'o', 'r', 'ryan')).toBe('write');
    expect(await new GitHub(f).collaboratorPermission('t', 'o', 'r', 'nobody')).toBe('none');
    expect(normalisePermission('triage')).toBe('read');
    expect(atLeast('write', 'read')).toBe(true);
    expect(atLeast('read', 'write')).toBe(false);
  });
  it('raises GitHubError with the status', async () => {
    const { f } = fakeFetch({ 'GET /repos/o/r/pulls/9': () => ({ status: 403, body: { message: 'nope' } }) });
    await expect(new GitHub(f).getPR('t', 'o', 'r', 9)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('nope') } satisfies Partial<GitHubError>);
  });
});
