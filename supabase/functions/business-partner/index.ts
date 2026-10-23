// Vertly /business-partner — the AI business partner on the BUSINESS screen (REVAMP Step 13, chunk C). Verifies the caller with GoTrue
// (--no-verify-jwt, like ai-chat: the project signs tokens with ES256), checks the project is theirs and live, and asks the model about the
// saved `business_state` only. The rules that keep it honest are in _shared/advice.ts; the request flow is in handler.ts.
//
// Deploy:  supabase functions deploy business-partner --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY (already set for ai-chat). Optional: PARTNER_MODEL, and ANTHROPIC_BASE_URL — a stand-in for api.anthropic.com
//          used ONLY to test without credit (docs/INFRA.md "Testing the business partner"); unset it afterwards.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handle, ModelError, type Deps } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_BASE_URL = (Deno.env.get("ANTHROPIC_BASE_URL") ?? "").replace(/\/+$/, "");
const MODEL = Deno.env.get("PARTNER_MODEL") ?? "claude-sonnet-4-6";
// $/MTok in cents (same table as ai-chat). Unknown model → the Sonnet price, so a typo never bills less than it costs.
const PRICE = MODEL.includes("haiku") ? { input: 80, output: 400 } : { input: 300, output: 1500 };

// Same plan limits as ai-chat's usage gate (CREDIT_LIMITS_CENTS) — keep them in step.
const CREDIT_LIMITS_CENTS: Record<string, number> = { trial: 300, starter: 1500, pro: 4000, max: 12000 };

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
    const [p] = await rows<any>(`projects?id=eq.${enc(id)}&select=id,user_id,name,published_version&limit=1`);
    return p ?? null;
  },
  async isMember(projectId, userId) {
    return (await rows(`project_members?project_id=eq.${enc(projectId)}&user_id=eq.${enc(userId)}&status=eq.accepted&select=user_id&limit=1`)).length > 0;
  },
  async latestArtifact(projectId, kind) {
    const [a] = await rows<any>(`project_artifacts?project_id=eq.${enc(projectId)}&kind=eq.${kind}&select=version,data,created_at&order=version.desc&limit=1`);
    return a ?? null;
  },
  async rateHit(key, windowSeconds, limit) {
    const r = await fetch(`${rest}/rpc/vx_rate_hit`, { method: "POST", headers: svc, body: JSON.stringify({ p_key: key, p_window_seconds: windowSeconds, p_limit: limit }) });
    // If the counter itself is down we let the ask through: the credit gate still bounds the cost.
    if (!r.ok) return { allowed: true, retryAfter: 0 };
    const row = (await r.json())?.[0];
    return { allowed: row?.allowed !== false, retryAfter: Number(row?.retry_after) || 0 };
  },
  // Fails open if the lookup itself fails (usage is still billed below) — the same rule as ai-chat.
  async usageGate(userId) {
    try {
      const [p] = await rows<any>(`account_billing?user_id=eq.${enc(userId)}&select=plan,credits_used_cents,trial_ends_at,extra_credits_cents`);
      if (!p) return null;
      const limit = (CREDIT_LIMITS_CENTS[p.plan as string] || 1500) + ((p.extra_credits_cents as number) || 0);
      const used = (p.credits_used_cents as number) || 0;
      if (p.plan === "trial" && p.trial_ends_at && new Date(p.trial_ends_at as string) < new Date()) return "Your free trial has ended. Upgrade to keep going.";
      if (used >= limit) return "You've used all your AI credits for this month. Upgrade your plan to continue.";
    } catch { /* non-blocking */ }
    return null;
  },
  async callModel(system, user, maxTokens) {
    if (!ANTHROPIC_API_KEY && !ANTHROPIC_BASE_URL) throw new ModelError("credit", "no ANTHROPIC_API_KEY");
    let res: Response;
    try {
      res = await fetch(`${ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.3, system, messages: [{ role: "user", content: user }] }),
      });
    } catch (e) {
      throw new ModelError("busy", `fetch failed: ${e}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      // A provider-side account problem (no credit, bad key) is not something to show an owner.
      if (res.status === 401 || res.status === 403 || /credit balance|billing/i.test(text)) throw new ModelError("credit", `${res.status} ${text}`);
      if (res.status === 429 || res.status === 529 || res.status >= 500) throw new ModelError("busy", `${res.status} ${text}`);
      throw new ModelError("other", `${res.status} ${text}`);
    }
    const out = await res.json();
    const text = Array.isArray(out?.content) ? out.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : "";
    return { text, inputTokens: Number(out?.usage?.input_tokens) || 0, outputTokens: Number(out?.usage?.output_tokens) || 0 };
  },
  async recordUsage(userId, inputTokens, outputTokens) {
    const exact = (inputTokens / 1_000_000) * PRICE.input + (outputTokens / 1_000_000) * PRICE.output;
    const cents = Math.round(exact);
    console.log(`[usage] business-partner in=${inputTokens} out=${outputTokens} model=${MODEL} cents=${cents}`);
    if (cents <= 0) return 0;
    const r = await fetch(`${rest}/rpc/increment_usage`, { method: "POST", headers: svc, body: JSON.stringify({ p_user_id: userId, p_cents: cents }) });
    if (!r.ok) console.error(`[usage] increment_usage ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return cents;
  },
};

serve(async (req) => {
  try {
    return await handle(req, deps);
  } catch (e) {
    console.error("[business-partner]", e);
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
