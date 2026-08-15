// Vertly Stripe Connect Status — checks whether a project's Stripe Connect account is fully onboarded
// Deploy: supabase functions deploy stripe-connect-status

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

    // Account-level: status of the USER's single Connect account (works for all their sites).
    const profile = await getProfile(userId);
    if (!profile) return json({ error: "Profile not found" }, 404);

    const accountId = profile.stripe_connect_account_id as string | null;
    if (!accountId) {
      return json({ connected: false, charges_enabled: false });
    }

    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = account.charges_enabled === true;

    // Sync to DB if newly enabled
    if (chargesEnabled && !profile.stripe_connect_charges_enabled) {
      await updateProfile(userId, { stripe_connect_charges_enabled: true });
    }

    return json({ connected: true, charges_enabled: chargesEnabled, account_id: accountId });
  } catch (e) {
    console.error("[stripe-connect-status]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
