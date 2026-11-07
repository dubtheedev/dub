import { describe, expect, it } from 'vitest';
import { hmacHex, parseCookies, readCliToken, readSession, signCliToken, signSession, timingSafeEqual } from '../src/lib/session';

const S = 'secret-secret-secret-secret-secret';

describe('sessions', () => {
  it('round-trips and rejects the wrong secret', async () => {
    const t = await signSession(S, { login: 'ryan', user_token: 'gho_x' });
    expect(await readSession(S, t)).toMatchObject({ login: 'ryan', user_token: 'gho_x' });
    expect(await readSession('other-secret-other-secret', t)).toBeNull();
    expect(await readSession(S, 'garbage')).toBeNull();
  });
  it('keeps CLI tokens and sessions distinct', async () => {
    const cli = await signCliToken(S, { login: 'anson', user_token: 'gho_y' });
    expect(await readCliToken(S, cli)).toEqual({ login: 'anson', user_token: 'gho_y' });
    expect(await readSession(S, cli)).toBeNull();
    const sess = await signSession(S, { login: 'anson', user_token: 'gho_y' });
    expect(await readCliToken(S, sess)).toBeNull();
  });
  it('parses cookies and compares in constant time', async () => {
    expect(parseCookies('a=1; dub_session=x%20y')).toEqual({ a: '1', dub_session: 'x y' });
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(await hmacHex('k', new TextEncoder().encode('v'))).toMatch(/^[0-9a-f]{64}$/);
  });
});
