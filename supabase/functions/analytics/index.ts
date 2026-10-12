// Vexium /analytics — returns projects + page_views for the authenticated user
// Manually verifies JWT, uses service role for all DB queries — no RLS involved

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function userIdFromJwt(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = authHeader.slice(7).split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.sub || null;
  } catch { return null; }
}

async function dbFetch(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const userId = userIdFromJwt(req.headers.get("Authorization"));
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let since_ts = new Date(Date.now() - 7 * 86400000).toISOString();
  try {
    const body = await req.json();
    if (body.since_ts) since_ts = body.since_ts;
  } catch { /* no body */ }

  // Fetch all user projects (service role bypasses RLS)
  const projects = await dbFetch(
    `projects?user_id=eq.${encodeURIComponent(userId)}&select=id,name,emoji,is_public,published_slug&order=updated_at.desc`
  );

  if (!Array.isArray(projects) || projects.length === 0) {
    return new Response(JSON.stringify({ projects: [], views: [] }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Fetch page_views for all user projects in range
  const ids = projects.map((p: { id: string }) => p.id).join(",");
  const views = await dbFetch(
    `page_views?project_id=in.(${ids})&ts=gte.${encodeURIComponent(since_ts)}&select=project_id,session_id,visitor_id,device,referrer,ts&order=ts.asc&limit=10000`
  );

  return new Response(
    JSON.stringify({ projects, views: Array.isArray(views) ? views : [] }),
    { headers: { ...CORS, "Content-Type": "application/json" } }
  );
});
