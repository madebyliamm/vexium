# Infrastructure map (verified 2026-10-12 unless marked UNVERIFIED)

No secrets here — names only.

## Request paths
```
Vertly app (static pages)  →  GitHub Pages (repo madebyliamm/vexium, workflow .github/workflows/static.yml, deploys on push to main)
Published site  *.vexium.ai/<slug>  →  Cloudflare Worker `vexium-publisher` (publisher/) → ONE cached RPC `resolve_published_site` (host or username+slug → project + live version) → file from R2 `p/<project_id>/v<n>/<path>` (+ <base>, project id, tracker injected) — v2, after the Step 3 deploy. Before it / for sites never republished: the old path (project row from Supabase REST on every request, CSS/JS/images inlined from `published_files`), kept as the Worker's `legacy` fallback.
Published site on a custom domain  →  DNS CNAME cname.vercel-dns.com → Vercel project `vexium` (vercel-proxy/api/proxy.js, edge fn) → forwards to vexium-publisher.startafter.workers.dev with x-forwarded-host → same Worker
Publish / Rollback / Unpublish (editor)  →  POST vexium-publisher.startafter.workers.dev/__vx/{publish,rollback,unpublish} with the user's Supabase access token → Worker verifies it with GoTrue, checks owner/accepted-collaborator, writes R2, flips `projects.published_version`
AI builds   →  Cloudflare Worker `vexium-ai-build` (cf-worker/) → asks Supabase `ai-chat` to PREPARE the prompt → streams Anthropic → SSE to the editor
Everything else (auth, DB, AI prompts, Stripe, analytics, site backend)  →  Supabase project ciuqhxrxcznmgorjeumz
```
Liam confirms `*.vexium.ai` routes and custom domains work in production. Worker routes / DNS records were **not** inspected from the CLI (wrangler not installed, not logged in) — UNVERIFIED in detail; Step 3 should `npx wrangler login` and record them here.

## Supabase edge functions (project `ciuqhxrxcznmgorjeumz`) — all source now in `supabase/functions/`
| function | gateway verify_jwt | auth inside the function | purpose |
|---|---|---|---|
| ai-chat | off | **GoTrue-verified user required** (401 otherwise; 60s per-isolate token cache) | prompts, onboarding gate, spec pass, prepare/suggest modes for the build Worker, usage gate + tracking (reads `account_billing`) |
| site-api | off | none (public, project_id-scoped) — `transactions` collection blocked; full rules in Step 4 | backend for generated sites: signup/login/submit/get_data |
| site-sql | off | **GoTrue-verified owner** (`auth/v1/user`), then project ownership check | owner's read-only SQL tab → RPC `vexium_site_query` (sandboxed) |
| track | off | none (public collector) | page-view collector → `page_views` |
| analytics | on | gateway | owner's projects + page views |
| custom-domain | off | `auth.getUser` + ownership | adds/removes/checks domains on the Vercel project |
| stripe-checkout / -portal / -extra-usage | on | gateway + `userIdFromJwt` | platform billing |
| stripe-connect-start / -status | on | gateway + `userIdFromJwt` | Connect onboarding (account-level) |
| stripe-site-checkout | off | none (public buyer checkout) | buyer checkout for generated sites |
| stripe-webhook | off | Stripe signature | platform + Connect webhooks |
| trial-emails | off | **service-role key required** (no caller exists yet — nothing schedules it) | trial reminder emails (Resend) |

**Why in-function auth instead of gateway `verify_jwt`:** the project signs user tokens with **ES256** (see `/auth/v1/.well-known/jwks.json`); the edge gateway has rejected ES256 tokens before (the editor even has an anon-bearer fallback for it). So functions that must know the user stay `--no-verify-jwt` and verify the token with GoTrue themselves. Never trust `sub` from an undecoded JWT, and never treat the anon key as a user. All functions that read/write billing go through `supabase/functions/_shared/db.ts`, which merges `profiles` + `account_billing` and routes writes to the owning table.
Function versions: run `supabase functions list`.

Deploy: `supabase functions deploy <name>` (add `--no-verify-jwt` ONLY for those marked off). Download a deployed copy without Docker: `supabase functions download --use-api <name>`.
Drift check 2026-10-12 (after Step 2 deploy): repo == deployed (spot-checked stripe-checkout, stripe-connect-status via `functions download --use-api`).

