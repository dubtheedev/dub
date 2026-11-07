// OAuth `state`: signed, and bound to the browser through a short-lived
// cookie carrying the same nonce (finding 5).
import { hmacHex, timingSafeEqual } from './session';

export const OAUTH_COOKIE = 'dub_oauth';
export const OAUTH_COOKIE_MAX_AGE_S = 600;

export interface OAuthState {
  n: string; // nonce, also in the cookie
  cli: boolean;
  next: string;
}

export async function signOAuthState(secret: string, st: OAuthState): Promise<string> {
  const payload = JSON.stringify(st);
  return `${b64url(payload)}.${await hmacHex(secret, new TextEncoder().encode(payload))}`;
}

/** Returns the state when the signature holds, else null. */
export async function readOAuthState(secret: string, state: string | null): Promise<OAuthState | null> {
  if (!state) return null;
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) return null;
  let payload: string;
  try {
    payload = b64urlDecode(payloadB64);
  } catch {
    return null;
  }
  const expect = await hmacHex(secret, new TextEncoder().encode(payload));
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const st = JSON.parse(payload) as OAuthState;
    if (typeof st.n !== 'string' || !st.n) return null;
    return { n: st.n, cli: Boolean(st.cli), next: typeof st.next === 'string' && st.next.startsWith('/') ? st.next : '/' };
  } catch {
    return null;
  }
}

export function oauthCookie(nonce: string, secure: boolean, maxAgeS = OAUTH_COOKIE_MAX_AGE_S): string {
  return `${OAUTH_COOKIE}=${encodeURIComponent(nonce)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

export function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4))));
}
