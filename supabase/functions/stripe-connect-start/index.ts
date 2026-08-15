// Vertly Stripe Connect Start — creates/resumes an Express Connect onboarding link for a project
// Deploy: supabase functions deploy stripe-connect-start

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { userIdFromJwt, getProfile, updateProfile } from "../_shared/db.ts";

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

    // Account-level Connect: one Stripe account per USER, reused across all their sites.
    // (project_id is still accepted from the client for the return URL, but no longer required.)
    const { return_url, refresh_url } = await req.json().catch(() => ({}));

    const profile = await getProfile(userId);
    if (!profile) return json({ error: "Profile not found" }, 404);

    // Create a new Express account if this user doesn't have one yet
    let accountId = profile.stripe_connect_account_id as string | null;
    if (!accountId) {
      const account = await stripe.accounts.create({ type: "express", metadata: { user_id: userId } });
      accountId = account.id;
      await updateProfile(userId, { stripe_connect_account_id: accountId });
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
