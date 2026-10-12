// Vexium /site-sql — scoped SQL executor for a user's site data
// Only SELECT queries allowed. Tables pre-filtered to caller's project.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function userIdFromJwt(h: string | null): string | null {
  if (!h?.startsWith("Bearer ")) return null;
  try {
    const p = h.slice(7).split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null;
  } catch { return null; }
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const BLOCKED = /\b(drop|delete|update|insert|create|alter|truncate|grant|revoke|pg_|information_schema)\b/i;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const userId = userIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return err("unauthorized", 401);

  let body: { project_id: string; query: string };
  try { body = await req.json(); } catch { return err("invalid json"); }

  const { project_id, query } = body;
  if (!project_id || !query) return err("missing project_id or query");

  const q = query.trim();
  if (!/^select\b/i.test(q)) return err("only SELECT queries are allowed");
  if (BLOCKED.test(q)) return err("query contains prohibited keywords");

  // Verify ownership
  const pr = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const proj = await pr.json();
  if (!Array.isArray(proj) || !proj.length) return err("project not found", 403);

  // Execute via Postgres RPC — wraps query in a CTE that scopes to project
  const rpcBody = JSON.stringify({ p_project_id: project_id, p_query: q });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vexium_site_query`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: rpcBody,
  });

  const result = await res.json();
  if (!res.ok) return new Response(JSON.stringify({ error: result?.message || "query failed" }), {
    status: 400, headers: { ...CORS, "Content-Type": "application/json" },
  });

  return new Response(JSON.stringify({ rows: result }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
