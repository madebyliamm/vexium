// Vexium Stripe Connect Status — checks whether a project's Stripe Connect account is fully onboarded
// Deploy: supabase functions deploy stripe-connect-status

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { userIdFromJwt, getProjectById, updateProject } from "../_shared/db.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-11-20.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const userId = userIdFromJwt(req.headers.get("Authorization"));
    if (!userId) return json({ error: "Unauthorized" }, 401);

    let project_id: string | null = null;
    if (req.method === "GET") {
      project_id = new URL(req.url).searchParams.get("project_id");
    } else {
      const body = await req.json().catch(() => ({}));
      project_id = body.project_id ?? null;
    }
    if (!project_id) return json({ error: "project_id required" }, 400);

    const project = await getProjectById(project_id);
    if (!project) return json({ error: "Project not found" }, 404);
    if (project.user_id !== userId) return json({ error: "Forbidden" }, 403);

    const accountId = project.stripe_connect_account_id as string | null;
    if (!accountId) {
      return json({ connected: false, charges_enabled: false });
    }

    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = account.charges_enabled === true;

    // Sync to DB if newly enabled
    if (chargesEnabled && !project.stripe_connect_charges_enabled) {
      await updateProject(project_id, { stripe_connect_charges_enabled: true });
    }

    return json({ connected: true, charges_enabled: chargesEnabled, account_id: accountId });
  } catch (e) {
    console.error("[stripe-connect-status]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
