import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { GITHUB_OIDC_ISSUER, verifyActionsToken } from '../src/lib/oidc';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, aud = 'dubthee.dev') =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(GITHUB_OIDC_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return { keys, sign };
}

const good = { repository: 'deeptreecorp/missive', event_name: 'pull_request', ref: 'refs/pull/87/merge', sha: 'deadbeef', run_id: '1', workflow: 'Review app' };

describe('verifyActionsToken', () => {
  it('accepts a pull_request token and extracts the PR number', async () => {
    const { keys, sign } = await setup();
    const claims = await verifyActionsToken(await sign(good), 'dubthee.dev', keys);
    expect(claims).toMatchObject({ repository: 'deeptreecorp/missive', pr: 87, sha: 'deadbeef' });
  });
  it('rejects the wrong audience, a push event, and a branch ref', async () => {
    const { keys, sign } = await setup();
    await expect(verifyActionsToken(await sign(good, 'other'), 'dubthee.dev', keys)).rejects.toThrow(/invalid OIDC/);
    await expect(verifyActionsToken(await sign({ ...good, event_name: 'push' }), 'dubthee.dev', keys)).rejects.toThrow(/pull_request/);
    await expect(verifyActionsToken(await sign({ ...good, ref: 'refs/heads/main' }), 'dubthee.dev', keys)).rejects.toThrow(/refs\/pull/);
  });
});