## Secrets in use (names only)
Supabase function secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `RESEND_API_KEY`, `VERCEL_TOKEN_KEY`.
Build Worker secrets: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`).
Public (by design): Supabase anon key in `config.js`, `worker.js`, `cf-worker/wrangler.toml`, a few pages — must stay identical everywhere.

## Cloudflare Workers
- `vexium-publisher` — **`publisher/`** (`wrangler.toml`, `src/*.ts`, tests in `publisher/test`), URL `vexium-publisher.startafter.workers.dev`. R2 binding `SITES` → bucket `vertly-sites`; var `SUPABASE_URL`/`SUPABASE_ANON_KEY`; secret `SUPABASE_SERVICE_ROLE_KEY`. Deploy: `npx wrangler deploy --config publisher/wrangler.toml`. Tests: `node --test 'publisher/test/*.test.ts'` (Node ≥ 22.18, no install needed; fake R2 + fake Supabase). The previous implementation (root `worker.js` + `wrangler.toml`) is superseded; recover it from git history (`git show 06fd480:worker.js`) to roll the Worker back — v2 sites would then not serve, so only do that before anyone republishes.
  - Serving: `*.vexium.ai/<slug>/…` and custom domains. HTML is revalidated on every load (ETag/304); CSS/JS/JSON 5 min; images/fonts 1 h. Unknown paths are real 404s (the site's own `404.html` if it has one) — the legacy path still falls back to the main page. `_`-prefixed files (e.g. `_backend`) are never published; the parsed `_backend` is stored on `project_deploys.backend`.
  - Route cache: 10 s in the Worker isolate (3 s for misses). A publish/rollback/unpublish clears it in the isolate that handled it and reaches every other isolate within ~10 s. (The Cache API does not work on `workers.dev`, which custom-domain traffic goes through, so there is deliberately no zone-cache layer yet — measure first.)
  - API limits: 30 MB body, 25 MB total, 8 MB per file, 500 files; keeps the newest 20 versions per project.
- `vexium-ai-build` — `cf-worker/wrangler.toml`, `main = worker.ts`, URL `vexium-ai-build.startafter.workers.dev`. Deploy: `npx wrangler deploy --config cf-worker/wrangler.toml`. `cf-worker/core.ts` is byte-extracted from `ai-chat/index.ts`; re-extract if the stream parser changes. Revert builds to Supabase by setting `AI_BUILD_URL = AI_EDGE_URL` in `editor.html`.
- **Cloudflare account (verified 2026-10-13 via `wrangler whoami`):** account id `8312e119fba2b69168d4b1d45546359a`, workers.dev subdomain `startafter`. Wrangler isn't installed globally — use `npx --yes wrangler@latest …` (4.149.0 at the time). Login = OAuth token in `~/Library/Preferences/.wrangler/config/default.toml` (scopes include workers/routes/zone-read/ssl/queues…; no listing of R2 scope but `r2 bucket create/list` work).
- **R2:** bucket `vertly-sites` created 2026-10-13 (Standard, automatic location). Empty until the first v2 publish.
- **Live `vexium-publisher` before the v2 deploy:** version `e211a1d6-e726-460b-8e48-838bb82bb55d` (the old root `worker.js`; last change = a secret change 2026-06-26). **Rollback:** `npx wrangler rollback e211a1d6-e726-460b-8e48-838bb82bb55d --name vexium-publisher` (instant; v2-published sites then 404 until re-rolled-forward). Its secrets: `SUPABASE_SERVICE_ROLE_KEY` (persists across deploys; the new Worker uses it) and a leftover `ANTHROPIC_API_KEY` the publisher never uses (candidate to delete: `npx wrangler secret delete ANTHROPIC_API_KEY --name vexium-publisher`).
- **Routes / DNS:** there is no wrangler command to list zone routes, so the exact `*.vexium.ai/*` route + zone are still not recorded here (the API/dashboard has them). Deploying from `publisher/wrangler.toml` (no `routes`, same Worker name) leaves them untouched; post-deploy verification = `liam.vexium.ai/webre` + `www.webre.co` keep serving.

## Vercel
Project `vexium` (id in `vercel-proxy/.vercel/project.json`) exists only to terminate TLS for customers' custom domains and forward to the publisher Worker. The `custom-domain` function hardcodes the project id and calls the Vercel API with `VERCEL_TOKEN_KEY`. Note: Cloudflare for SaaS (custom hostnames) could remove this hop — evaluate in Step 3.

## Database
See `supabase/schema.sql` (generated by `scripts/export-schema.py`, refresh any time) and `docs/SCHEMA.md`.
