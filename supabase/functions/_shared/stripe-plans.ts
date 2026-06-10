// Stripe Price IDs for Vexium subscription plans (test mode).
// Must match the prices configured in the Stripe Dashboard.
export const PRICE_IDS: Record<string, Record<"monthly" | "annual", string>> = {
  starter: { monthly: "price_1TgccXDRd56Cnoi3iQQJbrgj", annual: "price_1TgccXDRd56Cnoi3nMzVMBDw" },
  pro:     { monthly: "price_1TgccYDRd56Cnoi3Y86jYwk6", annual: "price_1TgccZDRd56Cnoi33QWn7HBp" },
  max:     { monthly: "price_1TgccZDRd56Cnoi30j4XGDmy", annual: "price_1TgccaDRd56Cnoi31s6sK37a" },
};

export const PRICE_TO_PLAN: Record<string, { plan: string; period: "monthly" | "annual" }> = {};
for (const [plan, periods] of Object.entries(PRICE_IDS)) {
  for (const [period, priceId] of Object.entries(periods)) {
    PRICE_TO_PLAN[priceId] = { plan, period: period as "monthly" | "annual" };
  }
}

export const PLAN_LABEL: Record<string, string> = { starter: "Starter", pro: "Pro", max: "Max" };
