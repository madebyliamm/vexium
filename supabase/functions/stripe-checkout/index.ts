// Vexium Stripe Checkout — creates a Checkout Session for a subscription plan
// Deploy: supabase functions deploy stripe-checkout

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { userIdFromJwt, getProfile, updateProfile } from "../_shared/db.ts";
import { PRICE_IDS } from "../_shared/stripe-plans.ts";

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

    const { plan, period, return_url } = await req.json();
    const priceId = PRICE_IDS[plan]?.[period as "monthly" | "annual"];
    if (!priceId) return json({ error: "Invalid plan or billing period" }, 400);

    const profile = await getProfile(userId);
    if (!profile) return json({ error: "Profile not found" }, 404);

    let customerId = profile.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email || undefined,
        metadata: { user_id: userId },
      });
      customerId = customer.id;
      await updateProfile(userId, { stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "subscription",
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      return_url: return_url || "https://vexium.ai/settings.html?tab=billing&billing=success",
      subscription_data: { metadata: { user_id: userId, plan, period } },
      metadata: { user_id: userId, plan, period },
    });

    return json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("[stripe-checkout]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
