// site-api request handling: every rule from docs/STEP4_DESIGN.md lives here. No Deno globals and no direct network
// access — storage, rate limiting, mail and the clock come in through `Deps`, so the whole thing runs under
// `node --test` against an in-memory fake (supabase/tests/site_api.test.ts).

import {
  cleanMetadata, COLLECTION_RE, isReserved, LIMITS, normCollection, normEmail, parseBackend, validateData,
  type Backend, type Collection,
} from './rules.ts';
import { DUMMY_HASH, hashPassword, newToken, sha256Hex, verifyPassword } from './passwords.ts';

// ── storage / environment contract ────────────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  user_id: string;
  name: string;
  /** The rules that apply right now: live deploy's `_backend` when published, else the draft's. */
  backend: unknown;
}
export interface SiteUserRow { id: string; email: string; password_hash: string; metadata: Record<string, unknown> | null }
export interface SessionRow { site_user_id: string; email: string; metadata: Record<string, unknown> | null }
export interface DataRow { id: string; data: Record<string, unknown>; created_at: string }
export interface RateResult { allowed: boolean; hits: number; retry_after: number }

export interface Store {
  getProject(id: string): Promise<ProjectInfo | null>;
  getSiteUserByEmail(projectId: string, email: string): Promise<SiteUserRow | null>;
  /** Resolves to 'exists' when (project, email) is already registered. */
  createSiteUser(projectId: string, email: string, passwordHash: string, metadata: Record<string, unknown>): Promise<{ id: string; email: string } | 'exists'>;
  createSession(tokenHash: string, projectId: string, siteUserId: string, expiresAtIso: string): Promise<void>;
  getSession(tokenHash: string, projectId: string, nowIso: string): Promise<SessionRow | null>;
  deleteSession(tokenHash: string, projectId: string): Promise<void>;
  countRows(projectId: string, collection: string): Promise<number>;
  insertRow(projectId: string, collection: string, data: Record<string, unknown>, siteUserId: string | null): Promise<{ id: string }>;
  listRows(projectId: string, collection: string, opts: { userId?: string; limit: number; beforeIso?: string }): Promise<DataRow[]>;
  getOwnRow(projectId: string, collection: string, id: string, userId: string): Promise<DataRow | null>;
  updateRow(projectId: string, collection: string, id: string, userId: string, data: Record<string, unknown>): Promise<boolean>;
  deleteRow(projectId: string, collection: string, id: string, userId: string): Promise<boolean>;
  rateHit(key: string, windowSeconds: number, limit: number, cost: number): Promise<RateResult>;
  ownerEmail(userId: string): Promise<string | null>;
}

export interface Deps {
  store: Store;
  now(): number;
  /** Keep a background task (mail) alive after the response was sent. */
  waitUntil(p: Promise<unknown>): void;
  sendMail(m: { to: string; subject: string; text: string; replyTo?: string }): Promise<void>;
}

// ── plumbing ──────────────────────────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, message: string, code: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_MS = 30 * 24 * 3600 * 1000;

// Default limits (design §4). Windows in seconds.
const RL = {
  loginFailEmail: { window: 900, max: 5 },
  loginFailIp: { window: 900, max: 30 },
  signupIp: { window: 3600, max: 5 },
  signupProjectDay: { window: 86_400, max: 200 },
  writeIp: { window: 600, max: 30 },
  writeCollectionDay: { window: 86_400, max: 2000 },
  readIp: { window: 60, max: 120 },
  notifyProject: { window: 3600, max: 20 },
};

interface Ctx {
  deps: Deps;
  project: ProjectInfo;
  backend: Backend;
  ip: string;
  body: Record<string, unknown>;
}

export function clientIp(req: Request): string {
  const h = req.headers;
  const ip = h.get('cf-connecting-ip') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0].trim();
  return (ip || 'unknown').slice(0, 64);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > LIMITS.body) throw new HttpError(413, 'request too large', 'too_large');

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > LIMITS.body) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new HttpError(413, 'request too large', 'too_large');
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  try {
    const v = JSON.parse(new TextDecoder().decode(all));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError(400, 'invalid json', 'bad_request');
}

async function rate(ctx: Ctx, key: string, rule: { window: number; max: number }, cost = 1): Promise<RateResult> {
  try {
    return await ctx.deps.store.rateHit(key, rule.window, rule.max, cost);
  } catch (e) {
    console.error('[site-api] rate limiter failed', e);
    throw new HttpError(503, 'temporarily unavailable', 'unavailable'); // fail closed
  }
}

