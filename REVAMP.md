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

**Current step: 2** (update this line at the end of each step)

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
- **The production Supabase project has critical security holes (see `docs/SECURITY_FINDINGS.md`) — Step 2 fixes them before any real user arrives. Don't build new features on top of `site-api`, `site-sql`, `increment_usage` or `profiles` billing columns until then.**
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

### Step 2 — Security lockdown (CRITICAL, do before anything else) — `IN PROGRESS`
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
**Needs Liam:** approve the SQL + the function redeploys in ONE batch; open the old app afterward and click through home → profile → settings → a build.
**Handoff notes:** _(fill in)_

### Step 3 — Hosting v2 (R2 versioned deploys) — `TODO`
**Goal:** published sites are fast, cached, versioned, and roll-back-able.
**Start checks:** `npx wrangler login` (install/download as needed — ask Liam); record the real Worker routes, DNS and Vercel setup into `docs/INFRA.md`.
**Do:**
- Server-side `publish` endpoint (recommend a CF Worker with an R2 binding; JWT-authenticated): stores immutable `projects/{id}/v{n}/…`, flips a `published_version` pointer; images stored as real files.
- Rewrite the publisher Worker (`worker.js`) to serve from R2 with edge cache + correct headers; keep subdomain + custom-domain routing; fall back to legacy `published_files` jsonb for old projects.
- Rollback = move pointer. Old editor's Publish/Unpublish/Republish buttons call the new endpoint.
- Evaluate replacing the Vercel hop for custom domains with Cloudflare for SaaS custom hostnames (fewer moving parts, faster); implement only if clean.
**Done when:** publish → live URL served from R2 with cache headers; republish makes v2; rollback to v1 works; custom domain still works; TTFB measurably better than the old Supabase-per-request path.
**Needs Liam:** enable R2 on the Cloudflare account (may need billing on file); `wrangler login`; approve Worker deploys.
**Handoff notes:** _(fill in)_

### Step 4 — site-api v2 + Vertly SDK — `TODO`
**Goal:** the backend for generated sites is safe and capability-based, with a versioned client SDK.
**Do:**
- Enforce the project's declared `_backend` server-side: per-collection access rules (read: public | owner | user-own; write: public-submit | user | owner), unknown collections rejected, size limits, `transactions` writable only by the webhook.
- Real site-user auth: PBKDF2/argon2 with per-user salt (or Supabase Auth), signed expiring session tokens (not the row id), rate limiting on login/signup/submit.
- Replace the SQL tab's `vexium_site_query` approach with a read-only role + per-project views (no string-concatenated user SQL).
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
