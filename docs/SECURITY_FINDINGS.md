# Security findings (Step 1 recon 2026-10-12 → Step 2 lockdown 2026-10-12)

Step 1 found these by READING source and catalog definitions. Step 2 fixed the critical ones and verified them with `supabase/tests/step2_security_lockdown.sql` (85 checks; always rolls back; re-run any time with `supabase db query --linked -f supabase/tests/step2_security_lockdown.sql` — the "error" it ends with is the report) plus black-box HTTP checks with only the public anon key. Context: the app is pre-launch with ~5 accounts, Stripe in test mode — but the Supabase URL and anon key ship in every page, so everything here was reachable by anyone.

## Status board
| # | finding | status |
|---|---|---|
| 1 | `vexium_site_query` — anonymous SQL | **FIXED** (service-role only; owner's SELECT now runs in a no-privilege sandbox on temp copies of that project's rows) |
| 2 | `increment_usage` / `log_usage` — anyone edits anyone's credits | **FIXED** (revoked; `log_usage` dropped) |
| 3 | `profiles` — self-promotion + everything world-readable | **FIXED** (billing moved to private `account_billing`; column-level grants on `profiles`; email private) |
| 4 | `site-api get_data` returns any collection to anyone | **OPEN → Step 4** (only `transactions` is blocked so far) |
| 5 | `site-api submit` writes anywhere, unauthenticated, unlimited | **PARTIAL** — `transactions` blocked (can't forge sales). Still open: other collections, size limits, rate limits → Step 4 |
| 6 | Site-user "tokens" are the row UUID | **OPEN → Step 4** |
| 7 | Site-user passwords SHA-256 + constant salt | **PARTIAL** — hashes no longer readable by clients (column privileges) and the SQL sandbox can't see them. KDF fix → Step 4 |
| 8 | No rate limiting | **OPEN → Step 4** |
| 9 | `site-sql` trusted an unverified JWT | **FIXED** (verifies the caller with GoTrue; project ownership still checked) |
| 10 | `get_email_by_username` anon-callable | **OPEN — upgraded to HIGH** (see below) |
| 11 | `billing_history` client INSERT | **FIXED** (webhook/service role only) |
| 12 | Anon key + project ids committed | by design; safe now that 1–3 are fixed |
| 13 | `ai-chat` accepted unauthenticated / forged callers → unmetered Anthropic spend | **FIXED** (new) |
| 14 | `trial-emails` had no auth | **FIXED** (new; service key required) |
| 15 | Account deletion never worked (`delete_user` RPC doesn't exist) | **FIXED** (new; page now calls `delete_own_account`) |

## New in Step 2
**13. `ai-chat` (verify_jwt off) derived the user from an UNDECODED-SIGNATURE JWT and skipped everything when there was none.** No `Authorization` header (or the public anon key) ⇒ `userId = null` ⇒ no usage gate, no billing ⇒ anyone with the function URL could run unmetered Anthropic calls on Liam's key; a forged `sub` could burn another user's credits. Fix: `verifiedUserId()` asks GoTrue (`/auth/v1/user`); no valid user ⇒ 401. Confirmed live: no auth / anon key / forged unsigned JWT all → 401.
**14. `trial-emails`** had `verify_jwt` off and no check — anyone could trigger sends. Now requires the service-role key. (Nothing in the repo or DB schedules it; wire a scheduler with that key before relying on it.)
**15. Settings → Delete account** called a non-existent RPC, swallowed the error and just signed the user out. Now calls `delete_own_account` (cascades profile + billing). Not exercised on a real account.
**Why not gateway `verify_jwt`?** The project signs user tokens with ES256, which the edge gateway has rejected before, so `site-sql`/`ai-chat` verify in-function. See `docs/INFRA.md`.

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
