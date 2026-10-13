// auth-gate — server-side username login + signup availability (closes SECURITY_FINDINGS #10).
//
// Before: auth.html asked the database "what is the email for this username?" with the public anon key
// (`get_email_by_username`), which handed any visitor the real email of any account. Now the browser sends
// {username-or-email, password}; this function resolves the username WITH THE SERVICE KEY, signs in via GoTrue and
// returns only the session. The email never leaves the server, failures are uniform, and attempts are rate limited.
//
// Pure logic with injected dependencies (no Deno globals) so it runs under `node --test`
// (supabase/tests/auth_gate.test.ts).

export interface GateDeps {
  rateHit(key: string, windowSeconds: number, limit: number, cost: number): Promise<{ allowed: boolean; retry_after: number }>;
  /** profiles.username (case-insensitive exact match) → user id */
  userIdByUsername(username: string): Promise<string | null>;
  /** auth.users email for an id (admin API) */
  emailOfUser(userId: string): Promise<string | null>;
  signIn(email: string, password: string, ip: string): Promise<{ ok: true; session: unknown } | { ok: false; code?: string }>;
  availability(username: string, email: string): Promise<{ username_taken: boolean; email_taken: boolean }>;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WRONG = 'Wrong username or password.';

const RL = {
  failIdent: { window: 900, max: 5 },
  failIp: { window: 900, max: 20 },
  availIp: { window: 600, max: 30 },
};

export function clientIp(req: Request): string {
  const h = req.headers;
  return ((h.get('cf-connecting-ip') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0].trim()) || 'unknown').slice(0, 64);
}

/** Accounts created before real emails were collected signed up as <username>@vexium.ai. */
export const legacyEmailFor = (username: string): string => username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '') + '@vexium.ai';

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') || 0) > 4096) return null;
  const text = await req.text();
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export async function handle(req: Request, deps: GateDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });

  const body = await readBody(req);
  if (!body) return json(400, { error: 'invalid request' });
  const ip = clientIp(req);

  try {
    if (body.action === 'login') return await login(body, ip, deps);
    if (body.action === 'availability') return await availability(body, ip, deps);
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('[auth-gate] failed', e);
    return json(503, { error: 'Something went wrong. Please try again.' });
  }
}

async function login(body: Record<string, unknown>, ip: string, deps: GateDeps): Promise<Response> {
  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!identifier || identifier.length > 254 || !password || password.length > 256) return json(400, { error: 'Enter your username or email and your password.' });

  const ident = identifier.toLowerCase();
  const kIdent = `ag:login:e:${ident}`;
  const kIp = `ag:login:i:${ip}`;

  // Failures-only counters: peek (cost 0) before doing any work, record (cost 1) only when sign-in failed.
  const [pe, pi] = await Promise.all([deps.rateHit(kIdent, RL.failIdent.window, RL.failIdent.max, 0), deps.rateHit(kIp, RL.failIp.window, RL.failIp.max, 0)]);
  if (!pe.allowed || !pi.allowed) {
    const retry = Math.max(pe.retry_after, pi.retry_after);
    return json(429, { error: 'Too many failed attempts. Try again in a few minutes.' }, { 'Retry-After': String(retry) });
  }

  // Resolve to an email. Unknown usernames fall through to the legacy pseudo-address so that "no such user" costs the
  // same GoTrue round-trip as "wrong password" and the response is identical.
  let email: string;
  if (identifier.includes('@')) {
    email = ident;
  } else {
    const id = USERNAME_RE.test(identifier) ? await deps.userIdByUsername(identifier) : null;
    email = (id && (await deps.emailOfUser(id))) || legacyEmailFor(identifier);
  }

  const result = await deps.signIn(email, password, ip);
  if (!result.ok) {
    await Promise.all([deps.rateHit(kIdent, RL.failIdent.window, RL.failIdent.max, 1), deps.rateHit(kIp, RL.failIp.window, RL.failIp.max, 1)]);
    // Only the "confirm your email" state is distinguished; GoTrue reports it after the password already matched.
    if (result.code === 'email_not_confirmed') return json(403, { error: 'Please confirm your email first — check your inbox.', code: 'email_not_confirmed' });
    return json(401, { error: WRONG, code: 'invalid_credentials' });
  }
  return json(200, { success: true, session: result.session });
}

async function availability(body: Record<string, unknown>, ip: string, deps: GateDeps): Promise<Response> {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(username) || !EMAIL_RE.test(email) || email.length > 254) return json(400, { error: 'invalid request' });

  const r = await deps.rateHit(`ag:avail:i:${ip}`, RL.availIp.window, RL.availIp.max, 1);
  if (!r.allowed) return json(429, { error: 'Too many requests. Try again in a few minutes.' }, { 'Retry-After': String(r.retry_after) });

  const a = await deps.availability(username, email);
  return json(200, { success: true, username_taken: a.username_taken === true, email_taken: a.email_taken === true });
}
