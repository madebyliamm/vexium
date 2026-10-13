# Vertly Revamp — master plan & handoff log

**This file is the source of truth.** Liam starts a new chat and says **"continue"**. Do exactly this:

## Protocol for every chat
1. Read this whole file. Find the first step whose status is not DONE (see "Current step" below).
2. If it is IN PROGRESS, resume from that step's *Handoff notes*. If TODO, run its *Start checks*, then mark it IN PROGRESS.
3. Work the step's *Do* list. Stay inside the step — don't start the next one.
4. Never regress the hard rules in "Known hazards" below.
5. **Ask Liam before:** `git push` (deploys prod via GitHub Pages), `supabase functions deploy`, `wrangler deploy`, setting secrets, DNS/Cloudflare/Stripe changes, anything that costs money, switching Stripe to live mode. Batch these into ONE end-of-step "Deploy checklist" so Liam approves once.
6. When *Done when* is verified: commit locally (no push) with a clear message, set the step to DONE, fill in its *Handoff notes* (what changed, files touched, decisions, gotchas, the next step's first action), bump "Current step", update memory file summaries if structure changed.
7. Finish by telling Liam: what was done, anything *he* must do or test (concrete clicks), and "start a new chat and say **continue**".

**Current step: 3** (update this line at the end of each step)

## Goal
Turn Vertly from "a chat box that builds a site" into a guided **business creator**:
**PLAN → EXAMPLE BUILD → FULL BUILD → TWEAKS → LAUNCH → BUSINESS.**
Finished = a brand-new user can go idea → live URL on `*.vexium.ai` (launch-ready, no fake content) → business dashboard with an AI partner, without ever touching code.

## Locked decisions (2026-10-12 — don't relitigate without Liam)
- **Stages are explicit state the user controls, never inferred from the message.** (The old rule "no intent detection before `aiCallAPI()`" came from a bug caused by *guessing*; explicit stages don't violate it.) Each stage produces a saved **artifact** the next stage reads (plan → style spec → site manifest → launch checks → business state) instead of replaying chat history.
- **Generated user sites stay build-free HTML/CSS/JS** (no React/Next/bundler for outputs). Structure upgrades: shared `styles.css` tokens + `site.js` + shared nav/footer; a hosted, versioned **Vertly SDK** (`vx.auth/data/pay/forms/track`) instead of the AI re-typing helpers into every page. `kind: site | app` in the project format; every site gets a PWA manifest.
- **Backend = platform capabilities, not AI-written server code** (forms→email, bookings, newsletter, payments, auth, collections). No arbitrary code execution for strangers.
- **Hosting v2:** publish writes immutable versioned deploys to Cloudflare R2, served from the edge with caching; rollback = move a pointer. Images are real files, not base64 in jsonb.
- **Platform app (Vertly itself) = Vite + TypeScript + Preact**, built in CI (GitHub Actions already deploys Pages — add a build step). Old pages keep working until the new studio replaces them. *(This replaces the old "never add a build step" rule, which now applies only to generated user sites.)*
- **Paywall:** PLAN + EXAMPLE BUILD are free (cheap). FULL BUILD (launch-ready site) is the paid unlock.
- **Revenue projections** = a scenario calculator with visible, editable assumptions (price × traffic × conversion). Never presented as promises.
- **No fake content:** no fake reviews/logos/stats. Anything the AI can't know (photos, real products, testimonials, legal text) is collected in PLAN as a launch-content checklist; sections with no real content are omitted. A **launch verifier** (lorem, `#` links, dead forms, broken checkout, FakeCo rows) gates LAUNCH.
- **Not now:** React/Next as default output, native iOS/Android, AI-written server code. (`kind` leaves room for a later "pro tier" on Cloudflare sandbox containers.)
- No real users yet → breaking changes are fine; no data migration needed beyond Liam's own test projects.
- Strategic posture unchanged: always look like a large, established company; light theme + purple (see design memory).

## Known hazards (read before touching code)
- **iCloud:** repo is on iCloud Desktop; macOS evicts files → reads fail with "Resource deadlock avoided". Fix: run the materialize script in memory `reference_icloud_dataless_files.md` (sandbox disabled). Moving the repo changes the Claude memory path (`~/.claude/projects/<path-slug>/memory`) — copy the memory dir if Liam ever moves it.
- Old `editor.html` (10k lines): keep working until cutover. Read memory `feedback_vexium_critical_rules.md` before editing it or `ai-chat/index.ts` (continuation/cache/usage-tracking invariants).
- Supabase anon key must be identical in every page + `config.js` + `worker.js` (a stale key once broke login).
- `stripe-connect-start/status` deploy WITHOUT `--no-verify-jwt`; `site-checkout` + `webhook` WITH it.
- Stripe is TEST mode until Step 14.
- `supabase/functions/ai-chat` deploys via `supabase functions deploy ai-chat --no-verify-jwt`; build Worker via `npx wrangler deploy --config cf-worker/wrangler.toml`.
- Deployed `ai-chat` (v199) is byte-identical to the repo as of 2026-10-12 — the soft-defaults / "build real products" prompt edits ARE live.
- **Security state after Step 2 (`docs/SECURITY_FINDINGS.md` has the status board):** the critical holes (#1–3, 9, 11, 13) are fixed and re-verified by `supabase/tests/step2_security_lockdown.sql`. STILL OPEN and blocking launch: **`get_email_by_username` leaks real emails to anyone (#10, HIGH)** and the `site-api` holes #4–6, 8 (Step 4). **Found in Step 3: #16 — `projects` UPDATE/DELETE were open to everyone (anon could deface/delete any published site). Fix is written + verified but NOT yet applied to prod until Liam approves (Step 3 deploy checklist, item 1).** Don't build new features on `site-api` until Step 4.
- **Billing/plan/credits/Stripe ids live in `public.account_billing`, NOT `profiles`** (own-row SELECT for clients, service-role writes). `profiles` is public data with column-level grants: no `select('*')`, no `email` (use `public_email` / the auth session), and a new profile column is invisible to clients until added to the GRANT lists in a new migration. Server code reads/writes billing only via `supabase/functions/_shared/db.ts`.
- **Auth model for edge functions:** the project signs tokens with ES256, so functions that need the user stay `--no-verify-jwt` and verify in-function via GoTrue (`/auth/v1/user`). `ai-chat` and `site-sql` now do; `ai-chat` returns 401 for anyone not signed in. Never trust an undecoded JWT `sub`; never treat the anon key as a user. (`docs/INFRA.md`)
- Migrations are applied by hand (`supabase db query --linked -f supabase/migrations/<file>`) and committed as the record; a test script with a final `RAISE EXCEPTION` (see `supabase/tests/`) is the safe way to dry-run + verify against prod.
- CLI recipes that work without Docker: `supabase functions download --use-api <fn>`; `supabase db query --linked -o json "<sql>"` (or `-f file.sql`); `python3 scripts/export-schema.py` refreshes `supabase/schema.sql`. Wrangler is NOT installed (`npx wrangler` needs a download + `wrangler login`).

---

# PHASE A — Foundations (product backend; the old editor keeps working throughout)

### Step 1 — Recon & baseline — `DONE` (2026-10-12)
**Goal:** get everything that exists only on Supabase/Cloudflare into the repo so nothing later is built blind.
**Handoff notes:**
- Downloaded the 5 missing edge functions into `supabase/functions/` (`site-api`, `site-sql`, `analytics`, `track`, `custom-domain`). All 14 deployed functions now have source in the repo. Deployed == repo for all (3 Stripe files differ only by a "Vexium"→"Vertly" comment).
- `supabase/schema.sql` (674 lines: 14 tables, 21 functions, 39 policies, 1 bucket) generated by `scripts/export-schema.py` (re-runnable). `docs/SCHEMA.md` = what each table is for. `docs/INFRA.md` = request paths, function table (verify_jwt/version), secret names, deploy commands. Cloudflare routes/DNS were NOT inspected (no wrangler/login) — Step 3 should log in and fill that in.
- `supabase/.temp/` untracked + gitignored.
- **Big finding:** `docs/SECURITY_FINDINGS.md` — anonymous callers can run `vexium_site_query` (appears to allow arbitrary SQL, read+write), anyone can call `increment_usage` on any user, users can UPDATE their own plan/credits in `profiles`, `site-api` exposes every collection to anyone and lets anyone forge `transactions`, site passwords are SHA-256 with a constant salt. Nothing was exploited or tested on prod; findings come from reading definitions.
- DB is nearly empty (5 profiles / 9 projects / 1 site_data row) → safe to make breaking changes.
- Dead stuff noticed: table `plan_messages` (unused), function `log_usage` (references missing columns).
- **Next action (Step 2):** present the lockdown SQL from `docs/SECURITY_FINDINGS.md` to Liam for one-batch approval, apply it, verify with rolled-back catalog tests.

### Step 2 — Security lockdown (CRITICAL, do before anything else) — `DONE` (2026-10-12)
**Goal:** close the holes in `docs/SECURITY_FINDINGS.md` #1–3, #9, #11 and the cheap parts of #5 on production, without breaking the old editor/home/settings pages.
**Start checks:** read `docs/SECURITY_FINDINGS.md`; `supabase db query --linked` works.
**Do:**
- Write `supabase/migrations/<timestamp>_security_lockdown.sql` (new dir; applied via `supabase db query --linked -f`, then committed as the record).
  - `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` on `vexium_site_query`, `increment_usage`; drop `log_usage`. **Do NOT revoke** the helpers used inside RLS policies (`is_project_owner`, `is_project_member`, `get_my_member_project_ids`, `is_following`…) — policies evaluate them as the calling role. Review each remaining SECURITY DEFINER function individually; trigger functions need no client execute.
  - `profiles`: split billing/usage/Stripe columns (`plan, trial_ends_at, selected_plan, credits_used_cents, extra_credits_*, plan_cycle_start, billing_period, tokens_used_this_month, usage_month, stripe_*`) into a private table (e.g. `account_billing`, own-row SELECT only, NO client writes) or equivalent column-level grants; restrict public profile reads to public columns (username, display_name, bio, avatar, banner, counts) via a view; stop exposing `email`. Then update the old pages that read/write those columns (grep `.from('profiles')` — ~49 call sites in home/profile/settings/editor/analytics/index) and the edge functions (`ai-chat`, `stripe-*`, `_shared/db.ts`, `cf-worker`) that write them (they use the service role, so they keep working).
  - Drop `billing_history` client INSERT policy (writes come from the webhook/service role).
- `site-sql`: redeploy with JWT verification ON (no `--no-verify-jwt`) and verify the user with `auth.getUser`.
- `site-api` interim patch: `submit` may not write to `transactions` (webhook only); `get_data` may not read `transactions`. (Full rules come in Step 4.)
- Verify with ROLLED-BACK transactions via `supabase db query --linked` (e.g. `BEGIN; SET LOCAL ROLE authenticated; … UPDATE profiles SET plan='max' …; ROLLBACK;`) and catalog checks (`has_function_privilege`). Never attack prod for real.
- Re-run `supabase db advisors --linked`; regenerate `supabase/schema.sql`; mark each finding FIXED/OPEN in `docs/SECURITY_FINDINGS.md`.
**Done when:** `anon` and `authenticated` cannot execute the revoked functions; a signed-in user cannot change plan/credits/Stripe ids on their own row; public profile reads expose no email/billing; old home/profile/settings/editor still load, show plan + credits, and a build still bills usage; findings doc updated.
**Needs Liam:** approve the SQL + the function redeploys in ONE batch; open the old app afterward and click through home → profile → settings → a build. *(Approved and deployed; Liam's click-through is the one remaining human check.)*
**Handoff notes:**
- **Deployed (all verified live):** migration `supabase/migrations/20261012120000_security_lockdown.sql`; 11 functions (`ai-chat`, `site-sql`, `site-api`, `trial-emails`, `stripe-webhook`, `stripe-site-checkout` with `--no-verify-jwt`; `stripe-checkout/-portal/-extra-usage/-connect-start/-connect-status` with JWT on); pages pushed (`24348b6`). No Cloudflare deploy was needed. Verification: 85/85 checks pass against prod (`supabase/tests/step2_security_lockdown.sql`), plus black-box curl checks with only the anon key (RPCs → 401 permission denied; `profiles?select=email|*|plan` denied; `account_billing` denied; `ai-chat`/`site-sql` reject no-auth, anon-key and forged-JWT callers; `site-api` refuses `transactions`).
- **What changed:** (1) `increment_usage`/`vexium_site_query` service-role only; `log_usage` dropped. (2) New `account_billing` (billing + usage + Stripe ids moved out of `profiles`, columns dropped from `profiles`); `profiles` column-grants; `public_email` trigger. (3) `vexium_site_query` rewritten: runs the owner's SELECT in `vx_sandbox.run()` owned by no-privilege role `vexium_sql_ro`, on TEMP copies of that project's rows, single statement, 8s timeout. (4) `billing_history` webhook-only; `site_users.password_hash` hidden from clients. (5) `handle_new_user` also creates the billing row with a server-side 7-day trial. (6) `ai-chat` now verifies the user via GoTrue and 401s otherwise (it was skipping the credit gate + billing for unauthenticated callers). (7) `site-sql` verifies the caller via GoTrue. (8) `site-api` blocks the `transactions` collection (both submit and get_data). (9) `trial-emails` needs the service key and reads `account_billing`. (10) Pages: `trialGuard.js`, `home`, `profile`, `settings`, `editor` read billing from `account_billing`; `profile`/`settings` list profile columns explicitly; `auth.html` no longer writes billing at signup (sends `selected_plan` as signup metadata); `settings.html` account deletion now calls the real RPC `delete_own_account`.
- **Deviation from the plan:** the plan said redeploy `site-sql` with gateway JWT verification ON. Not done: tokens are ES256 and the gateway has rejected those before, so verification happens inside the function instead (docs/INFRA.md explains). Also pulled forward from Step 4: the SQL-tab sandbox (otherwise any signed-up user could still `SELECT * FROM auth.users` through `site-sql`).
- **Advisors:** anon-callable SECURITY DEFINER 17→7 (the rest are intentional RLS helpers + public lookups), search_path-mutable 16→0. `supabase/schema.sql` regenerated (does not show the `vx_sandbox` schema / `vexium_sql_ro` role — they're in the migration).
- **Still open / for Liam:** (a) `#10 get_email_by_username` leaks REAL emails (see findings; fix = server-side username login) — do before launch; (b) enable "leaked password protection" in the Supabase dashboard (Auth → Passwords, free); (c) accounts "Nick" and "daveSquirrel" have `trial_ends_at = NULL` so their trial never expires — left untouched; (d) `trial-emails` has no scheduler; (e) account deletion now points at a real RPC but wasn't exercised on a real account.
- **Gotchas for later steps:** a `statement_timeout` cancel can't be caught in PL/pgSQL (aborts the whole request) — fine for prod, but don't test it via try/except. `SET ROLE` inside SECURITY DEFINER checks the SESSION user (`authenticator` under PostgREST), which is why the sandbox uses a function *owned by* the low-privilege role instead of switching roles. The `supabase` CLI DB session is `postgres` but can't `SET ROLE supabase_auth_admin`.
- **Next action (Step 3):** run its Start checks — `npx wrangler login` (ask Liam: it needs a download + browser login), record the real Worker routes / DNS / Vercel setup into `docs/INFRA.md`, then design the R2 publish endpoint. Ask Liam to enable R2 on the Cloudflare account first (may need billing on file).

### Step 3 — Hosting v2 (R2 versioned deploys) — `IN PROGRESS` (code + DB written and tested offline; waiting on Liam for the deploy checklist below)
**Goal:** published sites are fast, cached, versioned, and roll-back-able.
**Start checks:** `npx wrangler login` (install/download as needed — ask Liam); record the real Worker routes, DNS and Vercel setup into `docs/INFRA.md`.
**Do:**
- Server-side `publish` endpoint (recommend a CF Worker with an R2 binding; JWT-authenticated): stores immutable `projects/{id}/v{n}/…`, flips a `published_version` pointer; images stored as real files.
- Rewrite the publisher Worker (`worker.js`) to serve from R2 with edge cache + correct headers; keep subdomain + custom-domain routing; fall back to legacy `published_files` jsonb for old projects.
- Rollback = move pointer. Old editor's Publish/Unpublish/Republish buttons call the new endpoint.
- Evaluate replacing the Vercel hop for custom domains with Cloudflare for SaaS custom hostnames (fewer moving parts, faster); implement only if clean.
**Done when:** publish → live URL served from R2 with cache headers; republish makes v2; rollback to v1 works; custom domain still works; TTFB measurably better than the old Supabase-per-request path.
**Needs Liam:** enable R2 on the Cloudflare account (may need billing on file); `wrangler login`; approve Worker deploys.
**Handoff notes (state as of 2026-10-13, mid-step):**
- **Security find (do first):** prod `projects` had `USING (true)` UPDATE/DELETE policies + anon write grants → anyone with the anon key could overwrite/delete any published site (SECURITY_FINDINGS **#16**, also **#17** open notifications INSERT). Confirmed read-only (rolled-back test: before = 12/18 FAIL, i.e. exploitable; with the migration spliced in = 18/18 pass). Fix: `supabase/migrations/20261012130000_projects_rls.sql` (owner-or-accepted-collaborator UPDATE, owner DELETE, owner-change trigger, anon writes revoked). **NOT applied yet.** No page/function redeploy needed.
- **Written + tested, NOT deployed:**
  - `supabase/migrations/20261012131000_hosting_v2.sql` — `project_deploys`, `projects.published_version`, `resolve_published_site()` RPC, trigger blocking client writes to `published_version`/`custom_domain*`, unique custom domain. Dry-run with the test spliced in: 30/30 (`supabase/tests/step3_hosting_v2.sql`; to dry-run again splice the migration minus BEGIN/COMMIT before the "-- ── A." marker, see how `/tmp/step3b_dryrun.sql` was built: python split on that marker). After applying, run the test file unmodified.
  - `publisher/` — the new `vexium-publisher` Worker in TypeScript (serve from R2 + publish/rollback/unpublish API + legacy fallback). `node --test 'publisher/test/*.test.ts'` → 26/26 (fake R2 + fake Supabase); strict `tsc` clean. **Never run in the real Workers runtime or against real R2 yet.**
  - `editor.html` — Publish / Update / Unpublish call the Worker (`_pubApi`, `PUBLISH_API`); no more direct writes of `published_files`. Shows server errors (slug taken, over 25 MB…) as toasts.
  - `supabase/functions/_shared/db.ts` `getProjectCommerce` — v2 sites read the live deploy's `_backend` (and ignore draft `files`) so `stripe-site-checkout` prices come from what is actually published.
- **Design decisions:** (1) Files in R2 `p/<project>/v<n>/<path>`, images decoded from data: URLs into real binaries; `_`-prefixed files (e.g. `_backend`) never published, parsed `_backend` stored on the deploy row. (2) Publish allocates the version first (`uploading`), writes all objects, marks `ready`, flips the pointer LAST → a failed upload never changes the live site. (3) Routing = one anon-callable RPC cached 10 s in the isolate (the Cache API doesn't work on workers.dev, which custom-domain traffic uses, so no zone cache yet — measure after deploy). (4) HTML/CSS/JS revalidate with ETags; unknown paths are real 404s (better for the Step 10 verifier); legacy sites keep the old fallback-to-main-page. (5) Keep newest 20 versions. (6) `published_files` is no longer written; old values stay until Step 14 cleanup (home/profile thumbnails still read `published_files||files`). (7) Rename of a published project still updates `published_slug` directly (client-writable on purpose; the RPC resolves by it).
- **Baseline TTFB (old path, 2026-10-13, from a Mac in Canada):** `liam.vexium.ai/webre` 0.65–0.80 s (first hit 1.8 s); `www.webre.co` (via Vercel) 0.45–0.47 s; bare Worker ping 0.15 s. Target after deploy: well under that for both.
- **Known limits to remember:** `<base href="/slug/">` makes `#anchor` links on sub-pages jump to `/slug/#anchor` (pre-existing; fixed properly by Step 5's root-relative shared nav); no Range requests (video seek) yet; not yet evaluated: Cloudflare for SaaS custom hostnames vs the Vercel hop (needs the Cloudflare login — do it right after the deploy).

**Deploy checklist for Liam (approve once, in this order):**
1. Apply `20261012130000_projects_rls.sql` (security fix #16), then run `supabase/tests/step3_projects_rls.sql` unmodified → expect 18/18.
2. Apply `20261012131000_hosting_v2.sql`, then run `supabase/tests/step3_hosting_v2.sql` unmodified → expect 30/30.
3. Cloudflare (needs Liam): enable R2 in the dashboard (free tier 10 GB; may require a card on file) → `npx wrangler login` (browser click; downloads wrangler) → record real routes in `docs/INFRA.md` → `npx wrangler r2 bucket create vertly-sites` → `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config publisher/wrangler.toml` → `npx wrangler dev --config publisher/wrangler.toml` smoke test → `npx wrangler deploy --config publisher/wrangler.toml`.
4. `supabase functions deploy stripe-site-checkout --no-verify-jwt` (AFTER step 2, it reads `published_version`).
5. `git push` (ships the editor change — do it right after step 3; until then the OLD editor + NEW Worker still works for legacy sites, but an old-editor "Update" on an already-v2 site would be ignored).
6. Verify (Claude does this): publish the test project → live at `liam.vexium.ai/<slug>` with `x-vertly-version: 1`, republish → v2, rollback → v1 (via a throwaway test user token or Liam's session), custom domain `www.webre.co` still serves, TTFB vs baseline above. Then delete root `worker.js` + `wrangler.toml` (superseded), update memory summaries (`file_worker_js.md`, `project_publishing_status.md`), mark the step DONE.
- **Next action when Liam says "continue":** if the checklist is approved → execute it in order and finish the verify step above; if Liam hasn't done R2/login yet → remind him of item 3. Then the Cloudflare-for-SaaS evaluation, then close the step and move to Step 4 (also close #10 `get_email_by_username` there).

### Step 4 — site-api v2 + Vertly SDK — `TODO`
**Goal:** the backend for generated sites is safe and capability-based, with a versioned client SDK.
**Do:**
- Enforce the project's declared `_backend` server-side: per-collection access rules (read: public | owner | user-own; write: public-submit | user | owner), unknown collections rejected, size limits, `transactions` writable only by the webhook.
- Real site-user auth: PBKDF2/argon2 with per-user salt (or Supabase Auth), signed expiring session tokens (not the row id), rate limiting on login/signup/submit.
- Replace the SQL tab's `vexium_site_query` sandbox (Step 2 interim: TEMP-table copies + `vexium_sql_ro`) with per-project views/read-only access that scales (no row copying, no string-concatenated user SQL).
- Also close SECURITY_FINDINGS **#10**: server-side username login (edge fn resolves + signs in, rate-limited), then revoke `get_email_by_username` from anon/authenticated — unless it was already done in the studio auth work.
- Capabilities: forms→email (Resend), plus whatever the plan needs (bookings/newsletter can wait).
- `sdk/v1.js` (`vx.auth`, `vx.data`, `vx.pay`, `vx.forms`, `vx.track`) served by the publisher Worker; keep `vxCall`/`vxBuy` as aliases.
**Done when:** scripted abuse tests against a throwaway project fail as intended (can't read a private collection, can't forge `transactions`, can't brute-force logins, can't exceed limits) and the SDK works from a published site.
**Deploy checklist:** `site-api`, `site-sql`, publisher Worker, DB migration.
**Handoff notes:** _(fill in)_

### Step 5 — Project format v2 + AI output upgrade — `TODO`
**Goal:** generated sites are structured, themeable from one place, and call the SDK.
**Do:**
- `docs/PROJECT_FORMAT.md`: shared `styles.css` (design tokens), `site.js`, shared nav/footer, `_backend` (with the Step 4 access rules), PWA `manifest.json`, `kind: site|app`.
- Update `ai-chat` + `cf-worker` prompts/parser: use SDK + shared files, stop emitting inline helpers, one token source, edits patch shared files; delete the "FakeCo" / fake-social-proof guidance.
**Done when:** a fresh build in the OLD editor yields a multi-file site using shared styles + the SDK; forms, auth and checkout (test mode) work on the published URL; changing one token in `styles.css` re-themes every page.
**Deploy checklist:** `ai-chat`, `cf-worker`.
**Handoff notes:** _(fill in)_

# PHASE B — New app foundation

### Step 6 — Scaffold Vite + TypeScript + Preact — `TODO`
**Goal:** a real app skeleton that deploys alongside the old static pages.
**Do:** new app dir (decide name, e.g. `studio/`); single `tokens.css` (the canonical light-theme block from design memory); one Supabase client/config module; auth guard; router; typed API client for ai-chat/build-worker; tiny state store; GitHub Actions workflow builds the app and publishes it together with the legacy static pages; `tsc` typecheck in CI.
**Done when:** push to `main` deploys old pages unchanged + a working `/studio` route behind login, using shared tokens; CI typechecks.
**Handoff notes:** _(fill in)_

### Step 7 — Stage engine (artifacts + state machine) — `TODO`
**Goal:** the backbone of the flow.
**Do:** schema for `projects.stage` and versioned artifacts (e.g. `project_artifacts(project_id, kind, version, data jsonb, stale bool)`) with RLS written correctly from day one; TS types for Plan / StyleSpec / Manifest / LaunchChecks / BusinessState; stage navigation rules (go back freely; editing an upstream artifact marks downstream stale); stage-specific AI endpoint skeletons that inject only the artifacts they need (cache-stable), replacing the onboarding gate; resume-after-refresh using `build_jobs`.
**Done when:** a project can move between stages in the studio with persisted artifacts and stale-marking, covered by a test script.
**Handoff notes:** _(fill in)_

# PHASE C — The flow

### Step 8 — PLAN stage — `TODO`
Studio UI: chat on one side, **live plan document** on the other (name, audience, offer, pricing, pages, backend needs, launch-content checklist, revenue-scenario calculator). AI asks 1–2 questions, drafts the plan card fast; user edits the card directly. "I know what I want" path: one-line prompt → auto-drafted plan to confirm. **Done when:** a vague idea becomes a complete, editable, saved plan in ~2 minutes.
**Handoff notes:** _(fill in)_

### Step 9 — EXAMPLE BUILD stage — `TODO`
Builds only the landing page + a style spec (tokens, fonts, tone). Vibe controls (theme, color, type, density, tone) re-skin by swapping tokens — no regeneration. "Lock this style" freezes the StyleSpec the full build must obey. Free tier ends here. **Done when:** user sees their landing page, changes vibe in seconds, and locks it.
**Handoff notes:** _(fill in)_

### Step 10 — FULL BUILD stage — `TODO`
Parallel per-page builds from Plan + StyleSpec with shared files; real backend wiring (collections, products, forms, auth) from the plan; progress checklist UI; **launch verifier** (headless load + link/form/checkout checks, placeholder/fake-content scan) that auto-fixes or reports; cost accounting per build. **Done when:** a plan produces a complete multi-page site with zero placeholder content and a passing verifier report.
**Handoff notes:** _(fill in)_

### Step 11 — TWEAKS stage — `TODO`
Click an element in the preview → say what to change (patch pipeline); device frames; automatic checkpoint per stage; undo/redo and restore; edits stay draft until published. **Done when:** a non-technical user can fix text, color, layout by pointing and talking.
**Handoff notes:** _(fill in)_

### Step 12 — LAUNCH — `TODO`
Pre-launch checklist (verifier results, content checklist, domain, payments connected), publish via Hosting v2, custom domain, QR code, celebration, "what's next" handoff into BUSINESS. **Done when:** idea → live `*.vexium.ai` URL entirely inside the studio.
**Handoff notes:** _(fill in)_

# PHASE D — Business & go-live

### Step 13 — BUSINESS v1 — `TODO`
Server-computed business state (traffic from `track`/`analytics`, revenue from `site_data` + Stripe, signups); weekly digest; AI business partner grounded ONLY in that state (says "not enough data yet" early); actionable recommendations with one-click **Apply** → TWEAKS pipeline; plan projections replaced by actuals; post-launch default view with one-click "Edit site" and "Update live site". Marketing helpers (posts, emails, launch checklist) need no integrations. **Done when:** after launch the app opens to a useful business view and a recommendation can be applied in one click.
**Handoff notes:** _(fill in)_

### Step 14 — Paywall, cutover, go-live prep — `TODO`
Wire free/paid gating (PLAN + EXAMPLE free, FULL BUILD paid) to existing plans/credits; point home "New project" at the studio and retire (or demote to "Pro mode") the old editor; finish Vexium→Vertly renames; Stripe test→live checklist (keys, price IDs, webhook secrets); full `/security-review` + `supabase db advisors --linked` + re-run `scripts/export-schema.py`; end-to-end QA script; performance pass; remove dead code (`plan_messages`, `log_usage`, old Supabase-path build fallback if unused). **Done when:** the final acceptance test passes.

## Final acceptance test
Fresh account → idea → PLAN → EXAMPLE BUILD (change vibe) → upgrade → FULL BUILD → verifier passes → TWEAK by pointing → LAUNCH to live URL → test purchase works → BUSINESS view shows it → Apply a recommendation → Update live site. Plus: a scripted abuse suite (Step 4) and advisors report are clean.