async function enforce(ctx: Ctx, key: string, rule: { window: number; max: number }): Promise<void> {
  const r = await rate(ctx, key, rule);
  if (!r.allowed) throw new HttpError(429, 'too many requests — try again later', 'rate_limited', r.retry_after);
}

function resolveCollection(ctx: Ctx): Collection {
  const name = normCollection(ctx.body.collection);
  if (!name) throw new HttpError(400, 'collection required', 'bad_request');
  if (!COLLECTION_RE.test(name)) throw new HttpError(400, 'invalid collection name', 'bad_request');
  if (isReserved(name)) throw new HttpError(403, 'collection is reserved', 'reserved');
  const c = ctx.backend.collections.get(name);
  if (!c) throw new HttpError(404, `unknown collection: ${name}`, 'unknown_collection');
  return c;
}

interface SessionUser { id: string; email: string; metadata: Record<string, unknown> | null; tokenHash: string }

/** null = no token sent (anonymous). A token that was sent but is unknown/expired/for another site → 401. */
async function sessionUser(ctx: Ctx): Promise<SessionUser | null> {
  const t = ctx.body.token;
  if (t === undefined || t === null || t === '') return null;
  const expired = new HttpError(401, 'session expired — please sign in again', 'session_expired');
  if (typeof t !== 'string' || t.length > 200) throw expired;
  const tokenHash = await sha256Hex(t);
  const s = await ctx.deps.store.getSession(tokenHash, ctx.project.id, new Date(ctx.deps.now()).toISOString());
  if (!s) throw expired;
  return { id: s.site_user_id, email: s.email, metadata: s.metadata, tokenHash };
}

async function requireUser(ctx: Ctx): Promise<SessionUser> {
  const u = await sessionUser(ctx);
  if (!u) throw new HttpError(401, 'please sign in first', 'login_required');
  return u;
}

async function issueSession(ctx: Ctx, userId: string): Promise<{ token: string; expires_at: string }> {
  const token = newToken();
  const expires_at = new Date(ctx.deps.now() + SESSION_MS).toISOString();
  await ctx.deps.store.createSession(await sha256Hex(token), ctx.project.id, userId, expires_at);
  return { token, expires_at };
}

function requireAuthEnabled(ctx: Ctx): void {
  if (!ctx.backend.authEnabled) throw new HttpError(403, 'accounts are not enabled for this site', 'auth_disabled');
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────────────

async function signup(ctx: Ctx): Promise<Response> {
  requireAuthEnabled(ctx);
  const email = normEmail(ctx.body.email);
  const password = ctx.body.password;
  if (!email) throw new HttpError(400, 'a valid email is required', 'bad_request');
  if (typeof password !== 'string' || password.length < LIMITS.password.min) {
    throw new HttpError(400, `password must be at least ${LIMITS.password.min} characters`, 'bad_request');
  }
  if (password.length > LIMITS.password.max) throw new HttpError(400, `password must be at most ${LIMITS.password.max} characters`, 'bad_request');
  const metadata = cleanMetadata(ctx.body.metadata);
  if (!metadata) throw new HttpError(400, 'invalid metadata', 'bad_request');

  const pid = ctx.project.id;
  await enforce(ctx, `signup:i:${pid}:${ctx.ip}`, RL.signupIp);
  await enforce(ctx, `signup:p:${pid}`, RL.signupProjectDay);

  const created = await ctx.deps.store.createSiteUser(pid, email, await hashPassword(password), metadata);
  if (created === 'exists') throw new HttpError(409, 'account already exists', 'account_exists');

  const s = await issueSession(ctx, created.id);
  return json(200, { success: true, token: s.token, expires_at: s.expires_at, user: { id: created.id, email: created.email } });
}

async function login(ctx: Ctx): Promise<Response> {
  requireAuthEnabled(ctx);
  const email = normEmail(ctx.body.email);
  const password = ctx.body.password;
  if (!email || typeof password !== 'string' || !password || password.length > LIMITS.password.max) {
    throw new HttpError(400, 'email and password required', 'bad_request');
  }

  const pid = ctx.project.id;
  const kEmail = `login:e:${pid}:${email}`;
  const kIp = `login:i:${pid}:${ctx.ip}`;

  // Failures-only counters: peek first (cost 0), record (cost 1) only when the password was wrong.
  const [pe, pi] = await Promise.all([rate(ctx, kEmail, RL.loginFailEmail, 0), rate(ctx, kIp, RL.loginFailIp, 0)]);
  if (!pe.allowed || !pi.allowed) {
    throw new HttpError(429, 'too many failed attempts — try again later', 'rate_limited', Math.max(pe.retry_after, pi.retry_after));
  }

  const user = await ctx.deps.store.getSiteUserByEmail(pid, email);
  // Always run one PBKDF2 verification, even for unknown emails, so timing does not reveal which emails have accounts.
  const match = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !match) {
    await Promise.all([rate(ctx, kEmail, RL.loginFailEmail, 1), rate(ctx, kIp, RL.loginFailIp, 1)]);
    throw new HttpError(401, 'invalid email or password', 'invalid_credentials');
  }

  const s = await issueSession(ctx, user.id);
  return json(200, { success: true, token: s.token, expires_at: s.expires_at, user: { id: user.id, email: user.email } });
}

