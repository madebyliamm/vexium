// business-partner — the AI business partner on the BUSINESS screen. Request handling only; every dependency is injected so
// supabase/tests/business_partner.test.ts runs it against an in-memory fake. Wiring (PostgREST, GoTrue, Anthropic) is in index.ts.
//
//   POST { project_id }   Authorization: Bearer <user token>
//   200 { status: 'ok', advice, cents }          recommendations that the numbers back up (advice.recommendations may be empty)
//   200 { status: 'not_enough_data', message }   data_level is none/early: no model call, no cost
//   401 not signed in · 404 not your project · 409 not_live / no_state / state_old · 402 usage_limit · 429 rate_limited
//   503 ai_unavailable · 502 ai_failed · 400 bad request
//
// The model is grounded ONLY in the saved `business_state` (the numbers the owner is looking at) plus the plan and manifest: see
// _shared/advice.ts, which also decides which of its recommendations survive. Nothing the model says is stored; the studio keeps it.
import { validateArtifact, type BusinessState, type Manifest, type Plan } from '../_shared/artifacts.ts';
import { factsOf, groundAdvice, parseReply, partnerPrompt, type Advice } from '../_shared/advice.ts';

/** A saved state older than this is not what the owner is looking at any more — open the numbers again first. */
export const STATE_MAX_AGE_MS = 30 * 60_000;
/** Each ask costs the owner credits: this many an hour is plenty for a human. */
export const ASKS_PER_HOUR = 12;
export const MAX_TOKENS = 1500;

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string | null;
  published_version: number | null;
}
export interface SavedArtifact { version: number; data: Record<string, unknown>; created_at: string }

/** What a model call can fail with. `credit` = the provider account is out of credit / the key is rejected (the owner is never told that). */
export class ModelError extends Error {
  kind: 'credit' | 'busy' | 'other';
  constructor(kind: 'credit' | 'busy' | 'other', message: string) {
    super(message);
    this.kind = kind;
  }
}
export interface ModelReply { text: string; inputTokens: number; outputTokens: number }

export interface Deps {
  now(): Date;
  /** GoTrue-verified user id of the bearer token, or null. */
  userId(authHeader: string | null): Promise<string | null>;
  project(id: string): Promise<ProjectRow | null>;
  isMember(projectId: string, userId: string): Promise<boolean>;
  latestArtifact(projectId: string, kind: 'plan' | 'manifest' | 'business_state'): Promise<SavedArtifact | null>;
  /** Counts one ask in the current hour; allowed=false when the limit is used up. */
  rateHit(key: string, windowSeconds: number, limit: number): Promise<{ allowed: boolean; retryAfter: number }>;
  /** A plain sentence when the user is out of credits / their trial ended; null when they may run AI. */
  usageGate(userId: string): Promise<string | null>;
  callModel(system: string, user: string, maxTokens: number): Promise<ModelReply>;
  /** Bills the call to the user (cents, rounded by the caller). */
  recordUsage(userId: string, inputTokens: number, outputTokens: number): Promise<number>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export const NOT_ENOUGH = {
  none: "There's nothing to go on yet — nobody has visited your site. Once people start visiting, I'll have something to say.",
  early: "It's too early for advice that means anything. After about 50 visitors and a week live, there's enough to read — I'll be here.",
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const uid = await deps.userId(req.headers.get('Authorization'));
  if (!uid) return json({ error: 'unauthorized' }, 401);

  let body: { project_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request', detail: 'body must be JSON' }, 400); }
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  if (!projectId || projectId.length > 100) return json({ error: 'bad_request', detail: 'project_id is required' }, 400);

  const project = await deps.project(projectId);
  // Same answer for "no such project" and "somebody else's": don't reveal which ids exist.
  if (!project || (project.user_id !== uid && !(await deps.isMember(projectId, uid)))) return json({ error: 'not_found' }, 404);
  if (project.published_version === null || project.published_version === undefined) return json({ error: 'not_live' }, 409);

  const saved = await deps.latestArtifact(projectId, 'business_state');
  if (!saved) return json({ error: 'no_state', message: 'Open your numbers first, then ask.' }, 409);
  const checked = validateArtifact('business_state', saved.data);
  if (!checked.ok) return json({ error: 'no_state', message: 'Open your numbers first, then ask.' }, 409);
  const state: BusinessState = checked.value;
  const now = deps.now();
  const age = now.getTime() - Date.parse(state.computed_at);
  if (!(age >= -60_000 && age <= STATE_MAX_AGE_MS)) return json({ error: 'state_old', message: 'Those numbers are out of date. Refresh them, then ask again.' }, 409);

  // Honest from the start: too little data is answered without calling a model (and without cost).
  const level = state.data_level ?? 'none';
  if (level !== 'ok') return json({ status: 'not_enough_data', level, message: NOT_ENOUGH[level] });

  const gate = await deps.usageGate(uid);
  if (gate) return json({ error: 'usage_limit', message: gate }, 402);
  const hit = await deps.rateHit(`partner:${uid}`, 3600, ASKS_PER_HOUR);
  if (!hit.allowed) return json({ error: 'rate_limited', message: 'You have asked a lot in the last hour. Try again a bit later.', retry_after: hit.retryAfter }, 429);

  const [planRow, manifestRow] = await Promise.all([deps.latestArtifact(projectId, 'plan'), deps.latestArtifact(projectId, 'manifest')]);
  const plan: Plan | null = planRow ? (() => { const v = validateArtifact('plan', planRow.data); return v.ok ? v.value : null; })() : null;
  const manifest: Manifest | null = manifestRow ? (() => { const v = validateArtifact('manifest', manifestRow.data); return v.ok ? v.value : null; })() : null;

  const facts = factsOf(state);
  const prompt = partnerPrompt({ name: project.name?.trim() || plan?.name || 'This site', plan, manifest, facts });

  let reply: ModelReply;
  try {
    reply = await deps.callModel(prompt.system, prompt.user, MAX_TOKENS);
  } catch (e) {
    const kind = e instanceof ModelError ? e.kind : 'other';
    console.error('[business-partner] model call failed:', kind, e instanceof Error ? e.message : e);
    if (kind === 'credit') return json({ error: 'ai_unavailable', message: 'Your business partner is not available right now. Please try again later.' }, 503);
    if (kind === 'busy') return json({ error: 'ai_unavailable', message: 'Your business partner is busy right now. Please try again in a minute.' }, 503);
    return json({ error: 'ai_failed', message: 'Something went wrong while I was looking at your numbers. Please try again.' }, 502);
  }
  const cents = await deps.recordUsage(uid, reply.inputTokens, reply.outputTokens).catch(() => 0);

  const grounded = groundAdvice(parseReply(reply.text), facts);
  if (grounded.dropped.length) console.log('[business-partner] dropped:', grounded.dropped.join(' | '));
  const advice: Advice = {
    state_version: saved.version,
    computed_at: state.computed_at,
    period_days: state.period_days,
    headline: grounded.headline,
    recommendations: grounded.recommendations,
  };
  return json({ status: 'ok', advice, cents });
}
