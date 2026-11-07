// GitHub Actions OIDC: CI can upload a bundle but never approve one.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

export interface ActionsClaims {
  repository: string;
  event_name: string;
  ref: string;
  sha: string;
  run_id: string;
  workflow: string;
  /** e.g. `o/r/.github/workflows/review-app.yml@refs/pull/1/merge` */
  job_workflow_ref: string;
  /** The file name from job_workflow_ref, e.g. `review-app.yml`. */
  workflow_file: string;
  pr: number;
}

let defaultKeys: JWTVerifyGetKey | null = null;

export class OidcError extends Error {}

export async function verifyActionsToken(
  token: string,
  audience: string,
  getKey?: JWTVerifyGetKey,
): Promise<ActionsClaims> {
  const keys = getKey ?? (defaultKeys ??= createRemoteJWKSet(new URL(GITHUB_JWKS_URL)));
  let payload: Record<string, unknown>;
  try {
    const r = await jwtVerify(token, keys, { issuer: GITHUB_OIDC_ISSUER, audience });
    payload = r.payload as Record<string, unknown>;
  } catch (e) {
    throw new OidcError(`invalid OIDC token: ${(e as Error).message}`);
  }
  const str = (k: string): string => {
    const v = payload[k];
    if (typeof v !== 'string' || !v) throw new OidcError(`OIDC token missing ${k}`);
    return v;
  };
  const event_name = str('event_name');
  if (event_name !== 'pull_request') throw new OidcError(`OIDC event_name must be pull_request, got ${event_name}`);
  const ref = str('ref');
  const m = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
  if (!m) throw new OidcError(`OIDC ref must be refs/pull/<n>/merge, got ${ref}`);
  const repository = str('repository');
  // The workflow that minted the token must live in the repo itself, not in a
  // reusable workflow somewhere else.
  const job_workflow_ref = str('job_workflow_ref');
  const prefix = `${repository}/.github/workflows/`;
  if (!job_workflow_ref.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new OidcError(`OIDC job_workflow_ref must start with ${prefix}, got ${job_workflow_ref}`);
  }
  const workflow_file = job_workflow_ref.slice(prefix.length).split('@')[0] ?? '';
  return {
    repository,
    event_name,
    ref,
    sha: str('sha'),
    run_id: String(payload.run_id ?? ''),
    workflow: String(payload.workflow ?? ''),
    job_workflow_ref,
    workflow_file,
    pr: Number(m[1]),
  };
}
