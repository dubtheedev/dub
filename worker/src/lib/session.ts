// Signed cookie sessions and CLI tokens, both HMAC-SHA256 over SESSION_SECRET.
import { SignJWT, jwtVerify } from 'jose';

export interface Session {
  login: string;
  user_token: string; // GitHub user-to-server token
  expires: number; // ms epoch
}

export const SESSION_COOKIE = 'dub_session';
const SESSION_TTL_MS = 8 * 60 * 60_000; // GitHub user tokens from an App last 8h.
const CLI_TTL_S = 30 * 24 * 60 * 60;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(secret: string, s: Omit<Session, 'expires'>, now = Date.now()): Promise<string> {
  const expires = now + SESSION_TTL_MS;
  return new SignJWT({ login: s.login, ut: s.user_token, kind: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expires / 1000))
    .sign(key(secret));
}

export async function readSession(secret: string, token: string | null | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== 'session' || typeof payload.login !== 'string' || typeof payload.ut !== 'string') return null;
    return { login: payload.login, user_token: payload.ut, expires: (payload.exp ?? 0) * 1000 };
  } catch {
    return null;
  }
}

export interface CliToken {
  login: string;
  user_token: string;
}

export async function signCliToken(secret: string, t: CliToken, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ login: t.login, ut: t.user_token, kind: 'cli' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLI_TTL_S)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
}

export async function readCliToken(secret: string, token: string | null | undefined): Promise<CliToken | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== 'cli' || typeof payload.login !== 'string' || typeof payload.ut !== 'string') return null;
    return { login: payload.login, user_token: payload.ut };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value: string, secure: boolean, maxAgeS = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeS)}${secure ? '; Secure' : ''}`;
}

export async function hmacHex(secret: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, data as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
