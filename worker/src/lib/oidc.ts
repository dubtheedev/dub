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
  return {
    repository: str('repository'),
    event_name,
    ref,
    sha: str('sha'),
    run_id: String(payload.run_id ?? ''),
    workflow: String(payload.workflow ?? ''),
    pr: Number(m[1]),
  };
}
