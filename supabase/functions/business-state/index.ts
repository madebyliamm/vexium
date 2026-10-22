// Vertly /business-state — the numbers behind the BUSINESS screen (traffic, orders, revenue, sign-ups, form entries).
// Verifies the caller with GoTrue (this function stays --no-verify-jwt, like ai-chat: the project signs tokens with ES256), checks the
// project is theirs and published, runs the read-only SQL aggregate vx_business_stats and saves the result as the `business_state`
// artifact (platform-written; clients can only read it). See handler.ts and docs/STAGES.md → "BUSINESS stage".
//
// Deploy:  supabase functions deploy business-state --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handle, type Deps } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rest = `${SUPABASE_URL}/rest/v1`;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

async function rows<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const r = await fetch(`${rest}/${path}`, { headers: svc });
  if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}`);
  const out = await r.json();
  return Array.isArray(out) ? out : [];
}

const deps: Deps = {
  now: () => new Date(),
  async userId(h) {
    if (!h?.startsWith("Bearer ")) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: h } });
      if (!res.ok) return null;
      return (await res.json())?.id ?? null;
    } catch { return null; }
  },
  async project(id) {
    const [p] = await rows<any>(`projects?id=eq.${enc(id)}&select=id,user_id,published_version,published_slug,custom_domain&limit=1`);
    return p ?? null;
  },
  async isMember(projectId, userId) {
    return (await rows(`project_members?project_id=eq.${enc(projectId)}&user_id=eq.${enc(userId)}&status=eq.accepted&select=user_id&limit=1`)).length > 0;
  },
  async username(userId) {
    const [p] = await rows<any>(`profiles?id=eq.${enc(userId)}&select=username&limit=1`);
    return typeof p?.username === "string" ? p.username : null;
  },
  async firstLiveAt(projectId) {
    const [d] = await rows<any>(`project_deploys?project_id=eq.${enc(projectId)}&status=eq.ready&select=created_at&order=created_at.asc&limit=1`);
    return d?.created_at ? new Date(d.created_at) : null;
  },
  async latestArtifact(projectId, kind) {
    const [a] = await rows<any>(`project_artifacts?project_id=eq.${enc(projectId)}&kind=eq.${kind}&select=version,data,created_at&order=version.desc&limit=1`);
    return a ?? null;
  },
  async stats(projectId, days, now) {
    const r = await fetch(`${rest}/rpc/vx_business_stats`, {
      method: "POST", headers: svc, body: JSON.stringify({ p_project: projectId, p_days: days, p_now: now.toISOString() }),
    });
    if (!r.ok) throw new Error(`vx_business_stats ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return await r.json();
  },
  async saveState(projectId, state) {
    const r = await fetch(`${rest}/rpc/put_project_artifact`, {
      method: "POST", headers: svc, body: JSON.stringify({ p_project: projectId, p_kind: "business_state", p_data: state }),
    });
    if (!r.ok) throw new Error(`put_project_artifact ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return { version: (await r.json()).version as number };
  },
};

serve(async (req) => {
  try {
    return await handle(req, deps);
  } catch (e) {
    console.error("[business-state]", e);
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
