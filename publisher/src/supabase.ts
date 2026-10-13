import type { Env, Route } from './types.ts';

const enc = encodeURIComponent;

function anonHeaders(env: Env): Record<string, string> {
  return { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` };
}

export function serviceHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ── route resolution (hot path, anon key) ────────────────────────────────────────────────────────────
// One RPC round trip maps a hostname (or username+slug) to the live version. Cached in the isolate for a few
// seconds: a hot site resolves from memory, and a publish/rollback is visible everywhere within TTL_MS.
const TTL_MS = 10_000;
const NEG_TTL_MS = 3_000;
const MAX_ENTRIES = 500;
const routeCache = new Map<string, { exp: number; route: Route | null }>();

export function clearRouteCache(): void {
  routeCache.clear();
}

export async function resolveRoute(env: Env, q: { host?: string; username?: string; slug?: string }): Promise<Route | null> {
  const key = q.host ? `h:${q.host}` : `u:${q.username}/${q.slug}`;
  const hit = routeCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.route;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/resolve_published_site`, {
    method: 'POST',
    headers: { ...anonHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(q.host ? { p_host: q.host } : { p_username: q.username, p_slug: q.slug }),
  });
  if (!res.ok) throw new Error(`resolve_published_site ${res.status}`);
  const rows = (await res.json()) as Route[];
  const route = Array.isArray(rows) && rows.length ? rows[0] : null;

  if (routeCache.size >= MAX_ENTRIES) routeCache.delete(routeCache.keys().next().value as string);
  routeCache.set(key, { exp: Date.now() + (route ? TTL_MS : NEG_TTL_MS), route });
  return route;
}

/** Legacy (pre-v2) sites: the whole published file map lives in projects.published_files. */
export async function fetchLegacyProject(env: Env, projectId: string): Promise<{ id: string; files: Record<string, string>; main_file: string } | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/projects?id=eq.${enc(projectId)}&select=id,published_files,files,main_file&limit=1`, {
    headers: anonHeaders(env),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string; published_files: Record<string, string> | null; files: Record<string, string> | null; main_file: string | null }>;
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  return { id: r.id, files: r.published_files || r.files || {}, main_file: r.main_file || 'index.html' };
}

// ── publish API (service role) ───────────────────────────────────────────────────────────────────────
/** Verify a user access token with GoTrue (the project signs ES256 tokens, so we never decode them ourselves). */
export async function getUser(env: Env, token: string): Promise<{ id: string } | null> {
  if (!token) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string };
  return u && u.id ? { id: u.id } : null;
}

export async function rest<T = unknown>(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<{ status: number; data: T | null }> {
  const headers = serviceHeaders(env);
  if (init.prefer) (headers as Record<string, string>).Prefer = init.prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method || 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let data: T | null = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

export { enc };
