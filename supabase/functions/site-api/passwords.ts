// Password hashing + session tokens for SITE users (visitors of generated sites). Pure WebCrypto, no Deno globals,
// so it also runs under `node --test`.
//
// Stored password format:  pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>
// The iteration count lives in the string, so it can be raised later without invalidating old hashes.

const enc = new TextEncoder();

export const PBKDF2_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000; // sanity cap: a corrupt row must not be able to burn the CPU budget

// Valid-format hash of a random password nobody knows. Unknown emails are verified against this so that "no such
// account" costs the same CPU time as "wrong password" (no timing oracle for which emails have accounts).
export const DUMMY_HASH =
  'pbkdf2$sha256$600000$q3v1m0m2cGZ0m5u3pQw0bA==$KfX3nq8uWk0y8Qd1c2nT9o8mH3o7bJm0N6vHh1Zr4yE=';

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

/** True only for a well-formed hash that matches. Never throws on garbage input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return false;
  try {
    const salt = fromB64(parts[3]);
    const want = fromB64(parts[4]);
    const got = await derive(password, salt, iterations);
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 256 bits of randomness, base64url, prefixed so leaked tokens are recognisable in logs/scanners. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'vxs_' + toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
