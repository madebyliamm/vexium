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

export async function getProfile(userId: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/profiles?id=eq.${userId}&select=*`, { headers: HEADERS });
  const rows = await res.json();
  return rows[0] || null;
}

export async function getProfileByCustomerId(customerId: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${REST}/profiles?stripe_customer_id=eq.${customerId}&select=*`, { headers: HEADERS });
  const rows = await res.json();
  return rows[0] || null;
}

export async function updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${REST}/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { ...HEADERS, "Prefer": "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    console.error("[db] updateProfile failed", res.status, await res.text().catch(() => ""));
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
