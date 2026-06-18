// Vexium Stripe Connect Start — creates/resumes an Express Connect onboarding link for a project
// Deploy: supabase functions deploy stripe-connect-start

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

    const { project_id, return_url, refresh_url } = await req.json();
    if (!project_id) return json({ error: "project_id required" }, 400);

    const project = await getProjectById(project_id);
    if (!project) return json({ error: "Project not found" }, 404);
    if (project.user_id !== userId) return json({ error: "Forbidden" }, 403);

    // Create a new Express account if not already set up
    let accountId = project.stripe_connect_account_id as string | null;
    if (!accountId) {
      const account = await stripe.accounts.create({ type: "express" });
      accountId = account.id;
      await updateProject(project_id, { stripe_connect_account_id: accountId });
    }

    // Generate a fresh onboarding link (account links expire after ~5 min)
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: return_url || "https://vexium.ai/editor.html",
      refresh_url: refresh_url || "https://vexium.ai/editor.html",
    });

    return json({ url: link.url, account_id: accountId });
  } catch (e) {
    console.error("[stripe-connect-start]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
