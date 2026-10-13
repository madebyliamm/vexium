# Step 4 design — site-api v2 + Vertly SDK  (APPROVED 2026-10-12 with all defaults, incl. §8 deferral; implemented)

Facts checked on prod 2026-10-12: `site_users` = 0 rows, `site_data` = 1 row, 3 published projects, 2 drafts declare a `_backend`. No data migration needed; breaking changes are fine.

## 1. Where the rules come from
`site-api` enforces the project's `_backend`: the **live deploy's** `project_deploys.backend` when `published_version` is set, else the draft (`projects.files->>_backend`; legacy sites: `published_files`). Cached 15 s per isolate. Known limit: previewing a *new* collection on an already-published site needs "Update" first (the preview can't be told apart from the live site).

## 2. Per-collection rules (new `_backend` shape, all optional)
```json
{ "collections": [{ "id": "waitlist", "fields": [{"key":"email","type":"email"}],
    "read": "owner", "write": "public", "max_rows": 10000, "notify_owner": true }],
  "auth": { "enabled": true }, "products": [ ... ] }
```
- `read`: `owner` (nobody via the API; owner reads in the dashboard) · `user` (a signed-in site user sees only their own rows) · `public`.
- `write`: `public` (anyone may submit; signed-in rows are attributed) · `user` (signed-in only) · `owner` (API refuses).
- **Defaults when omitted** (so today's AI-built sites keep working): `write: public`; `read: user` if `auth.enabled`, else `owner`. Public reads must be asked for explicitly.
- Unknown collection → 404. Names must match `^[a-z0-9_-]{1,40}$`; `transactions` and `_*` are reserved (webhook only). Declared `fields` are an allowlist (unknown keys dropped, type + length checked); row ≤ 16 KB; request body ≤ 64 KB; `max_rows` cap (default 10 000) per collection.
- Reads return only `id, data, created_at`, newest first, `limit ≤ 100` + `before` cursor. New actions `update` / `delete` — **own rows only** (rows with the caller's `site_user_id`).
- A token that is sent but invalid/expired → `401 session_expired` (today it silently degrades to anonymous).

## 3. Site-user accounts and sessions
- Passwords: **PBKDF2-SHA256, 600 000 iterations, per-user 16-byte salt**, stored as `pbkdf2$sha256$600000$salt$hash` in the existing column (iterations live in the string so we can raise them later); constant-time compare; a dummy hash for unknown emails so timing doesn't leak who has an account. Min length 8 (was 6), max 128. Emails lower-cased and validated.
- Sessions: **opaque random 256-bit tokens**, only their SHA-256 is stored (`site_sessions`: hash, project_id, site_user_id, expires_at 30 days). Bound to one project (a token from site A is useless on site B); logout deletes it; deleting a site user (owner, dashboard) cascades their sessions. No new secret needed. Token stays in `localStorage` like today (XSS on the owner's own page could read it — same as every SPA without HttpOnly cookies; third-party cookies to `supabase.co` don't work).
- Not in this step: password reset / email verification (needs the email capability first; list for Step 12/14).

## 4. Rate limiting (Postgres counters)
`rate_limits` table + service-role-only RPC `vx_rate_hit(key, window, limit)` (one atomic upsert; old windows pruned opportunistically). Defaults: login 5 failures / 15 min per (project, email) and 30 / 15 min per IP · signup 5 / h per IP per project and 200 / day per project · submit 30 / 10 min per IP per collection, 2 000 / day per collection · public reads 120 / min per IP per project · `notify_owner` mails 20 / h per project. Over limit → `429` + `Retry-After`. Cost: one extra ~10–30 ms RPC per call.

## 5. Forms → email (Resend)
`"notify_owner": true` on a collection emails the **project owner's account address only** (never a user-supplied recipient, so no open relay), plain text, escaped, throttled as above. Uses the existing `RESEND_API_KEY`; sender same as `trial-emails`.

## 6. SDK `sdk/v1.js`
Served by the publisher Worker at `/__vx/sdk/v1.js` (works on `*.vexium.ai` and custom domains — the Vercel proxy forwards paths) and auto-injected next to the tracker, so pages need no helper code. Source in `sdk/v1.js`, embedded into the Worker by a tiny generator script (committed output).
`vx.auth.{signup, login, logout, user, token, onChange}` · `vx.data.{submit, list, update, remove}` · `vx.forms.{submit, bind(selector, collection)}` · `vx.pay.{buy, buyAmount}` · `vx.track.page`. Old helpers `vxCall / vxSignup / vxLogin / vxLogout / vxCurrentUser / vxGetToken / vxBuy / vxBuyAmount` remain as aliases; the SDK only *assigns* properties on `window`, so pages that still declare their own copies (or `const SITE_ID`) don't throw. Cache: 5 min + stale-while-revalidate; breaking changes → `v2.js`. **Not shipped:** `vx.track.event` (needs storage; Step 13) — omitted rather than stubbed.
Editor preview does not go through the Worker, so SDK injection into the preview is Step 5.

## 7. SECURITY_FINDINGS #10 (and the sibling enumeration RPC)
New edge fn `auth-gate`: `login` (username or email + password → resolves the username server-side, signs in via GoTrue, returns the session; uniform "wrong username or password"; IP + identifier rate limited) and `availability` (replaces the anon `check_signup_availability` RPC). `auth.html` calls it and does `sb.auth.setSession(...)`. Then `REVOKE EXECUTE` of `get_email_by_username` and `check_signup_availability` from anon/authenticated. Email logins can still go straight to GoTrue.

## 8. SQL tab sandbox — recommendation: DEFER (needs your yes/no)
The Step 2 sandbox is verified secure (85/85); what the plan wants fixed is *scale* (it copies ≤ 50 k rows per query). A raw-SQL box can't avoid executing user text, and the "scope by `current_setting`" alternative is escapable (`SELECT set_config(...)`). The scalable, safer replacement is a structured query endpoint (collection + filters + count/group-by) which fits Step 13's server-computed business state. Recommend: leave the sandbox as is, move the replacement to Step 13. With 1 data row today there is no benefit to rushing it.

## 9. Verification (the "Done when")
`supabase/tests/step4_site_backend.sql` (rolled-back catalog/RLS checks) + `supabase/tests/step4_abuse.py` against a throwaway project via HTTP: unknown/private collection unreadable · cross-project token rejected · `transactions` unforgeable · expired/forged token → 401 · brute-force login → 429 · signup/submit spam → 429 · oversize → 413 · field allowlist + row cap · update/delete only own rows · hashes in DB are `pbkdf2$…` · `auth-gate` login works and `get_email_by_username` is denied for anon · SDK served with right headers, then loaded from a really published test site and exercised (forms, signup/login/logout, data list) in a browser.

## Deploy checklist (one approval at the end of the step)
1. Apply migration `20261012140000_site_backend_v2.sql` (tables `site_sessions`, `rate_limits`, RPC `vx_rate_hit`, size checks) FIRST; the revoke of the two anon RPCs is a separate, LAST migration `20261012141000_revoke_enumeration_rpcs.sql` (after `auth-gate` + `auth.html` are live).
2. `supabase functions deploy site-api --no-verify-jwt`, `auth-gate --no-verify-jwt` (new). `site-sql` unchanged if §8 is deferred.
3. `npx wrangler deploy --config publisher/wrangler.toml --keep-vars` (SDK route + injection).
4. `git push` (auth.html change).
