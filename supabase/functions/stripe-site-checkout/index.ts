// Vexium Stripe Site Checkout — public endpoint for buyer-initiated payments on Vexium-built sites
// 1% platform fee applied via application_fee_amount on the connected account's checkout session
// Deploy: supabase functions deploy stripe-site-checkout --no-verify-jwt

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { getProjectById } from "../_shared/db.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-11-20.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    let project_id: string, amount_cents: number, name: string, success_url: string, cancel_url: string;

    if (req.method === "GET") {
      const p = new URL(req.url).searchParams;
      project_id   = p.get("project_id")  ?? "";
      amount_cents = parseInt(p.get("amount_cents") ?? "0", 10);
      name         = p.get("name")         ?? "Purchase";
      success_url  = p.get("success_url")  ?? "";
      cancel_url   = p.get("cancel_url")   ?? "";
    } else {
      const b      = await req.json();
      project_id   = b.project_id   ?? "";
      amount_cents = parseInt(b.amount_cents ?? 0, 10);
      name         = b.name         ?? "Purchase";
      success_url  = b.success_url  ?? "";
      cancel_url   = b.cancel_url   ?? "";
    }

    if (!project_id)   return json({ error: "project_id required" }, 400);
    if (amount_cents < 50) return json({ error: "Minimum amount is $0.50" }, 400);
    if (!success_url)  return json({ error: "success_url required" }, 400);
    if (!cancel_url)   return json({ error: "cancel_url required" }, 400);

    const project = await getProjectById(project_id);
    if (!project)                             return json({ error: "Project not found" }, 404);
    if (!project.stripe_connect_account_id)   return json({ error: "Stripe not connected for this site" }, 400);
    if (!project.stripe_connect_charges_enabled) return json({ error: "Stripe account setup incomplete" }, 400);

    const platformFee = Math.max(1, Math.round(amount_cents * 0.01)); // 1%, min 1 cent

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amount_cents,
            product_data: { name },
          },
        }],
        success_url,
        cancel_url,
        payment_intent_data: { application_fee_amount: platformFee },
        metadata: { project_id, product_name: name },
      },
      { stripeAccount: project.stripe_connect_account_id as string },
    );

    // GET: redirect browser directly to Stripe hosted checkout
    if (req.method === "GET") {
      return new Response(null, {
        status: 302,
        headers: { ...cors, Location: session.url! },
      });
    }

    return json({ url: session.url });
  } catch (e) {
    console.error("[stripe-site-checkout]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
