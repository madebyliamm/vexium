// Vertly /auth-gate — username login + signup availability, server side (SECURITY_FINDINGS #10).
// Called by auth.html with only the public anon key; resolves usernames with the service key so emails never reach
// the browser. See handler.ts for the rules.
//
// Deploy:  supabase functions deploy auth-gate --no-verify-jwt
//   (public by design: the caller is not signed in yet. Rate limiting is in handler.ts via public.vx_rate_hit.)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handle, type GateDeps } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

const deps: GateDeps = {
  async rateHit(key, windowSeconds, limit, cost) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vx_rate_hit`, {
      method: "POST", headers: svc,
      body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds, p_limit: limit, p_cost: cost }),
    });
    if (!res.ok) throw new Error(`vx_rate_hit ${res.status}`); // fail closed
    const [r] = await res.json();
    return { allowed: r.allowed === true, retry_after: Number(r.retry_after) || 60 };
  },

  async userIdByUsername(username) {
    // ilike treats _ and % as wildcards; escape them, then still compare exactly in code.
    const pattern = username.replace(/[\\%_]/g, (c) => "\\" + c);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?username=ilike.${encodeURIComponent(pattern)}&select=id,username&limit=5`, { headers: svc });
    if (!res.ok) return null;
    const rows = await res.json();
    const hit = Array.isArray(rows) ? rows.find((r: { username?: string }) => (r.username || "").toLowerCase() === username.toLowerCase()) : null;
    return hit?.id ?? null;
  },

  async emailOfUser(userId) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: svc });
    if (!res.ok) return null;
    const u = await res.json().catch(() => null);
    return typeof u?.email === "string" ? u.email : null;
  },

  async signIn(email, password, ip) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ email, password }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out?.access_token) return { ok: true, session: out };
    return { ok: false, code: typeof out?.error_code === "string" ? out.error_code : undefined };
  },

  async availability(username, email) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_signup_availability`, {
      method: "POST", headers: svc, body: JSON.stringify({ p_username: username, p_email: email }),
    });
    if (!res.ok) throw new Error(`check_signup_availability ${res.status}`);
    return await res.json();
  },
};

serve((req) => handle(req, deps));
