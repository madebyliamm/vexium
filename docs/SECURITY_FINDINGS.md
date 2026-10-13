# Security findings (Step 1 recon 2026-10-12 → Step 2 lockdown → Step 4 site backend)

Step 1 found these by READING source and catalog definitions. Step 2 fixed the critical ones and verified them with `supabase/tests/step2_security_lockdown.sql` (85 checks; always rolls back; re-run any time with `supabase db query --linked -f supabase/tests/step2_security_lockdown.sql` — the "error" it ends with is the report) plus black-box HTTP checks with only the public anon key. Context: the app is pre-launch with ~5 accounts, Stripe in test mode — but the Supabase URL and anon key ship in every page, so everything here was reachable by anyone.

## Status board
| # | finding | status |
|---|---|---|
| 1 | `vexium_site_query` — anonymous SQL | **FIXED** (service-role only; owner's SELECT now runs in a no-privilege sandbox on temp copies of that project's rows) |
| 2 | `increment_usage` / `log_usage` — anyone edits anyone's credits | **FIXED** (revoked; `log_usage` dropped) |
| 3 | `profiles` — self-promotion + everything world-readable | **FIXED** (billing moved to private `account_billing`; column-level grants on `profiles`; email private) |
| 4 | `site-api get_data` returns any collection to anyone | **FIXED in code (Step 4) — pending deploy.** Per-collection `read` rules from `_backend`; default = owner-only (or own rows with accounts on) |
| 5 | `site-api submit` writes anywhere, unauthenticated, unlimited | **FIXED in code (Step 4) — pending deploy.** Unknown collections 404, `transactions`/`_*` reserved, field allowlist, 16 KB rows, 64 KB bodies, `max_rows`, rate limits |
| 6 | Site-user "tokens" are the row UUID | **FIXED in code (Step 4) — pending deploy.** Opaque 256-bit session tokens, only the sha256 stored, project-bound, 30-day expiry, revocable |
| 7 | Site-user passwords SHA-256 + constant salt | **FIXED in code (Step 4) — pending deploy.** PBKDF2-SHA256 600 000 iterations, per-user salt, constant-time compare, dummy verify for unknown emails (0 site users existed, so nothing to migrate) |
| 8 | No rate limiting | **FIXED in code (Step 4) — pending deploy.** `vx_rate_hit` counters: login failures, signup, submit, reads, owner mail; auth-gate logins/availability; fails closed |
| 9 | `site-sql` trusted an unverified JWT | **FIXED** (verifies the caller with GoTrue; project ownership still checked) |
| 10 | `get_email_by_username` anon-callable | **FIXED in code (Step 4) — pending deploy + revoke.** `auth-gate` does username login server-side; migration `20261012141000` revokes both enumeration RPCs from anon/authenticated AFTER auth-gate + the new auth.html are live |
| 11 | `billing_history` client INSERT | **FIXED** (webhook/service role only) |
| 12 | Anon key + project ids committed | by design; safe now that 1–3 are fixed |
| 13 | `ai-chat` accepted unauthenticated / forged callers → unmetered Anthropic spend | **FIXED** (new) |
| 14 | `trial-emails` had no auth | **FIXED** (new; service key required) |
| 15 | Account deletion never worked (`delete_user` RPC doesn't exist) | **FIXED** (new; page now calls `delete_own_account`) |
| 16 | **`projects` UPDATE/DELETE open to everyone** (`USING (true)` for role public + anon table grants) — anyone with the anon key could overwrite/delete any PUBLISHED project (defacement, `custom_domain` hijack) | **FIXED 2026-10-13** — `supabase/migrations/20261012130000_projects_rls.sql` applied to prod; 18/18 by `supabase/tests/step3_projects_rls.sql`; black-box: anon PATCH/DELETE on `projects` → 401, anon SELECT + Worker RPC still 200 |
| 17 | `notifications` INSERT is `WITH CHECK (true)` — anyone can push a notification to any user (spam/phishing links) | **OPEN, MEDIUM** — needs the notification senders moved into triggers/RPCs first (Step 14 at the latest) |

## New in Step 2
**13. `ai-chat` (verify_jwt off) derived the user from an UNDECODED-SIGNATURE JWT and skipped everything when there was none.** No `Authorization` header (or the public anon key) ⇒ `userId = null` ⇒ no usage gate, no billing ⇒ anyone with the function URL could run unmetered Anthropic calls on Liam's key; a forged `sub` could burn another user's credits. Fix: `verifiedUserId()` asks GoTrue (`/auth/v1/user`); no valid user ⇒ 401. Confirmed live: no auth / anon key / forged unsigned JWT all → 401.
**14. `trial-emails`** had `verify_jwt` off and no check — anyone could trigger sends. Now requires the service-role key. (Nothing in the repo or DB schedules it; wire a scheduler with that key before relying on it.)
**15. Settings → Delete account** called a non-existent RPC, swallowed the error and just signed the user out. Now calls `delete_own_account` (cascades profile + billing). Not exercised on a real account.
**Why not gateway `verify_jwt`?** The project signs user tokens with ES256, which the edge gateway has rejected before, so `site-sql`/`ai-chat` verify in-function. See `docs/INFRA.md`.

## Found in Step 3
**16. `projects` write policies (HIGH, found while designing hosting).** `anyone can update projects` / `anyone can delete projects` were `USING (true)` for role `public`, and `anon` held UPDATE/DELETE/TRUNCATE on the table. UPDATE/DELETE still need the row to be visible through the SELECT policies, so the exposed rows were every PUBLISHED / public project (exactly the live sites): `files`, `published_files`, `custom_domain`, even `user_id`. Confirmed read-only on prod via `pg_policies` and a rolled-back test that ran `UPDATE`/`DELETE` as `anon` ("ok rows=1"). Fix: owner-or-accepted-collaborator UPDATE, owner-only DELETE, a trigger that stops API roles changing `user_id`, anon write privileges revoked. No page/function redeploy needed. **Applied to prod 2026-10-13.**
**17. `notifications` INSERT `WITH CHECK (true)`** (and `feedback`, which is fine). Medium: spam/phishing in the in-app bell.

## Step 4 notes
- Found while checking prod: the live Webre site's `admin.html` reads its `bookings` collection with an unauthenticated `get_data` (so every customer's name/email/phone was world-readable — finding #4 in the wild). Under the new defaults that call returns 403; Webre's admin page needs a sign-in (or the owner reads bookings in the Vertly dashboard).
- Known limits: a site-user lockout is possible (5 failed logins on an email lock that email for 15 min); sessions live in `localStorage` (XSS on the owner's own page could read them); no password reset / email verification for site users yet (needs the email capability — Step 12/14); `auth-gate` forwards the client IP to GoTrue in `X-Forwarded-For`, but GoTrue's own per-IP limits may still see the function's egress IP when many users log in by username at once.

## OPEN — highest priority next
**10 (HIGH). `get_email_by_username(text)` is callable by anon and returns the account's REAL email** (auth.html signs up with the real address; the old "pseudo-address" assumption was wrong). Anyone who knows or guesses a username can harvest its email. Used only for username login (auth.html). Fix: do username login server-side (an edge function that resolves + signs in and returns the session, rate-limited) then revoke the RPC from anon/authenticated. Do before launch; natural home is the studio auth work (Step 6) or Step 4.
**`check_signup_availability(username, email)`** (anon) lets anyone test whether an email/username is registered — standard signup enumeration; revisit with rate limiting.
**4–6, 8 (site-api)** — Step 4.

## Remaining advisor items (reviewed, intentional)
After Step 2: `supabase db advisors --linked` → 0 `function_search_path_mutable`; anon-executable SECURITY DEFINER: `check_signup_availability`, `get_email_by_username` (see above), `get_follow_counts`, `get_user_id_by_username` (public lookups), `is_following`, `is_project_member`, `is_project_owner` (RLS policy helpers — must stay executable by the calling role; they only answer yes/no for ids the caller already has). Still warned, low priority: `auth_leaked_password_protection` (enable in Supabase dashboard → Auth → Passwords, a free toggle), `auth_rls_initplan` / `multiple_permissive_policies` (performance, not security — clean up in Step 14).

## Low / notes
- Every `public` table grants full table privileges (incl. TRUNCATE) to `anon`/`authenticated`; RLS is the only gate. PostgREST can't TRUNCATE, so not exploitable via the API, but tighten per table when touched (done so far: profiles, account_billing, billing_history, site_users).
- `custom-domain` correctly verifies the user and ownership; `analytics` verifies via gateway; `stripe-webhook` verifies signatures; `stripe-*` user functions rely on gateway `verify_jwt` + `userIdFromJwt` (revisit if the gateway ES256 problem resurfaces — they'd then see an anon token and refuse, which fails closed).
- Projects' `stripe_connect_account_id` columns are readable wherever a project row is (Connect account ids are not secrets).
- Step 2 changed the shape of the API: clients cannot `select('*')` from `profiles`, and `profiles` has no plan/credit/Stripe columns any more.
