// Vexium Stripe Billing Portal — lets users manage/cancel their subscription
// Deploy: supabase functions deploy stripe-portal

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { userIdFromJwt, getProfile } from "../_shared/db.ts";

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

    const profile = await getProfile(userId);
    if (!profile?.stripe_customer_id) return json({ error: "No billing account found" }, 400);

    const { return_url } = await req.json().catch(() => ({}));

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: return_url || "https://vexium.ai/settings.html",
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("[stripe-portal]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