async function me(ctx: Ctx): Promise<Response> {
  const u = await requireUser(ctx);
  return json(200, { success: true, user: { id: u.id, email: u.email, metadata: u.metadata ?? {} } });
}

async function logout(ctx: Ctx): Promise<Response> {
  const t = ctx.body.token;
  if (typeof t === 'string' && t && t.length <= 200) await ctx.deps.store.deleteSession(await sha256Hex(t), ctx.project.id);
  return json(200, { success: true });
}

async function submit(ctx: Ctx): Promise<Response> {
  const c = resolveCollection(ctx);
  if (c.write === 'owner') throw new HttpError(403, 'this collection does not accept submissions', 'forbidden');
  const user = c.write === 'user' ? await requireUser(ctx) : await sessionUser(ctx);

  const pid = ctx.project.id;
  await enforce(ctx, `write:i:${pid}:${c.id}:${ctx.ip}`, RL.writeIp);
  await enforce(ctx, `write:d:${pid}:${c.id}`, RL.writeCollectionDay);

  const v = validateData(c, ctx.body.data);
  if (!v.ok) throw new HttpError(v.status, v.error, v.status === 413 ? 'too_large' : 'invalid_data');

  if ((await ctx.deps.store.countRows(pid, c.id)) >= c.maxRows) {
    throw new HttpError(409, 'this collection is full', 'collection_full');
  }
  const row = await ctx.deps.store.insertRow(pid, c.id, v.data, user?.id ?? null);

  if (c.notifyOwner) ctx.deps.waitUntil(notifyOwner(ctx, c, v.data));
  return json(200, { success: true, id: row.id, ...(v.ignored.length ? { ignored: v.ignored } : {}) });
}

async function list(ctx: Ctx): Promise<Response> {
  const c = resolveCollection(ctx);
  if (c.read === 'owner') throw new HttpError(403, 'this collection is private', 'private_collection');
  const user = c.read === 'user' ? await requireUser(ctx) : await sessionUser(ctx);

  await enforce(ctx, `read:i:${ctx.project.id}:${ctx.ip}`, RL.readIp);

  const wanted = Number(ctx.body.limit);
  const limit = Number.isInteger(wanted) && wanted >= 1 ? Math.min(wanted, LIMITS.listMax) : LIMITS.listMax;
  let beforeIso: string | undefined;
  if (ctx.body.before !== undefined && ctx.body.before !== null && ctx.body.before !== '') {
    const t = typeof ctx.body.before === 'string' ? Date.parse(ctx.body.before) : NaN;
    if (!Number.isFinite(t)) throw new HttpError(400, 'invalid before cursor', 'bad_request');
    beforeIso = new Date(t).toISOString();
  }

  // `user` collections only ever return the caller's own rows; on public ones `mine: true` asks for the same.
  const ownOnly = c.read === 'user' || (ctx.body.mine === true && !!user);
  const rows = await ctx.deps.store.listRows(ctx.project.id, c.id, { userId: ownOnly ? user!.id : undefined, limit, beforeIso });
  return json(200, { success: true, rows, ...(rows.length === limit ? { next_before: rows[rows.length - 1].created_at } : {}) });
}

