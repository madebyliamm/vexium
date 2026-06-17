// Vexium Stripe Webhook — syncs subscription state into profiles + billing_history
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt

import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { getProfile, getProfileByCustomerId, updateProfile, insertBillingHistory } from "../_shared/db.ts";
import { PRICE_TO_PLAN, PLAN_LABEL } from "../_shared/stripe-plans.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-11-20.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed", err);
    return new Response(`Webhook Error: ${err instanceof Error ? err.message : err}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || session.metadata?.user_id;
        const meta = session.metadata || {};

        if (userId && meta.type === "extra_usage") {
          const amountPaidCents = Number(meta.amount_paid_cents || 0);
          const aiCentsAdded = Math.round(amountPaidCents / 1.5);
          const profile = await getProfile(userId);
          const currentExtra     = Number(profile?.extra_credits_cents || 0);
          const currentPurchased = Number(profile?.extra_credits_purchased_cents || 0);
          await updateProfile(userId, {
            extra_credits_cents:           currentExtra     + aiCentsAdded,
            extra_credits_purchased_cents: currentPurchased + aiCentsAdded,
          });
          await insertBillingHistory(
            userId,
            "extra_usage",
            `Extra usage — $${(amountPaidCents / 100).toFixed(0)} top-up`,
            amountPaidCents,
          );
        } else if (userId && meta.plan && meta.period) {
          const plan   = meta.plan;
          const period = meta.period as "monthly" | "annual";
          await updateProfile(userId, {
            plan,
            selected_plan: plan,
            billing_period: period,
            plan_cycle_start: new Date().toISOString(),
            credits_used_cents: 0,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          });
          await insertBillingHistory(
            userId,
            "subscription",
            `Upgraded to ${PLAN_LABEL[plan] || plan} (${period})`,
            session.amount_total ?? 0,
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const profile = await getProfileByCustomerId(sub.customer as string);
        const priceId = sub.items.data[0]?.price?.id;
        const mapping = priceId ? PRICE_TO_PLAN[priceId] : null;
        if (profile && mapping && (profile.plan !== mapping.plan || profile.billing_period !== mapping.period)) {
          await updateProfile(profile.id, {
            plan: mapping.plan,
            selected_plan: mapping.plan,
            billing_period: mapping.period,
          });
          await insertBillingHistory(
            profile.id,
            "subscription",
            `Plan changed to ${PLAN_LABEL[mapping.plan] || mapping.plan} (${mapping.period})`,
            0,
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const profile = await getProfileByCustomerId(sub.customer as string);
        if (profile) {
          await updateProfile(profile.id, {
            plan: "trial",
            selected_plan: "trial",
            stripe_subscription_id: null,
          });
          await insertBillingHistory(profile.id, "subscription", "Subscription canceled", 0);
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason === "subscription_cycle") {
          const profile = await getProfileByCustomerId(invoice.customer as string);
          if (profile) {
            await updateProfile(profile.id, {
              plan_cycle_start: new Date().toISOString(),
              credits_used_cents: 0,
            });
            await insertBillingHistory(
              profile.id,
              "subscription",
              `${PLAN_LABEL[profile.plan] || profile.plan} plan renewal`,
              invoice.amount_paid ?? 0,
            );
          }
        }
        break;
      }
    }
  } catch (e) {
    console.error("[stripe-webhook] handler error", e);
    return new Response(JSON.stringify({ error: "handler error" }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
