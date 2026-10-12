// Vexium /track — page view analytics collector
// Called from every site built by Vexium. No auth required.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function detectDevice(ua: string): string {
  if (!ua) return "unknown";
  const u = ua.toLowerCase();
  if (/mobile|android|iphone|ipad|ipod/.test(u)) return "mobile";
  if (/tablet/.test(u)) return "tablet";
  return "desktop";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: CORS });
  }

  const { project_id, page = "/", referrer = "", session_id = "", visitor_id = "" } = body;
  if (!project_id) return new Response("missing project_id", { status: 400, headers: CORS });

  const ua = req.headers.get("user-agent") || "";
  const device = detectDevice(ua);

  // Fire and forget — don't block the response
  (async () => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/page_views`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ project_id, page, referrer, device, session_id, visitor_id }),
      });
    } catch { /* never fail a page load */ }
  })();

  return new Response("ok", { headers: CORS });
});
