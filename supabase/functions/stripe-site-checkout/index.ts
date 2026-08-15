// Vertly Stripe Site Checkout — public endpoint for buyer-initiated payments on Vertly-built sites
// 1% platform fee applied via application_fee_amount on the connected account's checkout session
//
// Two modes:
//   • product_id  → price is looked up SERVER-SIDE from the project's _backend.products catalog.
//                   The client never sends the price, so it can't be tampered. (Use for fixed-price goods.)
//   • amount_cents → client-supplied amount, for pay-what-you-want / donations / custom amounts only.
//
// Deploy: supabase functions deploy stripe-site-checkout --no-verify-jwt

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { getProjectCommerce, getProfileConnect } from "../_shared/db.ts";

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

type Product = { id: string; name?: string; price_cents?: number; active?: boolean };

// Read the product catalog from the project's files. Prefer the PUBLISHED files (what live buyers
// see); fall back to the draft. Products live in _backend.products: [{ id, name, price_cents }].
function readProducts(project: Record<string, any>): Product[] {
  for (const blob of [project.published_files, project.files]) {
    try {
      const backendRaw = blob?.["_backend"];
      if (!backendRaw) continue;
      const backend = typeof backendRaw === "string" ? JSON.parse(backendRaw) : backendRaw;
      if (Array.isArray(backend?.products) && backend.products.length) return backend.products as Product[];
    } catch { /* malformed _backend — try the next source */ }
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    let project_id: string, amount_cents: number, name: string, success_url: string, cancel_url: string, product_id: string;

    if (req.method === "GET") {
      const p = new URL(req.url).searchParams;
      project_id   = p.get("project_id")  ?? "";
      product_id   = p.get("product_id")  ?? "";
      amount_cents = parseInt(p.get("amount_cents") ?? "0", 10);
      name         = p.get("name")         ?? "Purchase";
      success_url  = p.get("success_url")  ?? "";
      cancel_url   = p.get("cancel_url")   ?? "";
    } else {
      const b      = await req.json();
      project_id   = b.project_id   ?? "";
      product_id   = b.product_id   ?? "";
      amount_cents = parseInt(b.amount_cents ?? 0, 10);
      name         = b.name         ?? "Purchase";
      success_url  = b.success_url  ?? "";
      cancel_url   = b.cancel_url   ?? "";
    }

    if (!project_id)   return json({ error: "project_id required" }, 400);
    if (!success_url)  return json({ error: "success_url required" }, 400);
    if (!cancel_url)   return json({ error: "cancel_url required" }, 400);

    const project = await getProjectCommerce(project_id);
    if (!project) return json({ error: "Project not found" }, 404);

    // Resolve the seller's connected account: prefer the owner's ACCOUNT-LEVEL (profile) connection;
    // fall back to a legacy per-project account so sites connected the old way keep working.
    const ownerConnect = await getProfileConnect(project.user_id);
    let connectAccount = ownerConnect.account;
    let chargesEnabled = ownerConnect.enabled;
    if (!connectAccount && project.stripe_connect_account_id) {
      connectAccount = project.stripe_connect_account_id;
      chargesEnabled = project.stripe_connect_charges_enabled === true;
    }
    if (!connectAccount) return json({ error: "Stripe not connected for this site" }, 400);
    if (!chargesEnabled) return json({ error: "Stripe account setup incomplete" }, 400);

    // ── Resolve the price server-side ──────────────────────────────────────────
    if (product_id) {
      // Fixed-price product: the catalog is the source of truth. Client price is ignored entirely.
      const product = readProducts(project).find(p => p.id === product_id);
      if (!product)                       return json({ error: "Unknown product" }, 404);
      if (product.active === false)       return json({ error: "This product is not available" }, 400);
      if (typeof product.price_cents !== "number" || product.price_cents < 50) {
        return json({ error: "This product has no valid price set" }, 400);
      }
      amount_cents = Math.round(product.price_cents);
      name = product.name || name;
    } else {
      // Custom amount (donation / pay-what-you-want). Allowed, but validated.
      if (!Number.isFinite(amount_cents) || amount_cents < 50) return json({ error: "Minimum amount is $0.50" }, 400);
      if (amount_cents > 99999999) return json({ error: "Amount too large" }, 400);
    }

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
        // project_id on the PI too, so charge.refunded can attribute the refund to the right site
        // (an account-level Connect account is shared by all of the owner's sites).
        payment_intent_data: { application_fee_amount: platformFee, metadata: { project_id } },
        metadata: { project_id, product_name: name, product_id: product_id || "" },
      },
      { stripeAccount: connectAccount },
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