async function update(ctx: Ctx): Promise<Response> {
  const c = resolveCollection(ctx);
  if (c.write === 'owner') throw new HttpError(403, 'this collection is read-only', 'forbidden');
  const user = await requireUser(ctx);
  const id = ctx.body.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpError(400, 'invalid row id', 'bad_request');

  const pid = ctx.project.id;
  await enforce(ctx, `write:i:${pid}:${c.id}:${ctx.ip}`, RL.writeIp);

  const existing = await ctx.deps.store.getOwnRow(pid, c.id, id, user.id);
  if (!existing) throw new HttpError(404, 'row not found', 'not_found');
  const patch = ctx.body.data;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new HttpError(400, 'data must be an object', 'bad_request');

  const v = validateData(c, { ...existing.data, ...(patch as Record<string, unknown>) });
  if (!v.ok) throw new HttpError(v.status, v.error, v.status === 413 ? 'too_large' : 'invalid_data');
  if (!(await ctx.deps.store.updateRow(pid, c.id, id, user.id, v.data))) throw new HttpError(404, 'row not found', 'not_found');
  return json(200, { success: true });
}

async function remove(ctx: Ctx): Promise<Response> {
  const c = resolveCollection(ctx);
  if (c.write === 'owner') throw new HttpError(403, 'this collection is read-only', 'forbidden');
  const user = await requireUser(ctx);
  const id = ctx.body.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpError(400, 'invalid row id', 'bad_request');

  await enforce(ctx, `write:i:${ctx.project.id}:${c.id}:${ctx.ip}`, RL.writeIp);
  if (!(await ctx.deps.store.deleteRow(ctx.project.id, c.id, id, user.id))) throw new HttpError(404, 'row not found', 'not_found');
  return json(200, { success: true });
}

// ── forms → email ─────────────────────────────────────────────────────────────────────────────────────

const oneLine = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/** Mails the project OWNER's account address only (never a caller-supplied recipient). Plain text; never throws. */
async function notifyOwner(ctx: Ctx, c: Collection, data: Record<string, unknown>): Promise<void> {
  try {
    const r = await ctx.deps.store.rateHit(`notify:${ctx.project.id}`, RL.notifyProject.window, RL.notifyProject.max, 1);
    if (!r.allowed) return;
    const to = await ctx.deps.store.ownerEmail(ctx.project.user_id);
    if (!to) return;

    const lines = Object.entries(data).slice(0, 30).map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${oneLine(k, 64)}: ${(val ?? '').slice(0, 2000)}`;
    });
    const emailField = c.fields.find((f) => f.type === 'email');
    const replyTo = emailField && typeof data[emailField.key] === 'string' ? (data[emailField.key] as string) : undefined;

    await ctx.deps.sendMail({
      to,
      subject: oneLine(`New ${c.id} submission — ${ctx.project.name || 'your site'}`, 150),
      text: `Someone submitted the "${c.id}" form on ${oneLine(ctx.project.name || 'your site', 100)}.\n\n${lines.join('\n')}\n\n— Vertly`,
      replyTo,
    });
  } catch (e) {
    console.error('[site-api] notify failed', e);
  }
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────────

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed', code: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });

  try {
    const body = await readJson(req);
    const { project_id, action } = body;
    if (typeof project_id !== 'string' || !PROJECT_ID_RE.test(project_id)) throw new HttpError(400, 'missing project_id', 'bad_request');
    if (typeof action !== 'string' || !action) throw new HttpError(400, 'missing action', 'bad_request');

    const project = await deps.store.getProject(project_id);
    if (!project) throw new HttpError(404, 'unknown site', 'unknown_site');
    const ctx: Ctx = { deps, project, backend: parseBackend(project.backend), ip: clientIp(req), body };

    switch (action) {
      case 'signup': return await signup(ctx);
      case 'login': return await login(ctx);
      case 'logout': return await logout(ctx);
      case 'me': return await me(ctx);
      case 'submit': return await submit(ctx);
      case 'get_data': case 'list': return await list(ctx);
      case 'update': return await update(ctx);
      case 'delete': return await remove(ctx);
      default: throw new HttpError(400, `unknown action: ${action.slice(0, 40)}`, 'bad_request');
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return json(e.status, { error: e.message, code: e.code }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
    }
    console.error('[site-api] unhandled', e);
    return json(500, { error: 'server error', code: 'server_error' });
  }
}
