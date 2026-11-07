// A fake GitHub (and OIDC JWKS) behind globalThis.fetch. The Worker and the
// Durable Object run in the test isolate, so swapping the global reaches both.
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { GITHUB_OIDC_ISSUER } from '../src/lib/oidc';

export interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Response;
type Handler = (call: Call, url: URL) => Reply | Promise<Reply>;

export class FakeGitHub {
  calls: Call[] = [];
  handlers = new Map<string, Handler>();
  private realFetch = globalThis.fetch;

  constructor() {
    // Defaults every DO effect needs.
    this.on('GET /repos/o/r/installation', () => ({ body: { id: 9 } }));
    this.on('POST /app/installations/9/access_tokens', () => ({ status: 201, body: { token: 'ghs_app', expires_at: new Date(Date.now() + 3600_000).toISOString() } }));
    this.on('POST /repos/o/r/statuses/*', () => ({ status: 201, body: { id: 1 } }));
    this.on('GET /repos/o/r/issues/1/comments', () => ({ body: [] }));
    this.on('POST /repos/o/r/issues/1/comments', () => ({ status: 201, body: { id: 700 } }));
    this.on('PATCH /repos/o/r/issues/comments/700', () => ({ body: { id: 700 } }));
    this.on('POST /repos/o/r/pulls/1/reviews', () => ({ body: { id: 500 } }));
    this.on('PATCH /repos/o/r/pulls/1', () => ({ body: { number: 1, state: 'closed' } }));
    this.on('GET /repos/o/r/pulls/1', () => ({
      body: { number: 1, state: 'open', merged: false, head: { sha: SHA_A, ref: 'feat', repo: { full_name: 'o/r' } }, base: { sha: 'b', ref: 'main' }, user: { login: 'agent-app[bot]' }, html_url: 'https://github.com/o/r/pull/1' },
    }));
    this.on('GET /repos/o/r/collaborators/*/permission', (c) => ({ body: { permission: c.path.includes('/ryan/') ? 'write' : c.path.includes('/reader/') ? 'read' : 'none' } }));
    this.on('GET /repos/o/r/contents/.dub/config.yml', () => ({ body: { encoding: 'base64', sha: 'c', content: btoa('reviewers: [ryan]\nbase: main\n') } }));
    this.on('GET /repos/o/r/contents/.dub/rubric.md', () => ({ body: { encoding: 'base64', sha: 'r', content: btoa('## Plain tone\nScope: email\n\n## Empty states everywhere\n') } }));
    this.on('GET /repos/o/r/branches/main', () => ({ body: { commit: { sha: 'base-sha' } } }));
    this.on('GET /user', () => ({ body: { login: 'ryan', id: 1 } }));
    this.on('POST /login/oauth/access_token', () => ({ body: { access_token: 'gho_fresh', token_type: 'bearer' } }));
  }

  on(route: string, h: Handler): void {
    this.handlers.set(route, h);
  }

  async oidcToken(claims: Record<string, unknown>, aud = 'dubthee.dev'): Promise<string> {
    const { privateKey } = await oidcKeys();
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(GITHUB_OIDC_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  }

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      if (url.host === 'token.actions.githubusercontent.com') return Response.json((await oidcKeys()).jwks);
      if (url.host !== 'api.github.com' && url.host !== 'github.com') return this.realFetch(req);
      let body: unknown = null;
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const call: Call = { method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body };
      this.calls.push(call);
      const h = this.match(call.method, url.pathname);
      if (!h) return Response.json({ message: `fake github: no route for ${call.method} ${url.pathname}` }, { status: 404 });
      const out = await h(call, url);
      if (out instanceof Response) return out;
      return Response.json(out.body ?? {}, { status: out.status ?? 200 });
    }) as typeof fetch;
  }

  uninstall(): void {
    globalThis.fetch = this.realFetch;
  }

  private match(method: string, path: string): Handler | undefined {
    for (const [route, h] of this.handlers) {
      const [m, pattern] = route.split(' ') as [string, string];
      if (m !== method) continue;
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$');
      if (re.test(path)) return h;
    }
    return undefined;
  }

  of(method: string, pathPrefix: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
  }
}

// One key pair for the whole run: the Worker caches the remote JWKS.
let keyPromise: Promise<{ privateKey: CryptoKey; jwks: { keys: JWK[] } }> | null = null;
function oidcKeys() {
  return (keyPromise ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'k1';
    return { privateKey, jwks: { keys: [jwk] } };
  })());
}

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const BUNDLE_1 = '01HX7Q000000000000000000A1';
export const BUNDLE_2 = '01HX7Q000000000000000000B2';
export const ID = { owner: 'o', repo: 'r', number: 1 };
