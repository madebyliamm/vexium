// Vexium Stripe Extra Usage — one-time payment Checkout Session for AI credit top-ups
// Deploy: supabase functions deploy stripe-extra-usage

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

    const { amount_cents, return_url } = await req.json();
    if (!amount_cents || amount_cents < 500) return json({ error: "Minimum purchase is $5" }, 400);

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
      mode: "payment",
      customer: customerId,
      client_reference_id: userId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amount_cents,
          product_data: { name: "Extra AI usage" },
        },
      }],
      return_url: return_url || "https://vexium.ai/settings.html?tab=billing&billing=extra_success",
      metadata: {
        user_id: userId,
        type: "extra_usage",
        amount_paid_cents: String(amount_cents),
      },
    });

    return json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("[stripe-extra-usage]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
