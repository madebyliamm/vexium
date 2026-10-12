# Security findings from Step 1 recon (2026-10-12)

Found by READING source and catalog definitions only. **Nothing was exploited or tested against production.** Severity is my judgment from the code; items marked *appears* should be confirmed on a throwaway project before/while fixing. Context: the app is pre-launch with ~5 accounts, Stripe in test mode — but the Supabase URL and anon key are public (they ship in every page), so all of this is reachable by anyone.

## CRITICAL — fix before anything else (Step 2)

**1. `vexium_site_query()` — anonymous SQL access (appears: read AND write of any table).**
`SECURITY DEFINER`, executable by `anon`, no caller/ownership check, and it concatenates the caller's text into `WITH … _user_query AS (<p_query>)`. The ownership check, SELECT-only check and keyword blocklist all live in the `site-sql` edge function, which an attacker bypasses by calling `POST /rest/v1/rpc/vexium_site_query` directly with the public anon key. The "scoping" only shadows the *unqualified* names `site_data`/`site_users`; `public.profiles`, `public.site_users` (incl. `password_hash`), `auth.users`, other projects' data are reachable with qualified names, and closing the parenthesis allows data-modifying CTEs.
Fix: `REVOKE EXECUTE ON FUNCTION public.vexium_site_query(text,text) FROM PUBLIC, anon, authenticated;` (the edge function uses the service role and keeps working). Then redesign (Step 4): read-only role + per-project views, no string concatenation.

**2. `increment_usage(uuid,int)` and `log_usage(...)` — anyone can edit anyone's credits.**
Both `SECURITY DEFINER`, executable by `anon`/`authenticated`, no `auth.uid()` check. Anyone can call `rpc/increment_usage` with any user id and any cents value (negative = free credits for yourself; large = lock another user out). `log_usage` is also dead/broken (references missing columns).
Fix: `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` on both; edge functions call them with the service role. Drop `log_usage`.

**3. `profiles` — users can promote themselves, and everyone can read everything.**
`profiles_update_own` allows a signed-in user to UPDATE their whole row from the browser: `plan`, `credits_used_cents`, `extra_credits_cents`, `trial_ends_at`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_connect_account_id`. That defeats the entire pricing model. Separately `profiles_select` (to `public`) and `profiles_anon_read` expose every column — including `email` and the Stripe ids — to anyone, regardless of `show_email`.
Fix: column-level grants (REVOKE UPDATE on all columns from `authenticated`, GRANT UPDATE only on display_name, bio, avatar_url, banner, show_*, advanced_mode…) or move billing state to a private `account_billing` table the client can't write; expose a public view with only public columns.

## HIGH — fix in Step 4 (site-api v2), required before real customers

**4. `site-api` `get_data` returns any collection to anyone.** With no token it returns the last 100 rows of ANY collection for the project; with an *invalid* token it silently falls back to the same. Project ids are public (they're substituted into every published page). So every contact-form submission, waitlist email, order and `transactions` row is world-readable.
**5. `site-api` `submit` writes to any collection, unauthenticated, unlimited size** — including `transactions`, which Analytics sums as revenue ⇒ anyone can forge sales on someone's dashboard. No rate limiting, no validation against the `_backend` declaration.
**6. Site-user sessions are not sessions.** `token` = the user's row UUID: non-secret, never expires, not signed.
**7. Site-user passwords:** SHA-256 of `password + ":vexium"` — fast hash, constant salt. Needs a real KDF (PBKDF2/argon2) with per-user salt, or delegate to Supabase Auth.
**8. No rate limiting** on login/signup/submit.

## MEDIUM

**9. `site-sql` edge function has `verify_jwt=off` and decodes the JWT without verifying its signature** — a forged token with any `sub` passes. (Moot until #1 is fixed; then fix by enabling `verify_jwt` or using `auth.getUser`.) `analytics` is fine (`verify_jwt` on).
**10. `get_email_by_username(text)` is anon-callable** → username→email lookup (used for username login). Acceptable only if emails are pseudo-addresses; revisit in the studio auth work.
**11. `billing_history` lets users INSERT their own rows** (forgeable receipts). Should be service-role only.
**12. The anon key and project ids are committed in several files (by design — they also ship in every page).** That is only safe once the RLS/grant issues above are fixed; until then the anon key is effectively an admin key for those paths.

## Notes
- `custom-domain` correctly verifies the user (`auth.getUser`) and ownership; `analytics`, `stripe-*` (jwt on) are fine. `stripe-webhook` verifies signatures.
- After Step 2, re-run `supabase db advisors --linked` and refresh `supabase/schema.sql`.
