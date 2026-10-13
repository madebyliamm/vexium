// Vertly /site-api — the backend for generated sites (forms, data collections, site-user accounts).
//
// Rules come from the project's `_backend` (live deploy when published, else the draft); see docs/STEP4_DESIGN.md.
// No Vertly login is required — the public site calls it — so every limit lives in handler.ts / rules.ts and the
// service key never leaves this function.
//
// Deploy:  supabase functions deploy site-api --no-verify-jwt
//
//   handler.ts   request handling + all access rules   (pure; unit-tested in supabase/tests/site_api.test.ts)
//   rules.ts     `_backend` parsing + row validation
//   passwords.ts PBKDF2 + session tokens
//   store.ts     PostgREST access (service role)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handle, type Deps } from "./handler.ts";
import { createStore } from "./store.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const MAIL_FROM = "Vertly <hello@vexium.ai>";

const deps: Deps = {
  store: createStore({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY }),
  now: () => Date.now(),
  waitUntil: (p) => {
    // Supabase Edge Runtime keeps the worker alive for background work; fall back to fire-and-forget elsewhere.
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(p); else p.catch(() => {});
  },
  async sendMail({ to, subject, text, replyTo }) {
    if (!RESEND_KEY) return;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) console.error("[site-api] resend failed", res.status, (await res.text().catch(() => "")).slice(0, 200));
  },
};

serve((req) => handle(req, deps));
