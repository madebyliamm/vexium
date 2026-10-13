# Infrastructure map (verified 2026-10-12 unless marked UNVERIFIED)

No secrets here — names only.

## Request paths
```
Vertly app (static pages)  →  GitHub Pages (repo madebyliamm/vexium, workflow .github/workflows/static.yml, deploys on push to main)
Published site  *.vexium.ai/<slug>  →  Cloudflare Worker `vexium-publisher` (worker.js) → reads project row from Supabase REST on every request (no cache) → inlines CSS/JS/images → HTML
Published site on a custom domain  →  DNS CNAME cname.vercel-dns.com → Vercel project `vexium` (vercel-proxy/api/proxy.js, edge fn) → forwards to vexium-publisher.startafter.workers.dev with x-forwarded-host → same Worker
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
- `vexium-publisher` — `wrangler.toml` at repo root, `main = worker.js`, URL `vexium-publisher.startafter.workers.dev`. Deploy: `npx wrangler deploy` (root). Serves published sites (see above).
- `vexium-ai-build` — `cf-worker/wrangler.toml`, `main = worker.ts`, URL `vexium-ai-build.startafter.workers.dev`. Deploy: `npx wrangler deploy --config cf-worker/wrangler.toml`. `cf-worker/core.ts` is byte-extracted from `ai-chat/index.ts`; re-extract if the stream parser changes. Revert builds to Supabase by setting `AI_BUILD_URL = AI_EDGE_URL` in `editor.html`.

## Vercel
Project `vexium` (id in `vercel-proxy/.vercel/project.json`) exists only to terminate TLS for customers' custom domains and forward to the publisher Worker. The `custom-domain` function hardcodes the project id and calls the Vercel API with `VERCEL_TOKEN_KEY`. Note: Cloudflare for SaaS (custom hostnames) could remove this hop — evaluate in Step 3.

## Database
See `supabase/schema.sql` (generated by `scripts/export-schema.py`, refresh any time) and `docs/SCHEMA.md`.
