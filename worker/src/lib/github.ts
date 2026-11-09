// GitHub REST through an injectable fetch. App auth (JWT → installation
// token) for App-credentialed effects; a user token for the human's review.
import { SignJWT, importPKCS8 } from 'jose';

export type Fetch = typeof fetch;
/** Resolves the global at call time, so tests can swap `globalThis.fetch`. */
export const lazyFetch: Fetch = (input, init) => globalThis.fetch(input, init);
const API = 'https://api.github.com';
const UA = 'dub (dubthee.dev)';

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export interface AppCredentials {
  appId: string;
  privateKey: string; // PKCS#8 PEM. GitHub gives PKCS#1; see docs/setup.md for the conversion.
}

export async function appJwt(creds: AppCredentials, now = Date.now()): Promise<string> {
  const key = await importPKCS8(normalisePem(creds.privateKey), 'RS256');
  const iat = Math.floor(now / 1000) - 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(iat)
    .setExpirationTime(iat + 9 * 60)
    .setIssuer(creds.appId)
    .sign(key);
}

function normalisePem(pem: string): string {
  // Secrets pasted through `wrangler secret put` often lose their newlines.
  if (pem.includes('\n')) return pem;
  return pem.replace(/\\n/g, '\n');
}

interface CachedToken {
  token: string;
  expires: number;
}

/** Installation tokens, one per repo, cached until a minute before expiry. */
export class AppAuth {
  private cache = new Map<string, CachedToken>();
  constructor(
    private creds: AppCredentials,
    private fetchFn: Fetch = lazyFetch,
  ) {}

  async installationToken(owner: string, repo: string, now = Date.now()): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.expires - 60_000 > now) return hit.token;
    const jwt = await appJwt(this.creds, now);
    const inst = await ghJson<{ id: number }>(this.fetchFn, `/repos/${owner}/${repo}/installation`, { token: jwt });
    const tok = await ghJson<{ token: string; expires_at: string }>(
      this.fetchFn,
      `/app/installations/${inst.id}/access_tokens`,
      { token: jwt, method: 'POST', body: {} },
    );
    this.cache.set(key, { token: tok.token, expires: Date.parse(tok.expires_at) });
    return tok.token;
  }
}

export interface RequestOpts {
  token: string;
  method?: string;
  body?: unknown;
  accept?: string;
}

export async function ghJson<T>(fetchFn: Fetch, path: string, opts: RequestOpts): Promise<T> {
  const res = await ghRaw(fetchFn, path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function ghRaw(fetchFn: Fetch, path: string, opts: RequestOpts): Promise<Response> {
  const url = path.startsWith('http') ? path : API + path;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: opts.accept ?? 'application/vnd.github+json',
    'user-agent': UA,
    'x-github-api-version': '2022-11-28',
  };
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetchFn(url, init);
  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    const msg = (body as { message?: string } | undefined)?.message ?? res.statusText;
    throw new GitHubError(res.status, `${opts.method ?? 'GET'} ${path}: ${res.status} ${msg}`, body);
  }
  return res;
}

export interface PR {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
  user: { login: string };
  html_url: string;
  title?: string;
  body?: string | null;
}

export interface PRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface WorkflowRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

export class GitHub {
  constructor(private fetchFn: Fetch = lazyFetch) {}

