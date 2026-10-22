// business-state — the BUSINESS screen's numbers. Request handling only; every dependency is injected so supabase/tests/business_state.test.ts
// can run it against an in-memory fake. Wiring (PostgREST, GoTrue) is in index.ts.
//
//   POST { project_id, days?: 7 | 30 | 90, refresh?: boolean }   Authorization: Bearer <user token>
//   200 { state, version, cached }     the saved `business_state` artifact (recomputed at most once a minute unless the period changes)
//   401 not signed in · 404 not your project · 409 { error: 'not_live' } the site is not published · 400 bad request
import { validateArtifact, type BusinessState, type RevenueScenario } from '../_shared/artifacts.ts';
import { buildBusinessState, type RawStats } from '../_shared/business.ts';

export const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
/** A saved state younger than this is returned as is (the screen can be opened many times; the numbers are cheap but not free). */
export const FRESH_MS = 60_000;

export interface ProjectRow {
  id: string;
  user_id: string;
  published_version: number | null;
  published_slug: string | null;
  custom_domain: string | null;
}
export interface SavedArtifact { version: number; data: Record<string, unknown>; created_at: string }

export interface Deps {
  now(): Date;
  /** GoTrue-verified user id of the bearer token, or null. */
  userId(authHeader: string | null): Promise<string | null>;
  project(id: string): Promise<ProjectRow | null>;
  isMember(projectId: string, userId: string): Promise<boolean>;
  username(userId: string): Promise<string | null>;
  firstLiveAt(projectId: string): Promise<Date | null>;
  latestArtifact(projectId: string, kind: 'plan' | 'business_state'): Promise<SavedArtifact | null>;
  stats(projectId: string, days: number, now: Date): Promise<RawStats>;
  saveState(projectId: string, state: BusinessState): Promise<{ version: number }>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const uid = await deps.userId(req.headers.get('Authorization'));
  if (!uid) return json({ error: 'unauthorized' }, 401);

  let body: { project_id?: unknown; days?: unknown; refresh?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request', detail: 'body must be JSON' }, 400); }
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  if (!projectId || projectId.length > 100) return json({ error: 'bad_request', detail: 'project_id is required' }, 400);
  const asked = body.days === undefined ? 30 : body.days;
  if (!PERIODS.includes(asked as Period)) return json({ error: 'bad_request', detail: 'days must be 7, 30 or 90' }, 400);
  const days = asked as Period;

  const project = await deps.project(projectId);
  // Same answer for "no such project" and "somebody else's": don't reveal which ids exist.
  if (!project || (project.user_id !== uid && !(await deps.isMember(projectId, uid)))) return json({ error: 'not_found' }, 404);
  if (project.published_version === null || project.published_version === undefined) return json({ error: 'not_live' }, 409);

  const now = deps.now();
  const saved = await deps.latestArtifact(projectId, 'business_state');
  if (saved && body.refresh !== true && saved.data.period_days === days) {
    const age = now.getTime() - Date.parse(String(saved.data.computed_at));
    if (age >= 0 && age < FRESH_MS) return json({ state: saved.data, version: saved.version, cached: true });
  }

  const [plan, firstLive, username, stats] = await Promise.all([
    deps.latestArtifact(projectId, 'plan'),
    deps.firstLiveAt(projectId),
    deps.username(project.user_id),
    deps.stats(projectId, days, now),
  ]);
  const scenario = (plan?.data.scenario ?? null) as RevenueScenario | null;
  const backend = plan?.data.backend as { products?: unknown[] } | undefined;
  const ownHosts = [username ? `${username}.vexium.ai` : '', project.custom_domain ?? ''].filter(Boolean);

  const state = buildBusinessState({
    stats, now, firstLiveAt: firstLive, scenario,
    sells: Array.isArray(backend?.products) && backend.products.length > 0,
    ownHosts,
  });
  const ok = validateArtifact('business_state', state);
  if (!ok.ok) return json({ error: 'invalid_state', detail: ok.errors.slice(0, 3) }, 500);
  const { version } = await deps.saveState(projectId, state);
  return json({ state, version, cached: false });
}
