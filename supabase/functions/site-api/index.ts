// Vexium /site-api — backend for AI-built sites
// Handles: signup, login, submit (forms/data), get_data
// No Vexium auth required — project_id scopes all operations

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password + ":vexium");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function dbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return res.json();
}

async function dbPost(table: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── ACTIONS ──────────────────────────────────────────────────────────────────

async function handleSignup(project_id: string, email: string, password: string, metadata: Record<string, unknown> = {}) {
  if (!email || !password) return err("email and password required");
  if (password.length < 6) return err("password must be at least 6 characters");

  const password_hash = await hashPassword(password);

  // Check if user already exists
  const existing = await dbGet(`site_users?project_id=eq.${encodeURIComponent(project_id)}&email=eq.${encodeURIComponent(email)}&select=id`);
  if (Array.isArray(existing) && existing.length > 0) return err("account already exists");

  const rows = await dbPost("site_users", { project_id, email, password_hash, metadata });
  if (!Array.isArray(rows) || !rows[0]) return err("signup failed", 500);

  const user = rows[0];
  return ok({ success: true, token: user.id, user: { id: user.id, email: user.email } });
}

async function handleLogin(project_id: string, email: string, password: string) {
  if (!email || !password) return err("email and password required");

  const password_hash = await hashPassword(password);
  const rows = await dbGet(
    `site_users?project_id=eq.${encodeURIComponent(project_id)}&email=eq.${encodeURIComponent(email)}&password_hash=eq.${encodeURIComponent(password_hash)}&select=id,email,metadata`
  );

  if (!Array.isArray(rows) || !rows[0]) return err("invalid email or password");
  const user = rows[0];
  return ok({ success: true, token: user.id, user: { id: user.id, email: user.email } });
}

async function handleSubmit(project_id: string, collection: string, data: unknown, token?: string) {
  if (!collection) return err("collection required");

  let site_user_id: string | null = null;
  if (token) {
    const users = await dbGet(`site_users?project_id=eq.${encodeURIComponent(project_id)}&id=eq.${encodeURIComponent(token)}&select=id`);
    if (Array.isArray(users) && users[0]) site_user_id = users[0].id;
  }

  const rows = await dbPost("site_data", { project_id, collection, data, site_user_id });
  if (!Array.isArray(rows) || !rows[0]) return err("submit failed", 500);
  return ok({ success: true, id: rows[0].id });
}

async function handleGetData(project_id: string, collection: string, token?: string) {
  if (!collection) return err("collection required");

  // If token provided, verify it belongs to this project
  let filterByUser = "";
  if (token) {
    const users = await dbGet(`site_users?project_id=eq.${encodeURIComponent(project_id)}&id=eq.${encodeURIComponent(token)}&select=id`);
    if (Array.isArray(users) && users[0]) {
      filterByUser = `&site_user_id=eq.${encodeURIComponent(token)}`;
    }
  }

  const rows = await dbGet(
    `site_data?project_id=eq.${encodeURIComponent(project_id)}&collection=eq.${encodeURIComponent(collection)}${filterByUser}&order=created_at.desc&limit=100&select=id,data,created_at`
  );
  return ok({ success: true, rows: Array.isArray(rows) ? rows : [] });
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("invalid json");
  }

  const { project_id, action } = body;
  if (!project_id || typeof project_id !== "string") return err("missing project_id");
  if (!action || typeof action !== "string") return err("missing action");

  switch (action) {
    case "signup":
      return handleSignup(
        project_id,
        String(body.email || ""),
        String(body.password || ""),
        (body.metadata as Record<string, unknown>) || {}
      );
    case "login":
      return handleLogin(project_id, String(body.email || ""), String(body.password || ""));
    case "submit":
      return handleSubmit(project_id, String(body.collection || ""), body.data, body.token ? String(body.token) : undefined);
    case "get_data":
      return handleGetData(project_id, String(body.collection || ""), body.token ? String(body.token) : undefined);
    default:
      return err(`unknown action: ${action}`);
  }
});