  /** Every file in the PR with its patch, up to 300 files (GitHub's own cap). */
  async prFiles(token: string, owner: string, repo: string, n: number): Promise<PRFile[]> {
    const out: PRFile[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await ghJson<PRFile[]>(this.fetchFn, `/repos/${owner}/${repo}/pulls/${n}/files?per_page=100&page=${page}`, { token });
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /** Workflow runs for one commit, newest first. */
  async workflowRuns(token: string, owner: string, repo: string, q: { event?: string; head_sha?: string }): Promise<WorkflowRun[]> {
    const params = new URLSearchParams({ per_page: '30' });
    if (q.event) params.set('event', q.event);
    if (q.head_sha) params.set('head_sha', q.head_sha);
    const r = await ghJson<{ workflow_runs: WorkflowRun[] }>(this.fetchFn, `/repos/${owner}/${repo}/actions/runs?${params}`, { token });
    return r.workflow_runs ?? [];
  }

  /** Re-run every job of a completed run. Needs Actions: write on the App. */
  async rerunWorkflowRun(token: string, owner: string, repo: string, runId: number): Promise<void> {
    await ghRaw(this.fetchFn, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, { token, method: 'POST' });
  }

  getPR(token: string, owner: string, repo: string, n: number): Promise<PR> {
    return ghJson<PR>(this.fetchFn, `/repos/${owner}/${repo}/pulls/${n}`, { token });
  }

  pullsForCommit(token: string, owner: string, repo: string, sha: string): Promise<{ number: number }[]> {
    return ghJson<{ number: number }[]>(this.fetchFn, `/repos/${owner}/${repo}/commits/${sha}/pulls`, { token });
  }

  setStatus(
    token: string,
    owner: string,
    repo: string,
    sha: string,
    status: { state: 'pending' | 'success' | 'failure' | 'error'; description: string; target_url: string },
  ): Promise<{ id: number }> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/statuses/${sha}`, {
      token,
      method: 'POST',
      body: { context: 'dubbed', ...status, description: status.description.slice(0, 140) },
    });
  }

  createReview(token: string, owner: string, repo: string, n: number, body: string, commitId?: string): Promise<{ id: number }> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/pulls/${n}/reviews`, {
      token,
      method: 'POST',
      body: { event: 'COMMENT', body, ...(commitId ? { commit_id: commitId } : {}) },
    });
  }

  updateReview(token: string, owner: string, repo: string, n: number, reviewId: number, body: string): Promise<{ id: number }> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/pulls/${n}/reviews/${reviewId}`, {
      token,
      method: 'PUT',
      body: { body },
    });
  }

  createComment(token: string, owner: string, repo: string, n: number, body: string): Promise<{ id: number }> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/issues/${n}/comments`, { token, method: 'POST', body: { body } });
  }

  updateComment(token: string, owner: string, repo: string, commentId: number, body: string): Promise<{ id: number }> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      token,
      method: 'PATCH',
      body: { body },
    });
  }

  /** Find an existing sticky comment (by marker) so a lost gh_id can still edit. */
  async findComment(token: string, owner: string, repo: string, n: number, marker: string): Promise<number | null> {
    const list = await ghJson<{ id: number; body: string }[]>(
      this.fetchFn,
      `/repos/${owner}/${repo}/issues/${n}/comments?per_page=100`,
      { token },
    );
    const hit = list.find((c) => c.body && c.body.includes(marker));
    return hit ? hit.id : null;
  }

  closePR(token: string, owner: string, repo: string, n: number): Promise<PR> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/pulls/${n}`, { token, method: 'PATCH', body: { state: 'closed' } });
  }

  createPR(
    token: string,
    owner: string,
    repo: string,
    pr: { head: string; base: string; title: string; body?: string; draft?: boolean },
  ): Promise<PR> {
    return ghJson(this.fetchFn, `/repos/${owner}/${repo}/pulls`, { token, method: 'POST', body: pr });
  }

  /** File content at a ref, decoded, or null when missing. */
  async getContent(token: string, owner: string, repo: string, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    try {
      const res = await ghJson<{ content: string; encoding: string; sha: string }>(
        this.fetchFn,
        `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        { token },
      );
      if (res.encoding !== 'base64') return null;
      return { text: b64decode(res.content.replace(/\n/g, '')), sha: res.sha };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /** Base branch head SHA. */
  async branchSha(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const b = await ghJson<{ commit: { sha: string } }>(this.fetchFn, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { token });
      return b.commit.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async collaboratorPermission(token: string, owner: string, repo: string, login: string): Promise<Permission> {
    try {
      const r = await ghJson<{ permission: string }>(
        this.fetchFn,
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        { token },
      );
      return normalisePermission(r.permission);
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) return 'none';
      throw e;
    }
  }

  viewer(userToken: string): Promise<{ login: string; id: number }> {
    return ghJson(this.fetchFn, '/user', { token: userToken });
  }
}

export type Permission = 'none' | 'read' | 'write' | 'admin';

export function normalisePermission(p: string): Permission {
  switch (p) {
    case 'admin':
      return 'admin';
    case 'write':
    case 'maintain':
      return 'write';
    case 'read':
    case 'triage':
      return 'read';
    default:
      return 'none';
  }
}

export function atLeast(p: Permission, want: Permission): boolean {
  const order: Permission[] = ['none', 'read', 'write', 'admin'];
  return order.indexOf(p) >= order.indexOf(want);
}

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
