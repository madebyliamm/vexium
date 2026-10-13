const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Extract userId from Bearer JWT without full verification (Supabase already verified it)
export function userIdFromJwt(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = authHeader.slice(7).split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.sub || null;
  } catch { return null; }
}

// Billing / usage / Stripe state lives in public.account_billing (service-role writes only; a signed-in user can
// merely SELECT their own row). The helpers below keep returning one "profile" object — the public.profiles row
// merged with the account_billing row — so callers can keep reading profile.stripe_customer_id, profile.email,
// profile.plan, profile.id, etc. updateProfile() routes each field to the table that owns it.
const BILLING_COLUMNS = new Set([
  "plan", "selected_plan", "trial_ends_at", "credits_used_cents", "extra_credits_cents",
  "extra_credits_purchased_cents", "plan_cycle_start", "billing_period", "tokens_used_this_month", "usage_month",
  "stripe_customer_id", "stripe_subscription_id", "stripe_connect_account_id", "stripe_connect_charges_enabled",
]);

async function fetchRow(path: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/${path}`, { headers: HEADERS });
  const rows = await res.json();
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

export async function getProfile(userId: string): Promise<Record<string, any> | null> {
  const [profile, billing] = await Promise.all([
    fetchRow(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,display_name,email&limit=1`),
    fetchRow(`account_billing?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`),
  ]);
  if (!profile) return null;
  return { ...(billing || {}), ...profile };
}

// Account-level Stripe Connect lives with the billing state (connect once, use for all the user's sites).
export async function getProfileConnect(userId: string): Promise<{ account: string | null; enabled: boolean }> {
  const r = await fetchRow(`account_billing?user_id=eq.${encodeURIComponent(userId)}&select=stripe_connect_account_id,stripe_connect_charges_enabled&limit=1`) || {};
  return { account: r.stripe_connect_account_id || null, enabled: r.stripe_connect_charges_enabled === true };
}

export async function getProfileByCustomerId(customerId: string): Promise<Record<string, any> | null> {
  const billing = await fetchRow(`account_billing?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id&limit=1`);
  return billing ? getProfile(billing.user_id) : null;
}

export async function updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
  const billing: Record<string, unknown> = {};
  const profile: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) (BILLING_COLUMNS.has(k) ? billing : profile)[k] = v;

  if (Object.keys(billing).length) {
    // Upsert, not PATCH: a PATCH on a missing row would silently drop e.g. a paid upgrade.
    const res = await fetch(`${REST}/account_billing?on_conflict=user_id`, {
      method: "POST",
      headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, ...billing }),
    });
    if (!res.ok) {
      console.error("[db] updateProfile(account_billing) failed", res.status, await res.text().catch(() => ""));
    }
  }
  if (Object.keys(profile).length) {
    const res = await fetch(`${REST}/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { ...HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) {
      console.error("[db] updateProfile(profiles) failed", res.status, await res.text().catch(() => ""));
    }
  }
}

export async function insertBillingHistory(userId: string, type: string, description: string, amountPaidCents: number): Promise<void> {
  const res = await fetch(`${REST}/billing_history`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "return=minimal" },
    body: JSON.stringify({ user_id: userId, type, description, amount_paid_cents: amountPaidCents }),
  });
  if (!res.ok) {
    console.error("[db] insertBillingHistory failed", res.status, await res.text().catch(() => ""));
  }
}

export async function getProjectById(projectId: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/projects?id=eq.${encodeURIComponent(projectId)}&select=id,user_id,stripe_connect_account_id,stripe_connect_charges_enabled&limit=1`, { headers: HEADERS });
  const rows = await res.json();
  return rows[0] || null;
}

export async function updateProject(projectId: string, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/projects?id=eq.${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { ...HEADERS, "Prefer": "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    console.error("[db] updateProject failed", res.status, await res.text().catch(() => ""));
  }
}

export async function getProjectByConnectAccount(accountId: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/projects?stripe_connect_account_id=eq.${encodeURIComponent(accountId)}&select=id,user_id&limit=1`, { headers: HEADERS });
  const rows = await res.json();
  return rows[0] || null;
}

// Full commerce view of a project — includes the files blob so the checkout endpoint can read the
// owner's product catalog (and its SERVER-SIDE prices) instead of trusting client-supplied amounts.
// Hosting v2 sites (published_version set) keep their published `_backend` on the live project_deploys row, not
// in published_files: expose it as `published_files._backend` and drop the draft `files`, so only what is actually
// live can be bought. Legacy sites (no version) keep the old published_files -> files lookup.
export async function getProjectCommerce(projectId: string): Promise<Record<string, any> | null> {
  const id = encodeURIComponent(projectId);
  const res = await fetch(`${REST}/projects?id=eq.${id}&select=id,user_id,stripe_connect_account_id,stripe_connect_charges_enabled,files,published_files,published_version&limit=1`, { headers: HEADERS });
  const rows = await res.json();
  const project = rows[0] || null;
  if (project && project.published_version != null) {
    const d = await fetch(`${REST}/project_deploys?project_id=eq.${id}&version=eq.${project.published_version}&select=backend&limit=1`, { headers: HEADERS });
    const deploys = await d.json();
    const backend = Array.isArray(deploys) && deploys[0] ? deploys[0].backend : null;
    project.published_files = backend ? { _backend: backend } : {};
    project.files = null;
  }
  return project;
}

export async function insertSiteData(projectId: string, collection: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/site_data`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "return=minimal" },
    body: JSON.stringify({ project_id: projectId, collection, data }),
  });
  if (!res.ok) {
    console.error("[db] insertSiteData failed", res.status, await res.text().catch(() => ""));
  }
}
